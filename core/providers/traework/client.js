'use strict';

/**
 * Trae CN 上游 HTTP 客户端：token 刷新、聊天、模型列表、签到、额度。
 *
 * 复用 util 的 keep-alive agent（避免每轮工具调用重新握手，是消除思考碎片延迟的一环）。
 * 账号凭证由调用方传入，本模块**不读写数据库**。
 */

const util = require('../../util');
const logger = require('../../logger');
const C = require('./constants');
const { SOLOHeaders, UgHeaders, OAuthHeaders } = require('./headers');
const { preparePayload } = require('./payload');

const TIMEOUT_MS = 120000;

/** TokenExpireAt 可能是毫秒（>1e12）或秒，统一归一为毫秒时间戳 */
function normalizeExpiresAt(v) {
  const n = Number(v) || 0;
  if (!n) return 0;
  return n > 1e12 ? n : n * 1000;
}

/**
 * 用 refreshToken 换新的 accessToken（ExchangeToken）。
 * refreshToken 会轮转，需由调用方持久化新值。
 */
async function refreshToken(acct) {
  const rt = acct && acct.auth && acct.auth.refreshToken;
  if (!rt) throw new Error('无 refreshToken，需要重新登录');
  const host = (acct.auth.apiHost || C.OAuthHost).replace(/\/+$/, '');
  const body = { ClientID: C.ClientID, RefreshToken: rt, ClientSecret: '-', UserID: '' };
  const r = await util.requestJson(host + C.EpExchange, {
    method: 'POST', headers: OAuthHeaders(), body, timeoutMs: 30000,
  });
  const result = r.json && (r.json.Result || r.json.result || r.json.data);
  const token = result && (result.Token || result.token || result.AccessToken || result.accessToken);
  if (!token) {
    const msg = r.json ? (r.json.Message || r.json.message || r.json.code) : r.body;
    throw new Error('刷新 token 失败: ' + msg);
  }
  const next = Object.assign({}, acct.auth, {
    accessToken: token,
    lastRefreshTime: Date.now(),
    domain: acct.auth.domain || 'trae.cn',
    apiHost: host,
  });
  const newRt = result.RefreshToken || result.refreshToken;
  if (newRt) next.refreshToken = newRt;
  const expAt = result.TokenExpireAt || result.tokenExpireAt || result.ExpiresAt || result.expiresAt;
  if (expAt) next.expiresAt = normalizeExpiresAt(expAt);
  else if (result.TokenExpireDuration || result.expiresIn || result.expiresInSeconds) {
    const d = Number(result.TokenExpireDuration || result.expiresIn || result.expiresInSeconds);
    next.expiresAt = Date.now() + (d > 1e9 ? d : d * 1000);
  }
  logger.log('info', 'auth', `[Trae] accessToken 已刷新: ${acct.name || (acct.account && acct.account.uid) || acct.id}`);
  return next;
}

/** 取用户信息（登录后补齐 uid/nickname） */
async function getUserInfo(acct) {
  const host = ((acct.auth && acct.auth.apiHost) || C.OAuthHost).replace(/\/+$/, '');
  const r = await util.requestJson(host + C.EpUserInfo, {
    method: 'POST',
    headers: Object.assign(OAuthHeaders(), { 'X-Cloudide-Token': (acct.auth && acct.auth.accessToken) || '' }),
    body: { ReqSource: 'IDE', IDEVersion: C.IdeVersion },
    timeoutMs: 30000,
  });
  const res = r.json && (r.json.Result || r.json.result || r.json.data);
  if (!res) throw new Error('获取用户信息失败: ' + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.body));
  return {
    uid: res.UserID || res.userId || res.uid || '',
    nickname: res.ScreenName || res.screenName || res.nickname || '',
    enterpriseId: res.EnterpriseID || res.enterpriseId || '',
  };
}

/** 聊天：返回上游原始响应（SSE 事件流，由调用方转换） */
function chatUrl() {
  return C.AgentHost + C.EpChat;
}

/** 构造聊天请求体（OpenAI -> SOLO） */
function buildChatBody(payload) {
  return preparePayload(payload);
}

/** 拉取模型列表（get_detail_param），按 config_name 去重并过滤自定义模型 */
async function listModels(acct) {
  const body = {
    function: C.Function, config_names: null, need_prompt: false,
    current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null,
  };
  const r = await util.requestJson(C.AgentHost + C.EpModels, {
    method: 'POST', headers: SOLOHeaders(acct, { stream: false }), body, timeoutMs: 30000,
  });
  const list = r.json && (r.json.config_info_list || (r.json.data && r.json.data.config_info_list));
  if (!Array.isArray(list)) {
    throw new Error('模型列表解析失败: ' + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.body));
  }
  const seen = new Set();
  const out = [];
  for (const cfg of list) {
    const name = String(cfg.config_name || '').trim();
    if (!name || seen.has(name)) continue;
    const disp = cfg.display_config || {};
    if (disp.is_custom_model || name.startsWith('custom_model_')) continue; // 第三方代理模型需额外授权
    seen.add(name);
    out.push({ id: name, name: disp.display_name || name });
  }
  return out;
}

