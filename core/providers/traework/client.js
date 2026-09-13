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

/** 从模型条目提取统一元数据（供 batch 场景表解析用） */
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

/** context_window_tokens 取所有 key 的最大值（dev/max 等计费通道，Max 模式可达 1M） */
function maxContextWindow(cwt) {
  if (!cwt || typeof cwt !== 'object') return 0;
  let max = 0;
  for (const k of Object.keys(cwt)) max = Math.max(max, num(cwt[k]));
  return max;
}

/** 模型是否为第三方自定义代理模型（需额外授权，不对外展示） */
function isCustomModel(name, disp) {
  return !!(disp.is_custom_model || String(name).startsWith('custom_model_'));
}

/**
 * 拉取模型列表（客户端模型选择器的同款双数据源）：
 *   1. /api/remote/v1/models  —— 模型定价表，即 SOLO 选择器的权威列表
 *     （新模型会先出现在这里，如 glm-5.3-flash；不含内部工具模型，天然干净）
 *   2. batch_get_detail_param —— 各 function 场景的对话配置表，仅用作元数据增强
 *     （context_window_tokens / max_tokens / multimodal / 场景归属）
 * 每个模型记录首选 chat function（lite 免费通道优先），供 preparePayload 映射。
 * 定价表失败时回退为「批量表按对话场景过滤」；两者都失败才抛出（由调用方回退静态表）。
 */
async function listModels(acct) {
  const [pricingR, batchR] = await Promise.allSettled([
    fetchPricingModels(acct),
    fetchBatchModels(acct),
  ]);
  if (pricingR.status === 'rejected' && batchR.status === 'rejected') {
    throw pricingR.reason instanceof Error ? pricingR.reason : new Error(String(pricingR.reason));
  }
  if (pricingR.status === 'fulfilled') {
    const meta = batchR.status === 'fulfilled'
      ? new Map(batchR.value.map((m) => [m.id, m]))
      : new Map();
    // 定价表为主，批量表补充上下文/输出等元数据与场景归属
    for (const m of pricingR.value) {
      const b = meta.get(m.id);
      if (!b) continue;
      if (b.maxInputTokens > m.maxInputTokens) m.maxInputTokens = b.maxInputTokens;
      if (b.maxOutputTokens > m.maxOutputTokens) m.maxOutputTokens = b.maxOutputTokens;
      if (b.vision) m.vision = true;
      if (b.isDefault) m.isDefault = true;
      // 场景归属仅在批量表给出「可对话」场景时才采信（批量表含大量非对话场景）
      if (b.chatable && b.chatFunction) m.chatFunction = b.chatFunction;
    }
    return applyOverrides(pricingR.value);
  }
  // 定价表不可用：用批量表按「可对话场景 + 有显示名」过滤出可用列表
  return applyOverrides(batchR.value.filter((m) => m.display_name && m.chatable));
}

/** 应用已知元数据修正（仅填充缺失值，不覆盖上游实测数据） */
function applyOverrides(list) {
  const overrides = require('./models').MODEL_OVERRIDES || {};
  for (const m of list) {
    const o = overrides[m.id];
    if (!o) continue;
    if (!m.maxInputTokens && o.maxInputTokens) m.maxInputTokens = o.maxInputTokens;
    if (!m.maxOutputTokens && o.maxOutputTokens) m.maxOutputTokens = o.maxOutputTokens;
    if (o.vision) m.vision = true;
    if (o.reasoning) m.reasoning = true;
  }
  return list;
}

