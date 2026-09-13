'use strict';

/**
 * Trae CN（字节跳动 TRAE 国内版）渠道实现。
 *
 * 走 SOLO 免费通道（默认 function=solo_work_lite），协议细节见同目录各模块。
 * 模型列表为「批量场景表 + 定价表」并集，chat 时按模型所属场景动态映射 function。
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
 * 模型 -> chat function 映射（listModels 刷新时填充）。
 * 上游按 function 场景校验 config_name：模型不在当前 function 场景的表里会报
 * 4001 param invalid，因此 chat 时需带上该模型所属的场景。
 * 映射缺失（如进程刚启动、动态列表未拉取）时回退默认免费通道 solo_work_lite。
 */
const chatFunctions = new Map();

// 启动即用静态已知映射预热（动态拉取完成后以实测为准覆盖）
for (const m of staticModels()) {
  const override = require('./models').MODEL_OVERRIDES[m.id];
  if (override && override.chatFunction) chatFunctions.set(m.id, override.chatFunction);
}

/**
 * 请求体改写：转成 SOLO 格式。
 * 注意**不做**竞品词净化 —— Trae 的拦截体系与 CodeBuddy 不同，套用反而可能改坏用户内容。
 */
function preparePayload(payload) {
  const out = client.buildChatBody(payload);
  const fn = chatFunctions.get(out.config_name);
  if (fn) out.function = fn;
  return out;
}

/**
 * 统一构造「上游所需」的账号视图。
 * 调用方可能传账号对象（{account, auth}），也可能直接传 auth。
 * 上游各接口既需要 accessToken（Authorization / X-Cloudide-Token），
 * 也需要 uid（X-Uid 头），因此统一扁平化成 client 层期望的形状。
 *
 * deviceId / machineId 缺失时补生成并回填到池：官方客户端签到/额度接口
 * 用 guaranteedDeviceId 保证 x-device-id 必发（缺失以 9004 拒绝 claim），
 * 对话接口同样携带。存量账号（早期登录/导入）可能没有这两个字段。
 */
function toUpstreamAccount(acct) {
  if (!acct) return { account: {} };
  const base = acct.auth
    ? Object.assign({}, acct.auth, { account: acct.account || {} })
    : Object.assign({ account: {} }, acct);
  if (!base.deviceId) base.deviceId = login.randNumericId();
  if (!base.machineId) base.machineId = login.randMachineId();
  if (acct.auth && acct.id && (base.deviceId !== acct.auth.deviceId || base.machineId !== acct.auth.machineId)) {
    const patch = { auth: Object.assign({}, acct.auth, { deviceId: base.deviceId, machineId: base.machineId }) };
    try { require('../../session').updateAccount(acct.id, patch); } catch (e) { /* 回填失败不影响本次请求 */ }
  }
  return base;
}

/** 聊天请求头（含设备指纹；Accept 必须为 text/event-stream） */
function buildChatHeaders(acct) {
  return SOLOHeaders(toUpstreamAccount(acct), { stream: true });
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

/** 动态模型列表；失败时抛出，由调用方回退到 staticModels()。同时刷新模型->function 映射 */
async function listModels(acct) {
  const list = await client.listModels(toUpstreamAccount(acct));
  chatFunctions.clear();
  for (const m of list) {
    if (m && m.id && m.chatFunction) chatFunctions.set(m.id, m.chatFunction);
  }
  return list;
}

/** 查询模型的 chat function（未知模型回退默认免费通道） */
function chatFunctionFor(model) {
  return chatFunctions.get(String(model || '').trim()) || C.Function;
}

function classifyError(status, body) {
  return client.classifyError(status, body);
}

function checkin(accountId, acct) {
  return client.checkin(toUpstreamAccount(acct));
}

function checkinStatus(accountId, acct) {
  return client.checkinStatus(toUpstreamAccount(acct));
}

function credits(accountId, acct) {
  return client.credits(toUpstreamAccount(acct));
}

function creditDetail(accountId, acct) {
  return client.creditDetail(toUpstreamAccount(acct));
}

module.exports = {
  kind: KIND,
  label: 'Trae CN',
  description: '字节跳动 TRAE 国内版（SOLO 免费通道）',
  login,
  staticModels, listModels,
  preparePayload, chatFunctionFor, buildChatHeaders, chatUrl, refreshToken,
  aggregate, createSseConverter, classifyError,
  checkin, checkinStatus, credits, creditDetail,
  constants: C,
};
