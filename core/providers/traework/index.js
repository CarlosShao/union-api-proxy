'use strict';

/**
 * Trae CN（字节跳动 TRAE 国内版）渠道实现。
 *
 * 走 SOLO 免费通道（function=solo_work_lite），协议细节见同目录各模块。
 * 与 CodeBuddy 的关键差异：
 *  - 上游是自定义 `event:` 事件流，需经 sse.js 转成 OpenAI SSE（不能透传）
 *  - 鉴权头是 Cloud-IDE-JWT + 一整套设备指纹头
 *  - 无 11128 竞品词拦截（那是腾讯的机制），故不做品牌词净化
 */

const C = require('./constants');
const client = require('./client');
const login = require('./login');
const { staticModels } = require('./models');
const sse = require('./sse');
const { SOLOHeaders } = require('./headers');

const KIND = 'traework';

/**
 * 请求体改写：转成 SOLO 格式。
 * 注意**不做**竞品词净化 —— Trae 的拦截体系与 CodeBuddy 不同，套用反而可能改坏用户内容。
 */
function preparePayload(payload) {
  return client.buildChatBody(payload);
}

/** 聊天请求头（含设备指纹；Accept 必须为 text/event-stream） */
function buildChatHeaders(acct) {
  return SOLOHeaders(acct && acct.auth ? acct.auth : {}, { stream: true });
}

function chatUrl() {
  return client.chatUrl();
}

/** 刷新 token：返回新 auth（含轮转后的 refreshToken），由调用方持久化 */
async function refreshToken(acct) {
  const next = await client.refreshToken(acct);
  return next;
}

/** 非流式：聚合成 chat.completion */
function aggregate(sseText) {
  return sse.aggregate(sseText);
}

/** 流式：SOLO 事件流 -> OpenAI SSE 转换器 */
function createSseConverter() {
  return sse.createSseConverter();
}

/**
 * 动态模型列表；失败时抛出，由调用方回退到 staticModels()。
 * 签名对齐 Provider 接口：传入账号对象（含 auth）。
 */
async function listModels(acct) {
  const auth = acct && acct.auth ? acct.auth : acct;
  return client.listModels({ auth, account: (acct && acct.account) || {} });
}

function classifyError(status, body) {
  return client.classifyError(status, body);
}

function checkin(accountId, acct) {
  return client.checkin(acct);
}

function checkinStatus(accountId, acct) {
  return client.checkinStatus(acct);
}

function credits(accountId, acct) {
  return client.credits(acct);
}

function creditDetail(accountId, acct) {
  return client.creditDetail(acct);
}

module.exports = {
  kind: KIND,
  label: 'Trae CN',
  description: '字节跳动 TRAE 国内版（SOLO 免费通道）',
  login,
  staticModels, listModels,
  preparePayload, buildChatHeaders, chatUrl, refreshToken,
  aggregate, createSseConverter, classifyError,
  checkin, checkinStatus, credits, creditDetail,
  constants: C,
};