/** 批量场景表：batch_get_detail_param，按 config_name 合并各场景（仅作元数据源） */
async function fetchBatchModels(acct) {
  const body = {
    functions: C.ModelFunctions,
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
  };
  const r = await util.requestJson(C.AgentHost + C.EpModelsBatch, {
    method: 'POST', headers: SOLOHeaders(acct, { stream: false }), body, timeoutMs: 30000,
  });
  const scenes = r.json && (r.json.function_configs || (r.json.data && r.json.data.function_configs));
  if (!Array.isArray(scenes)) {
    throw new Error('批量模型列表解析失败: ' + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.body));
  }
  // name -> { meta, disp, display_name, scenes: Set }；跨场景合并取各项最大值
  const merged = new Map();
  const sceneRank = new Map(C.ModelFunctions.map((fn, i) => [fn, i]));
  for (const scene of scenes) {
    const fn = String(scene.function || '');
    const list = scene.config_info_list;
    if (!fn || !Array.isArray(list)) continue;
    for (const cfg of list) {
      const name = String(cfg.config_name || '').trim();
      const disp = cfg.display_config || {};
      if (!name || isCustomModel(name, disp)) continue;
      const details = Array.isArray(cfg.model_detail_list) ? cfg.model_detail_list : [];
      let out = 0;
      for (const d of details) out = Math.max(out, num(d && d.max_tokens));
      let item = merged.get(name);
      if (!item) {
        merged.set(name, {
          meta: cfg, disp,
          name,
          display_name: String(disp.display_name || '').trim(),
          ctx: maxContextWindow(cfg.context_window_tokens),
          out,
          scenes: new Set([fn]),
        });
        continue;
      }
      // 同一模型在多个场景各有一份配置：上下文/输出取最大，能力取并集
      item.ctx = Math.max(item.ctx, maxContextWindow(cfg.context_window_tokens));
      item.out = Math.max(item.out, out);
      if (!item.display_name && disp.display_name) {
        item.display_name = String(disp.display_name).trim();
        item.disp = disp;
        item.meta = cfg;
      }
      item.scenes.add(fn);
    }
  }
  const prio = C.ChatFunctionPriority;
  const chatableFns = C.PricingFunctions.split(',');
  const pickFn = (scenesSet) => {
    for (const fn of prio) if (scenesSet.has(fn)) return fn;
    // 不在优先列表的场景，取场景表中序最小者（仍是对话可用场景）
    return [...scenesSet].sort((a, b) => (sceneRank.get(a) ?? 99) - (sceneRank.get(b) ?? 99))[0] || '';
  };
  return [...merged.values()].map((item) => {
    const { meta, disp, name, display_name, scenes, ctx, out } = item;
    const chatFn = pickFn(scenes);
    return {
      id: name,
      name: display_name || name,
      display_name,                                        // 空名 = 内部工具模型（客户端选择器不展示）
      maxInputTokens: ctx,
      maxOutputTokens: out,
      tools: true,                      // SOLO 通道的模型均支持 function call
      vision: !!disp.multimodal,
      reasoning: String(disp.model_capability || '').includes('reasoning'),
      isDefault: !!meta.is_default,
      chatFunction: chatFn,
      // 场景是否落在可对话范围内（fallback 列表与元数据覆写用；llm_utils_chat 按场景校验）
      chatable: !!chatFn && chatableFns.includes(chatFn),
    };
  });
}

/** 定价表：/api/remote/v1/models（Web 端接口，仅 JWT + Web 头，无需设备指纹） */
async function fetchPricingModels(acct) {
  const at = (acct && acct.accessToken) || '';
  const url = C.WorkHost + C.EpModelsPricing
    + '?functions=' + encodeURIComponent(C.PricingFunctions) + '&show_custom_model=false';
  const r = await util.requestJson(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Referer': C.WorkHost + '/',
      'Authorization': 'Cloud-IDE-JWT ' + at,
      'X-Trae-Client-Type': 'web',
      'X-Trae-User-Timezone': 'Asia/Shanghai',
      'X-Preferenced-Language': 'zh-cn',
    },
    timeoutMs: 30000,
  });
  const d = r.json && (r.json.data || r.json);
  const list = d && d.list;
  if (!Array.isArray(list)) {
    throw new Error('模型定价表解析失败: ' + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.body));
  }
  const prio = C.ChatFunctionPriority;
  const merged = new Map(); // name -> { item, fnRank }
  for (const group of list) {
    const fn = String(group.function || '');
    if (!fn || !Array.isArray(group.models)) continue;
    const rank = prio.includes(fn) ? prio.indexOf(fn) : 99;
    for (const m of group.models) {
      const name = String(m.name || '').trim();
      if (!name || isCustomModel(name, {})) continue;
      let feat = {};
      try { feat = typeof m.features === 'string' ? JSON.parse(m.features) : (m.features || {}); } catch { /* 忽略 */ }
      const prev = merged.get(name);
      if (prev && prev.fnRank <= rank) continue;
      merged.set(name, {
        fnRank: rank,
        item: {
          id: name,
          name: m.display_name || name,
          maxInputTokens: 0, // 定价表无上下文元数据，留 0（/v1/models 不输出）
          maxOutputTokens: 0,
          tools: true,
          vision: !!(feat.multimodal && feat.multimodal.enable),
          reasoning: !!(feat.reasoning && feat.reasoning.enable),
          isDefault: false,
          chatFunction: fn,
        },
      });
    }
  }
  return [...merged.values()].map((v) => v.item);
}

/** 签到状态：{ checkedIn, credits, enable } */
async function checkinStatus(acct) {
  const r = await util.requestJson(C.UgHost + C.EpCheckinStatus, {
    method: 'POST', headers: UgHeaders(acct), body: { req_source: C.CheckinReqSource }, timeoutMs: 30000,
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
      method: 'POST', headers: UgHeaders(acct), body: { req_source: C.CheckinReqSource }, timeoutMs: 30000,
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