/** 签到状态：{ checkedIn, credits, enable } */
async function checkinStatus(acct) {
  const r = await util.requestJson(C.UgHost + C.EpCheckinStatus, {
    method: 'POST', headers: UgHeaders(acct), body: {}, timeoutMs: 30000,
  });
  const d = r.json;
  if (!d) throw new Error('签到状态查询失败: ' + r.body);
  if (d.code && d.code !== 0) throw new Error(`签到状态 code=${d.code} ${d.message || d.msg || ''}`);
  if (d.success === false) throw new Error('签到状态失败: ' + (d.message || d.msg || ''));
  return { checkedIn: !!d.checked_in, credits: Number(d.credits) || 0, enable: d.enable !== false };
}

/**
 * 领取签到积分。上游对同设备高频调用会返回 9074（限流），
 * 等待 CheckinRetryDelay 后重试一次。
 */
async function checkinClaim(acct, { retryDelayMs = 8000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await util.requestJson(C.UgHost + C.EpCheckinClaim, {
      method: 'POST', headers: UgHeaders(acct), body: {}, timeoutMs: 30000,
    });
    const d = r.json;
    if (!d) throw new Error('签到失败: ' + r.body);
    const code = Number(d.code) || 0;
    if (code === 9074 && attempt === 0) {
      logger.log('warn', 'auth', `[Trae] 签到被限流 (9074)，${retryDelayMs}ms 后重试`);
      await new Promise((res) => setTimeout(res, retryDelayMs));
      continue;
    }
    if (code !== 0) throw new Error(`签到 code=${code} ${d.message || d.msg || ''}`);
    if (d.success === false) throw new Error('签到失败: ' + (d.message || d.msg || ''));
    return true;
  }
  throw new Error('签到被限流 (9074)，请稍后再试');
}

/** 完整签到流程：查状态 -> 领取 -> 复核 */
async function checkin(acct) {
  const before = await checkinStatus(acct);
  if (before.checkedIn) return { ok: true, already: true, credits: before.credits };
  if (!before.enable) throw new Error('该账号未开放签到活动');
  await checkinClaim(acct);
  const after = await checkinStatus(acct);
  if (!after.checkedIn) throw new Error('签到后复核未通过（checked_in=false）');
  return { ok: true, already: false, credits: after.credits };
}

/** 额度：剩余积分 = Σ(credits_limit - credits_amount) */
async function credits(acct) {
  const detail = await creditDetail(acct);
  let left = 0; let used = 0; let total = 0;
  for (const it of detail) { left += it.remain; used += it.used; total += it.total; }
  return { used, left, total };
}

/** 额度明细（按套餐条目） */
async function creditDetail(acct) {
  const r = await util.requestJson(C.UgHost + C.EpEntUsage, {
    method: 'POST', headers: UgHeaders(acct), body: { require_usage: true }, timeoutMs: 30000,
  });
  const d = r.json;
  if (!d) throw new Error('额度查询失败: ' + r.body);
  const packs = d.user_entitlement_pack_list || (d.data && d.data.user_entitlement_pack_list);
  if (!Array.isArray(packs)) throw new Error('额度响应格式异常: ' + JSON.stringify(d).slice(0, 200));
  return packs.map((p) => {
    const base = p.entitlement_base_info || {};
    const quota = base.quota || {};
    const limit = Number(quota.credits_limit) || 0;
    const amount = Number((p.usage && p.usage.credits_amount) || 0) || 0;
    const remain = Math.max(limit - amount, 0);
    const name = p.group_name || p.display_desc || base.package_name || base.package_type || '套餐';
    return { name, total: limit, used: amount, remain };
  });
}

/**
 * 错误分类：驱动账号冷却 / 禁用。
 * 1005 = 权益/额度不足；401/403 = 登录态失效；429 = 软限流。
 */
function classifyError(status, body) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  if (text.includes('"code":1005') || (text.includes('1005') && lower.includes('plan'))) {
    return { kind: 'credit', fatal: false };
  }
  if (status === 401 || status === 403) return { kind: 'session', fatal: true };
  if (status === 429) return { kind: 'rate', fatal: false };
  if (status === 404) return { kind: 'notfound', fatal: false };
  if (status >= 500) return { kind: 'server', fatal: false };
  if (status >= 400) return { kind: 'client', fatal: false };
  return { kind: 'none', fatal: false };
}

module.exports = {
  TIMEOUT_MS,
  refreshToken, getUserInfo,
  chatUrl, buildChatBody, listModels,
  checkinStatus, checkinClaim, checkin, credits, creditDetail,
  classifyError, normalizeExpiresAt,
};
