'use strict';

/** 认证逻辑：请求头构建、账号级 token 刷新、OAuth 登录流程（多账号池） */

const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const util = require('./util');
const store = require('./store');
const sessionMod = require('./session');
const adminAuth = require('./adminAuth');

const pendingLogins = new Map();

function buildNoAuthHeaders() {
  return {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'X-Domain': config.ENDPOINT_HOST,
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
}

function authPath(sub) { return config.ENDPOINT + '/v2' + config.PREFIX_PATH + sub; }

function isExpiring(auth) { return sessionMod.isExpiringAuth(auth); }

/**
 * 同一账号的刷新去抖：并发请求同时发现 token 过期时，只让第一个真正发刷新请求，
 * 其余复用同一次结果。
 *
 * 必要性：Trae 的 refreshToken 每次刷新都会轮转（旧的立即失效），若两个请求
 * 并发刷新，后一个用已被替换的 refreshToken 去换会失败，甚至让账号掉线。
 */
const refreshing = new Map();

/** 刷新指定账号的 token，并写回池（按账号所属渠道分发） */
async function refreshToken(acct) {
  if (!acct) throw new Error('账号不存在');
  const provider = require('./providers/all').getProvider(acct.provider || 'codebuddy');
  if (!provider || typeof provider.refreshToken !== 'function') throw new Error('该渠道不支持刷新 token');
  const key = acct.id || (acct.account && acct.account.uid) || 'unknown';
  if (refreshing.has(key)) return refreshing.get(key);
  const task = (async () => {
    const next = await provider.refreshToken(acct);
    if (!next || !next.accessToken) throw new Error('刷新 token 失败：上游未返回 accessToken');
    acct.auth = next;
    sessionMod.updateAccount(acct.id, { auth: next });
    return acct.auth;
  })().finally(() => { refreshing.delete(key); });
  refreshing.set(key, task);
  return task;
}

/** 校验并（必要时）刷新某个账号，返回该账号对象 */
async function getValidAccount(acct) {
  if (!acct) throw new Error('未登录，请先打开管理页登录');
  if (!acct.auth || !acct.auth.accessToken) throw new Error('账号「' + (acct.name || acct.account.uid) + '」无有效 token');
  if (isExpiring(acct.auth)) {
    try { await refreshToken(acct); }
    catch (e) { logger.log('warn', 'auth', '自动刷新失败（继续用旧 token 尝试）: ' + e.message); }
  }
  return acct;
}

/** 兼容旧接口：返回「活跃账号」并校验 */
async function getValidSession() {
  if (!sessionMod.isLoggedIn()) throw new Error('未登录，请先打开管理页登录');
  const acct = sessionMod.getActiveAccount();
  return getValidAccount(acct);
}

/**
 * 根据请求选择账号并校验。
 * 优先级：header/body 显式指定 > 关闭池模式（pinned 强制账号）> 密钥绑定账号 > 账号池。
 * provider：目标渠道，仅在该渠道的账号中挑选（默认 codebuddy，保持旧行为）。
 * @param {string} [explicitKey] 来自 header/body 的显式账号指定
 * @param {string} [keyAccountId] API 密钥绑定的账号 id（空 = 未绑定）
 * @param {string} [provider] 渠道标识
 */
async function pickAccountForRequest(explicitKey, keyAccountId, provider, sessionKey) {
  const kind = provider || 'codebuddy';
  const pool = sessionMod.getPoolConfig(kind);
  // 候选账号必须属于目标渠道，避免拿 A 渠道账号去请求 B 渠道
  const inKind = (a) => !!a && (a.provider || 'codebuddy') === kind;
  let acct = null;
  if (explicitKey) {
    const found = sessionMod.findAccountByIdOrName(explicitKey);
    acct = inKind(found) ? found : null;
  } else if (pool.mode === 'pinned' && pool.pinnedId) {
    const pinned = sessionMod.getAccount(pool.pinnedId);
    acct = inKind(pinned) ? pinned : null;
  } else if (keyAccountId) {
    const bound = sessionMod.findAccountByIdOrName(keyAccountId);
    acct = inKind(bound) ? bound : null;
  } else if (sessionKey) {
    // 池模式 + 有会话键 -> 走粘性：同一段对话固定落在同一账号，保住 prompt cache
    acct = sessionMod.pickAccountForSession(sessionKey, kind);
  } else {
    acct = sessionMod.pickAccount(null, kind);
  }
  if (!acct) {
    const label = require('./providers/all').labelOf(kind);
    throw new Error(`渠道「${label}」没有可用账号，请先在管理页登录`);
  }
  const valid = await getValidAccount(acct);
  sessionMod.markUsed(valid.id);
  return valid;
}

/**
 * 上游失败 -> 标记账号冷却。
 *
 * 冷却时长由**渠道自己的 classifyError** 决定，而不是一段与渠道无关的正则 ——
 * 本项目是三渠道聚合，各家的错误码/错误体形状完全不同（Trae 用 code 1005 表示
 * 额度不足，CodeBuddy 又是另一套）。用统一正则会对不上号：该冷却 30 分钟的额度
 * 问题会只冷却 1 分钟。
 *
 * @param {string} accountId
 * @param {number} status 上游 HTTP 状态码
 * @param {string} body 上游错误体（截断到 4KB 即可）
 * @param {object} [provider] 渠道实现；缺省按状态码粗判
 * @returns {boolean} 是否已置入冷却
 */
function recordUpstreamFailure(accountId, status, body, provider) {
  if (!accountId) return false;
  let kind = 'none';
  try {
    if (provider && typeof provider.classifyError === 'function') {
      kind = (provider.classifyError(status, body) || {}).kind || 'none';
    } else if (status === 401 || status === 403) kind = 'session';
    else if (status === 429) kind = 'rate';
    else if (status >= 500) kind = 'server';
  } catch (e) { return false; }
  const ms = sessionMod.COOLDOWN_MS[kind];
  if (!ms) return false;
  return sessionMod.markUnhealthy(accountId, ms, kind + ':' + status);
}

/** 上游成功 -> 解除该账号的冷却 */
function recordUpstreamSuccess(accountId) {
  return sessionMod.markHealthy(accountId);
}

/** 从请求中提取账号指定值（header / body），并从 payload 中移除 */
function extractAccountKey(req, payload) {
  const h = req.headers || {};
  const key = h['x-codebuddy-account'] || h['x-account-id'] || h['x-account-name'];
  if (key) return String(key).trim() || null;
  if (payload && typeof payload === 'object') {
    const v = payload.accountId || payload.accountName || payload.account;
    if (v != null && v !== '') {
      delete payload.accountId;
      delete payload.accountName;
      delete payload.account;
      return String(v).trim();
    }
  }
  return null;
}

/**
 * 计算本次请求的会话键（用于账号粘性）。
 *
 * 客户端可用 `X-Session-Id` 显式声明；不声明则退回「系统提示词 + 首条用户
 * 消息」的指纹，做到零配置。渠道标识会混入哈希，保证 cc/ 与 tc/ 的会话互不串号。
 *
 * @param {object} req 原始请求
 * @param {object} payload 已解析的请求体
 * @param {string} provider 渠道
 * @param {string} [apiKeyId] API 密钥 id（优先级低于显式 Session-Id）
 * @returns {string|null} 会话键
 */
function extractSessionKey(req, payload, provider, apiKeyId) {
  const h = req.headers || {};
  const sid = h['x-session-id'] || h['x-conversation-id'];
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : null;
  return sessionMod.computeSessionKey(provider, {
    sessionId: sid ? String(sid).trim() : null,
    apiKeyId: apiKeyId || null,
    messages: messages,
  });
}

/** 客户端声明「这段对话结束了」——释放绑定，让下一段对话可以重新分配账号 */
function isSessionEnd(req, payload) {
  const h = req.headers || {};
  if (String(h['x-session-end'] || '') === '1') return true;
  if (payload && typeof payload === 'object') {
    if (payload.sessionEnd === true) return true;
    if (payload.metadata && payload.metadata.sessionEnd === true) return true;
  }
  return false;
}

/**
 * 官方 CLI（@tencent-ai/codebuddy-code）向 /v2/chat/completions 发送的身份头（实抓自 2.143.0）：
 * 服务端控制台按 X-Ide-Type / X-Ide-Name / User-Agent 识别客户端类型——
 * 缺失时显示为"无客户端"，携带时显示为 CLI。
 */
const CLI_VERSION = process.env.CODEBUDDY_CLI_VERSION || '2.143.0';

/** 每账号在闲置窗口内复用同一 conversationId，模拟 CLI"一次会话多条请求"的形态；闲置超时后轮换 */
const CLI_CONVERSATION_IDLE_MS = 30 * 60 * 1000;
const conversationIds = new Map(); // accountId -> { id, ts }

function hex32() { return crypto.randomBytes(16).toString('hex'); }

function currentConversationId(accountId) {
  const now = Date.now();
  const cur = conversationIds.get(accountId);
  if (cur && now - cur.ts < CLI_CONVERSATION_IDLE_MS) { cur.ts = now; return cur.id; }
  const id = crypto.randomUUID();
  conversationIds.set(accountId, { id, ts: now });
  if (conversationIds.size > 256) {
    for (const [k, v] of conversationIds) {
      if (now - v.ts >= CLI_CONVERSATION_IDLE_MS) conversationIds.delete(k);
    }
  }
  return id;
}

function buildAuthHeaders(acct) {
  const sess = acct || sessionMod.getActiveAccount();
  if (!sess) return {};
  const { account, auth } = sess;
  // 仅认证与用户标识，不含客户端身份（身份头见 buildChatRequestHeaders；
  // checkin/credits 会在此基础上覆盖为 WorkBuddy 身份）
  const h = {
    'Authorization': 'Bearer ' + auth.accessToken,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
  };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) { h['X-Enterprise-Id'] = account.enterpriseId; h['X-Tenant-Id'] = account.enterpriseId; }
  if (auth.domain) h['X-Domain'] = auth.domain;
  return h;
}

