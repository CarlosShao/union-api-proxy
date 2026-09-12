'use strict';

/**
 * CodeBuddy（腾讯云代码助手）渠道实现。
 *
 * 本文件是**薄包装**：不重写任何协议逻辑，只把既有的 auth.js / openai.js / models.js
 * 能力适配到 Provider 接口上。这样迁移到多渠道架构后，CodeBuddy 的行为与改造前
 * 逐字节一致（同一份函数、同一条代码路径），把回归风险降到最低。
 */

const config = require('../../config');
const util = require('../../util');
const auth = require('../../auth');
const sanitize = require('../../sanitize');
const models = require('../../models');

const KIND = 'codebuddy';

/** 旧版单渠道时的「无前缀」模型即归属本渠道；staticModels 提供目录兜底 */
function staticModels() {
  return models.MODEL_CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    maxInputTokens: m.maxInputTokens || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    tools: !!m.tools,
    vision: !!m.vision,
    reasoning: !!m.reasoning,
  }));
}

/** 列表接口由本地目录（+ 管理页自定义模型）提供，无需请求上游 */
async function listModels() {
  return staticModels();
}

/**
 * 净化请求体：把竞品品牌词/指纹句改写掉，绕过上游 11128 拦截。
 * 这是 CodeBuddy 独有的适配，**不要**套用到其它渠道。
 */
function preparePayload(payload) {
  sanitize.sanitizeChatPayload(payload);
  return payload;
}

/** 聊天请求头：含 CLI 身份模拟（上游据此在控制台识别为 CLI 而非「无客户端」） */
function buildChatHeaders(acct) {
  return auth.buildChatRequestHeaders(acct);
}

/** 上游聊天地址（引用 ENDPOINT 而非硬编码，保持可配置） */
function chatUrl() {
  return config.ENDPOINT + '/v2/chat/completions';
}

/** 刷新 accessToken：调用上游 refresh 端点，返回新的 auth 对象（轮转的 refreshToken 一并带回） */
async function refreshToken(acct) {
  if (!acct || !acct.auth || !acct.auth.refreshToken) throw new Error('无 refreshToken，需要重新登录');
  const headers = {
    'X-Refresh-Token': acct.auth.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': acct.auth.domain || config.ENDPOINT_HOST,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
  const r = await util.requestJson(auth.authPath('/auth/token/refresh'), {
    method: 'POST', headers, body: {}, timeoutMs: 30000,
  });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.accessToken) {
    throw new Error('刷新 token 失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  const oldAuth = acct.auth;
  data.lastRefreshTime = Date.now();
  if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
  if (!data.refreshToken) data.refreshToken = oldAuth.refreshToken;
  if (!data.domain) data.domain = oldAuth.domain;
  return data;
}

/**
 * 非流式：上游强制 SSE，需在本地聚合成 chat.completion。
 * 懒加载 openai 模块：它同时 require 本文件（经 providers/all），
 * 顶层 require 会形成循环依赖并在 openai 重写 module.exports 后拿到过期引用。
 */
function aggregate(sseText) {
  return require('../../openai').aggregateSseToCompletion(sseText);
}

/**
 * 上游已是 OpenAI SSE 格式，无需转换 —— 返回 null 表示走 util.pipeSseToClient
 * 的默认路径（其中含 normalizeSseBlock 空字段剥离，防止 AI SDK 把思考拆成碎片）。
 */
function createSseConverter() {
  return null;
}

/** 错误分类：映射到统一语义，供账号冷却/轮换使用 */
function classifyError(status, body) {
  const text = String(body || '');
  if (status === 200) return { kind: 'none', fatal: false };
  if (status === 401 || status === 403) return { kind: 'session', fatal: true };
  if (status === 429) return { kind: 'rate', fatal: false };
  // 11128 = 竞品词拦截；11101 = 参数错误；此类多为请求问题，冷却账号无意义
  if (text.includes('11128')) return { kind: 'content_filter', fatal: false };
  if (status === 404) return { kind: 'notfound', fatal: false };
  if (status >= 500) return { kind: 'server', fatal: false };
  if (status >= 400) return { kind: 'client', fatal: false };
  return { kind: 'none', fatal: false };
}

/** 签到：复用既有实现（按 accountId 解析账号，故此处懒加载以避免循环依赖） */
function checkin(accountId) {
  return require('../../checkin').dailyCheckin(accountId);
}

function checkinStatus(accountId) {
  return require('../../checkin').checkinStatus(accountId);
}

function credits(accountId) {
  return require('../../credits').getCredits(accountId);
}

module.exports = {
  kind: KIND,
  label: 'CodeBuddy',
  description: '腾讯云 CodeBuddy（原登录态代理）',
  staticModels, listModels,
  preparePayload, buildChatHeaders, chatUrl, refreshToken,
  aggregate, createSseConverter, classifyError,
  checkin, checkinStatus, credits,
};