/** 对话类请求头：在认证头之上追加 CLI 身份与每次请求的 agent / 会话 / 链路追踪 ID */
function buildChatRequestHeaders(acct) {
  const h = buildAuthHeaders(acct);
  if (!Object.keys(h).length) return h;
  h['X-Ide-Type'] = 'CLI';
  h['X-Ide-Name'] = 'CLI';
  h['X-Ide-Version'] = CLI_VERSION;
  h['X-Product'] = 'SaaS';
  h['X-Private-Data'] = 'false';
  const conversationId = currentConversationId(acct ? acct.id : 'default');
  const requestId = hex32();  // CLI: x-request-id 与 x-conversation-message-id 同值
  const turnId = hex32();     // CLI: x-conversation-request-id / x-root-request-id / trace id 同值
  const spanId = hex32().slice(0, 16);
  const parentSpanId = hex32().slice(0, 16);
  h['X-Agent-Intent'] = 'craft';
  h['X-Agent-Purpose'] = 'conversation';
  h['X-Agent-Type'] = 'main';
  h['X-Codebuddy-Request'] = '1';
  h['X-Conversation-Id'] = conversationId;
  h['X-Request-Id'] = requestId;
  h['X-Conversation-Message-Id'] = requestId;
  h['X-Conversation-Request-Id'] = turnId;
  h['X-Root-Request-Id'] = turnId;
  h['X-Trace-Id'] = turnId;
  h['traceparent'] = `00-${turnId}-${spanId}-01`;
  h['b3'] = `${turnId}-${spanId}-1-${parentSpanId}`;
  h['X-B3-TraceId'] = turnId;
  h['X-B3-SpanId'] = spanId;
  h['X-B3-ParentSpanId'] = parentSpanId;
  h['X-B3-Sampled'] = '1';
  return h;
}

/* ============================ OAuth 登录流程 ============================ */

async function fetchAuthState() {
  const r = await util.requestJson(authPath('/auth/state') + '?platform=' + encodeURIComponent(config.PLATFORM), {
    method: 'POST', headers: buildNoAuthHeaders(), body: {}, timeoutMs: 15000,
  });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.state || !data.authUrl) {
    throw new Error('获取登录 state 失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return data;
}

async function pollAuthToken(state) {
  const deadline = Date.now() + config.LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, config.LOGIN_POLL_INTERVAL_MS); });
    try {
      const r = await util.requestJson(authPath('/auth/token') + '?state=' + encodeURIComponent(state), {
        method: 'GET', headers: buildNoAuthHeaders(), timeoutMs: 15000,
      });
      const data = r.json && r.json.data;
      if (r.json && r.json.code === 0 && data && data.accessToken) {
        if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
        return data;
      }
      if (r.json && r.json.code === 11217) continue;
      if (r.json && r.json.code !== 0) return { __error: '登录未完成或失败: ' + (r.json.msg || r.json.code) };
    } catch (e) { /* 网络抖动继续 */ }
  }
  return { __error: '登录超时' };
}

async function fetchAccount(state, auth) {
  const headers = Object.assign({}, buildNoAuthHeaders(), { 'Authorization': 'Bearer ' + auth.accessToken });
  delete headers['X-No-Authorization'];
  delete headers['X-No-User-Id'];
  delete headers['X-No-Enterprise-Id'];
  delete headers['X-No-Department-Info'];
  const r = await util.requestJson(authPath('/login/account') + '?state=' + encodeURIComponent(state), {
    method: 'GET', headers, timeoutMs: 15000,
  });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error('获取账号失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return r.json.data;
}

async function fetchAccounts(auth) {
  const headers = { 'Authorization': 'Bearer ' + auth.accessToken, 'X-Domain': auth.domain || config.ENDPOINT_HOST, 'User-Agent': 'CodeBuddy-Proxy/1.0' };
  const r = await util.requestJson(authPath('/accounts'), { method: 'GET', headers, timeoutMs: 15000 });
  if (r.json && r.json.code === 0 && Array.isArray(r.json.data)) return r.json.data;
  return [];
}

/** 用 refresh_token 手工导入账号：换 accessToken 并拉取账号信息 */
async function importByRefreshToken(refreshToken, name, domain) {
  if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new Error('refreshToken 不能为空');
  }
  const rt = refreshToken.trim();
  const dom = (domain && String(domain).trim()) || config.ENDPOINT_HOST;
  const headers = {
    'X-Refresh-Token': rt,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': dom,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeBuddy-Proxy/1.0',
  };
  const r = await util.requestJson(authPath('/auth/token/refresh'), { method: 'POST', headers, body: {}, timeoutMs: 30000 });
  const data = r.json && r.json.data;
  if (!r.json || r.json.code !== 0 || !data || !data.accessToken) {
    throw new Error('刷新失败（refresh_token 可能已失效）: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  if (!data.expiresAt && data.expiresIn) data.expiresAt = Date.now() + data.expiresIn * 1000;
  if (!data.refreshToken) data.refreshToken = rt;
  if (!data.domain) data.domain = dom;
  // 拉取账号信息（accessToken 换取）
  let account = null;
  try { account = await fetchAccountByToken(data); }
  catch (e) { logger.log('warn', 'auth', '导入账号时获取账号信息失败: ' + e.message); account = { uid: '', nickname: '', type: 'personal' }; }
  const accounts = await fetchAccounts(data).catch(function () { return []; });
  const acct = sessionMod.addAccount({
    name: (name && String(name).trim()) || '',
    source: 'manual',
    addedBy: 'manual',
    account: account,
    auth: data,
    accounts: accounts,
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  });
  if (!acct) throw new Error('账号写入失败');
  logger.log('info', 'auth', '手工导入账号成功: ' + (acct.name || acct.account.nickname || acct.account.uid));
  return acct;
}

/** 用 accessToken 拉取当前账号信息 */
async function fetchAccountByToken(auth) {
  const headers = Object.assign({}, buildNoAuthHeaders(), { 'Authorization': 'Bearer ' + auth.accessToken });
  delete headers['X-No-Authorization'];
  delete headers['X-No-User-Id'];
  delete headers['X-No-Enterprise-Id'];
  delete headers['X-No-Department-Info'];
  const r = await util.requestJson(authPath('/login/account'), { method: 'GET', headers, timeoutMs: 15000 });
  if (!r.json || r.json.code !== 0 || !r.json.data) {
    throw new Error('获取账号失败: ' + (r.json ? (r.json.msg || r.json.code) : r.body));
  }
  return r.json.data;
}

/** 登录成功后把账号追加进池（携带 name 参数） */
async function completeLogin(state, name) {
  const entry = pendingLogins.get(state);
  try {
    const auth = await pollAuthToken(state);
    if (!auth || auth.__error) { if (entry) { entry.status = 'error'; entry.error = (auth && auth.__error) || '未知错误'; } return; }
    let account = null;
    try { account = await fetchAccount(state, auth); }
    catch (e) { logger.log('warn', 'auth', '获取账号信息失败: ' + e.message); account = { uid: '', nickname: '', type: 'personal' }; }
    const accounts = await fetchAccounts(auth).catch(function () { return []; });
    const acct = sessionMod.addAccount({
      name: (name && String(name).trim()) || '',
      source: 'oauth',
      addedBy: 'oauth',
      account: account,
      auth: auth,
      accounts: accounts,
      lastUsedAt: 0,
      useCount: 0,
      createdAt: Date.now(),
    });
    if (!acct) throw new Error('账号写入失败');
    if (entry) { entry.status = 'success'; entry.accountId = acct.id; entry.account = acct; }
    logger.log('info', 'auth', 'OAuth 登录成功: ' + (acct.name || acct.account.nickname || acct.account.uid));
  } catch (e) {
    logger.log('error', 'auth', '登录流程出错: ' + e.message);
    if (entry) { entry.status = 'error'; entry.error = e.message; }
  }
}

/**
 * 校验客户端 API 密钥。
 * 当「校验开关」开启时，请求必须携带 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`，
 * 且该密钥必须是 api_keys 表（或兼容的 CODEBUDDY_API_KEY）中已存在的。
 * 返回 { ok: true, keyId, keyName, accountId } 或 { ok: false, message }。
 * 校验开关关闭时始终放行（keyId/keyName/accountId 为空）。
 */
function verifyClientKey(req) {
  if (!store.clientKeyVerificationEnabled()) return { ok: true, keyId: '', keyName: '' };
  const h = (req && req.headers) || {};
  const authHeader = String(h['authorization'] || h['Authorization'] || '');
  let provided = '';
  if (authHeader.startsWith('Bearer ')) provided = authHeader.slice(7).trim();
  else if (authHeader.startsWith('bearer ')) provided = authHeader.slice(7).trim();
  else provided = String(h['x-api-key'] || h['X-Api-Key'] || '').trim();

  if (!provided) return { ok: false, message: '缺少 API 密钥（请在 Authorization: Bearer 或 X-API-Key 头提供）' };

  // API 密钥爆破限流：按客户端 IP 持久化计数，防止对短自定义密钥无限试错
  const ip = adminAuth.clientIp(req);
  const rlKey = 'apikey:' + ip;
  const rl = store.rateLimitCheck(rlKey, { scope: 'apikey', maxFails: 20, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    return { ok: false, message: 'API 密钥校验失败次数过多，请稍后再试', rateLimited: true, retryAfterSec: rl.retryAfterSec };
  }

  const matched = store.resolveApiKey(provided);
  if (!matched) {
    store.rateLimitRecordFailure(rlKey, { scope: 'apikey', maxFails: 20, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
    return { ok: false, message: 'API 密钥无效' };
  }
  store.rateLimitReset(rlKey);
  return { ok: true, keyId: matched.id, keyName: matched.name, accountId: matched.accountId || '' };
}

module.exports = {
  buildNoAuthHeaders, buildAuthHeaders, buildChatRequestHeaders, authPath, isExpiring,
  CLI_VERSION,
  refreshToken, getValidAccount, getValidSession,
  pickAccountForRequest, extractAccountKey, extractSessionKey, isSessionEnd,
  recordUpstreamFailure, recordUpstreamSuccess,
  verifyClientKey,
  fetchAuthState, pollAuthToken, fetchAccount, fetchAccounts, completeLogin,
  importByRefreshToken, fetchAccountByToken,
  pendingLogins,
};