'use strict';

/**
 * 会话状态：账号池（多 OAuth / VSCode / 手工导入账号）、归一化、读写本地存储、退出清理。
 *
 * 存储已从本地 session.json 迁移到 SQLite（core/store.js 的 accounts / account_pool 表）。
 * 本模块保留原有对外 API 不变，仅把持久化后端替换为数据库；首次启动时自动迁移旧 session.json。
 */

const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const store = require('./store');

let state = null;          // 内存态：{ version, pool, accounts[] }
let sessionSource = '';    // 最近一次账号来源：vscode | oauth | manual | file

function genId() {
  return 'acct_' + crypto.randomBytes(12).toString('hex');
}

function normalizeSession(data) {
  if (!data || !data.auth || !data.auth.accessToken) return null;
  const account = data.account || {};
  const auth = data.auth || {};
  if (auth.expiresIn && !auth.expiresAt) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
  if (auth.refreshExpiresIn && !auth.refreshExpiresAt) auth.refreshExpiresAt = Date.now() + auth.refreshExpiresIn * 1000;
  return {
    account: {
      uid: account.uid || account.id || '',
      nickname: account.nickname || account.label || '',
      type: account.type || 'personal',
      enterpriseId: account.enterpriseId || '',
      departmentFullName: account.departmentFullName || '',
      lastLogin: true,
    },
    auth: {
      accessToken: auth.accessToken || '',
      refreshToken: auth.refreshToken || '',
      tokenType: auth.tokenType || 'Bearer',
      domain: auth.domain || config.ENDPOINT_HOST,
      scope: auth.scope || '',
      expiresIn: auth.expiresIn || 0,
      expiresAt: auth.expiresAt || 0,
      refreshExpiresIn: auth.refreshExpiresIn || 0,
      refreshExpiresAt: auth.refreshExpiresAt || 0,
      lastRefreshTime: auth.lastRefreshTime || Date.now(),
    },
    accounts: data.accounts || [],
  };
}

function normalizePoolAccount(acct) {
  if (!acct || !acct.auth || !acct.auth.accessToken) return null;
  const n = normalizeSession({ account: acct.account, auth: acct.auth, accounts: acct.accounts });
  if (!n) return null;
  const source = acct.source || acct.addedBy || 'file';
  return {
    id: acct.id || genId(),
    provider: acct.provider || 'codebuddy',
    name: acct.name || n.account.nickname || n.account.uid || '未命名',
    source,
    addedBy: acct.addedBy || source,
    account: n.account,
    auth: n.auth,
    accounts: n.accounts,
    autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
    lastUsedAt: acct.lastUsedAt || 0,
    useCount: acct.useCount || 0,
    createdAt: acct.createdAt || Date.now(),
  };
}

/** 单渠道的默认池配置 */
function defaultPool(provider) {
  return { provider, mode: 'pool', strategy: 'round-robin', pinnedId: null, cursor: 0 };
}

/** 从旧版池结构里提取逐渠道池配置（旧数据结构只有一个全局 pool） */
function normalizePoolsFromLegacy(raw, accounts) {
  const pools = {};
  if (raw && raw.pool && typeof raw.pool === 'object') {
    pools['codebuddy'] = {
      provider: 'codebuddy',
      mode: raw.pool.mode === 'pinned' ? 'pinned' : 'pool',
      strategy: raw.pool.strategy || 'round-robin',
      pinnedId: raw.pool.pinnedId || null,
      cursor: typeof raw.pool.cursor === 'number' ? raw.pool.cursor : 0,
    };
  }
  // 为出现过的每个渠道补齐默认池配置，避免运行期 poolOf 反复创建
  for (const a of accounts) {
    const k = a.provider || 'codebuddy';
    if (!pools[k]) pools[k] = defaultPool(k);
  }
  return pools;
}

/** 把旧版（单账号 session）或新版（池）数据归一化成池结构 */
function normalizePool(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.version === 2 && Array.isArray(data.accounts) && data.pool) {
    const accounts = data.accounts.map(normalizePoolAccount).filter(Boolean);
    return { version: 2, pools: normalizePoolsFromLegacy(data, accounts), accounts };
  }
  const norm = normalizeSession(data);
  if (!norm) return null;
  return {
    version: 2,
    pools: {},
    accounts: [{
      id: genId(),
      provider: 'codebuddy',
      name: norm.account.nickname || norm.account.uid || '账号 1',
      source: sessionSource || 'file',
      addedBy: sessionSource || 'file',
      account: norm.account,
      auth: norm.auth,
      accounts: norm.accounts,
      lastUsedAt: 0,
      useCount: 0,
      createdAt: Date.now(),
    }],
  };
}

function emptyPool() {
  return { version: 2, pools: {}, accounts: [] };
}

/** 从 SQLite 载入账号池到内存态（账号一张表，池配置按渠道） */
function loadFromDb() {
  const accounts = store.listAccountRows().map(function (r) {
    return {
      id: r.id,
      provider: r.provider || 'codebuddy',
      name: r.name,
      source: r.source,
      addedBy: r.addedBy,
      account: r.account,
      auth: r.auth,
      accounts: r.accounts,
      autoCheckin: r.autoCheckin === undefined ? true : !!r.autoCheckin,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
      createdAt: r.createdAt,
    };
  });
  // 各渠道的池配置（cursor 仅内存，重启归零无害）
  const pools = {};
  for (const [kind, cfg] of Object.entries(store.listAccountPools())) {
    pools[kind] = {
      provider: kind,
      mode: cfg.pool && cfg.pool.mode === 'pinned' ? 'pinned' : 'pool',
      strategy: (cfg.pool && cfg.pool.strategy) || 'round-robin',
      pinnedId: (cfg.pool && cfg.pool.pinnedId) || null,
      cursor: (cfg.pool && typeof cfg.pool.cursor === 'number') ? cfg.pool.cursor : 0,
    };
  }
  state = { version: 2, pools, accounts };
  return true;
}

/**
 * 一次性迁移：若 DB 尚无账号、且旧 session.json 存在，则把旧文件里的账号导入 DB，
 * 并把来源标记为 migrate（保留原始 source 到 addedBy 之外单独用 source 存原值，便于追溯）。
 */
function migrateLegacySession() {
  if (store.accountCount() > 0) return false;
  const file = config.SESSION_FILE;
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const payload = normalizePool(raw);
    if (!payload || !payload.accounts.length) return false;
    for (const acct of payload.accounts) {
      store.insertAccount({
        id: acct.id,
        provider: acct.provider || 'codebuddy',
        name: acct.name,
        source: acct.source || 'file',
        addedBy: 'migrate',               // 添加方式统一标记为 migrate（从旧 session.json 迁移）
        account: acct.account,
        auth: acct.auth,
        accounts: acct.accounts,
        lastUsedAt: acct.lastUsedAt,
        useCount: acct.useCount,
        createdAt: acct.createdAt,
      });
    }
    // 旧文件不分渠道，其池配置归入默认渠道
    if (payload.pool) store.setAccountPool({ version: 2, pool: payload.pool }, 'codebuddy');
    logger.log('info', 'system', '已从旧 session.json 迁移 ' + payload.accounts.length + ' 个账号到数据库');
    // 迁移成功后重命名旧文件，避免后续被误读（保留一份可回滚的 .migrated 备份）
    const bak = file + '.migrated';
    try {
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
      fs.renameSync(file, bak);
      logger.log('info', 'system', '旧 session.json 已重命名为 session.json.migrated');
    } catch (e2) {
      logger.log('warn', 'system', '重命名旧 session.json 失败（不影响迁移）: ' + e2.message);
    }
    return true;
  } catch (e) {
    logger.log('warn', 'system', '迁移旧 session.json 失败: ' + e.message);
    return false;
  }
}

function loadSession() {
  try {
    migrateLegacySession();
    loadFromDb();
    if (state.accounts.length) {
      sessionSource = state.accounts[0].source || 'file';
    }
    return state.accounts.length > 0;
  } catch (e) {
    logger.log('warn', 'system', '加载账号池失败: ' + e.message);
    state = emptyPool();
    return false;
  }
}

/** 把内存态整体写回数据库（账号 + 池配置）。仅用于结构性变更（增删账号、改池配置）。 */
function persistPool() {
  if (!state) return;
  try {
    // 池配置按渠道分别落库
    for (const [kind, p] of Object.entries(state.pools || {})) {
      store.setAccountPool({ version: 2, pool: {
        mode: p.mode, strategy: p.strategy, pinnedId: p.pinnedId, cursor: p.cursor,
      } }, kind);
    }
    // 账号行以逐条 upsert 同步（以内存态为准）
    const knownIds = new Set(state.accounts.map(function (a) { return a.id; }));
    for (const acct of state.accounts) {
      store.insertAccount({
        id: acct.id,
        provider: acct.provider || 'codebuddy',
        name: acct.name,
        source: acct.source,
        addedBy: acct.addedBy || acct.source,
        account: acct.account,
        auth: acct.auth,
        accounts: acct.accounts,
        autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
        lastUsedAt: acct.lastUsedAt,
        useCount: acct.useCount,
        createdAt: acct.createdAt,
      });
    }
    // 删除 DB 中已不在内存态的账号
    for (const r of store.listAccountRows()) {
      if (!knownIds.has(r.id)) store.deleteAccountRow(r.id);
    }
  } catch (e) {
    logger.log('error', 'system', '保存账号池失败: ' + e.message);
  }
}

function saveSession() { persistPool(); }

/** 强制刷新各缓冲区（用于服务关闭前）。账号池本就在结构变更时即时落库，无需额外处理。 */
function flushPersist() {
  // 同步刷新日志缓冲区
  try { store.flushLogsSync(); } catch { /* ignore */ }
  // 同步刷新用量缓冲区
  try { store.flushUsageSync(); } catch { /* ignore */ }
  // 同步刷新密钥使用计数缓冲区
  try { store.flushApiKeyTouches(); } catch { /* ignore */ }
}

function clearSession() {
  state = emptyPool();
  sessionSource = '';
  try {
    for (const r of store.listAccountRows()) store.deleteAccountRow(r.id);
    for (const kind of Object.keys(store.listAccountPools())) store.setAccountPool(store.defaultPoolConfig(), kind);
  } catch (e) { /* ignore */ }
}

function getPool() { return state; }

function setPool(pool, source) {
  state = normalizePool(pool) || emptyPool();
  if (source) sessionSource = source;
  persistPool();
}

/* ---------------- 账号操作 ---------------- */

function listAccounts(provider) {
  if (!state) return [];
  if (!provider) return state.accounts.slice();
  return state.accounts.filter(function (a) { return (a.provider || 'codebuddy') === provider; });
}

/** 各渠道账号数：{ codebuddy: n, traework: m } */
function accountCountsByProvider() {
  const out = {};
  for (const a of (state ? state.accounts : [])) {
    const k = a.provider || 'codebuddy';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function getAccount(id) {
  if (!state) return null;
  return state.accounts.find(function (a) { return a.id === id; }) || null;
}

function findAccountByIdOrName(key) {
  if (!state || !key) return null;
  const k = String(key);
  return state.accounts.find(function (a) { return a.id === k || a.name === k; }) || null;
}

function addAccount(acct) {
  if (!state) state = emptyPool();
  const normalized = normalizePoolAccount(acct);
  if (!normalized) return null;
  state.accounts.push(normalized);
  persistPool();
  return normalized;
}

function updateAccount(id, patch) {
  const acct = getAccount(id);
  if (!acct) return null;
  if (patch && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim()) acct.name = patch.name.trim();
    if (patch.auth && typeof patch.auth === 'object') acct.auth = normalizeSession({ account: acct.account, auth: patch.auth }).auth;
    if (patch.account && typeof patch.account === 'object') acct.account = Object.assign({}, acct.account, patch.account);
    if (patch.autoCheckin !== undefined) acct.autoCheckin = !!patch.autoCheckin;
    if (patch.lastUsedAt != null) acct.lastUsedAt = patch.lastUsedAt;
    if (patch.useCount != null) acct.useCount = patch.useCount;
    if (patch.source) acct.source = patch.source;
    if (patch.addedBy) acct.addedBy = patch.addedBy;
    // auth 可能带 Trae 专有的 machineId/deviceId/apiHost，normalizeSession 会丢掉，需补回
    if (patch.auth && typeof patch.auth === 'object') {
      for (const k of ['machineId', 'deviceId', 'apiHost']) {
        if (patch.auth[k] !== undefined) acct.auth[k] = patch.auth[k];
      }
    }
  }
  // 单行同步落库（微秒级）：token 刷新等场景不再触发 500ms 后的全量池重写（那会在流式响应中途阻塞事件循环）
  try {
    store.updateAccountRow(acct.id, {
      provider: acct.provider || 'codebuddy',
      name: acct.name,
      source: acct.source,
      addedBy: acct.addedBy || acct.source,
      account: acct.account,
      auth: acct.auth,
      accounts: acct.accounts,
      autoCheckin: acct.autoCheckin,
      lastUsedAt: acct.lastUsedAt,
      useCount: acct.useCount,
    });
  } catch (e) {
    logger.log('error', 'system', '保存账号失败: ' + e.message);
  }
  return acct;
}

function removeAccount(id) {
  if (!state) return false;
  const before = state.accounts.length;
  state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
  // 清掉各渠道池里指向该账号的 pinned
  for (const kind of Object.keys(state.pools || {})) {
    if (state.pools[kind].pinnedId === id) state.pools[kind].pinnedId = null;
  }
  const removed = state.accounts.length < before;
  if (removed) {
    persistPool();
    try { store.deleteCheckinState(id); } catch (e) { /* ignore */ }
    try { store.deleteCreditSnapshots(id); } catch (e) { /* ignore */ }
  }
  return removed;
}

/* ---------------- 池模式 / 选号 ---------------- */

/** 取（必要时创建）某渠道的池配置 */
function poolOf(provider) {
  const kind = provider || 'codebuddy';
  if (!state) state = emptyPool();
  if (!state.pools) state.pools = {};
  if (!state.pools[kind]) state.pools[kind] = defaultPool(kind);
  return state.pools[kind];
}

function getPoolConfig(provider) {
  return Object.assign({}, poolOf(provider));
}

function setPoolConfig(patch, provider) {
  const p = poolOf(provider);
  if (patch.mode === 'pinned' || patch.mode === 'pool') p.mode = patch.mode;
  if (patch.strategy) p.strategy = patch.strategy;
  if (patch.pinnedId !== undefined) p.pinnedId = patch.pinnedId || null;
  persistPool();
  return getPoolConfig(provider);
}

function isExpiringAuth(auth) {
  if (!auth) return true;
  if (!auth.expiresAt) {
    // 缺少过期时间的账号（如手工导入）：若最近刷新过则视为仍有效。
    // 否则每个请求都会先做一次 token 刷新网络往返（最长 30s 超时）。
    const last = typeof auth.lastRefreshTime === 'number'
      ? auth.lastRefreshTime
      : Date.parse(auth.lastRefreshTime);
    if (Number.isFinite(last) && Date.now() - last < config.AUTH_FRESH_MS) return false;
    return true;
  }
  const expiresAt = typeof auth.expiresAt === 'number'
    ? (auth.expiresAt > 1e12 ? auth.expiresAt : auth.expiresAt * 1000)
    : Date.parse(auth.expiresAt);
  return Date.now() + config.REFRESH_AHEAD_MS >= expiresAt;
}

/** 挑出一个账号（不自动刷新；刷新由 auth.js 负责）。返回账号或 null */
function pickAccount(explicitKey, provider) {
  if (!state || !state.accounts.length) return null;
  const kind = provider || 'codebuddy';
  const inKind = function (a) { return (a.provider || 'codebuddy') === kind; };
  if (explicitKey) {
    const found = findAccountByIdOrName(explicitKey);
    return (found && inKind(found)) ? found : null;
  }
  const p = poolOf(kind);
  if (p.mode === 'pinned' && p.pinnedId) {
    const pinned = getAccount(p.pinnedId);
    if (pinned && inKind(pinned)) return pinned;
  }
  const valid = state.accounts.filter(function (a) { return inKind(a) && a.auth && a.auth.accessToken; });
  if (!valid.length) return null;
  const cursor = ((p.cursor || 0) % valid.length + valid.length) % valid.length;
  p.cursor = (cursor + 1) % valid.length;
  // cursor 只留在内存：轮询游标无需即时落库，重启后归零无害
  return valid[cursor];
}

/** 标记某账号被使用 */
function markUsed(id) {
  const acct = getAccount(id);
  if (!acct) return;
  acct.lastUsedAt = Date.now();
  acct.useCount = (acct.useCount || 0) + 1;
  // 单行 UPDATE 即时落库（微秒级）。此前走 deferPersist → 500ms 后全量池重写，
  // 恰好落在流式响应中途阻塞事件循环，是把思考 delta 拉出秒级间隙的主因之一。
  try { store.touchAccount(id, acct.lastUsedAt, acct.useCount); } catch { /* ignore */ }
}

/* ---------------- 兼容旧 API ---------------- */

function isLoggedIn(provider) {
  if (!state) return false;
  const list = provider
    ? state.accounts.filter(function (a) { return (a.provider || 'codebuddy') === provider; })
    : state.accounts;
  return list.some(function (a) { return a.auth && a.auth.accessToken; });
}

/** 返回「活跃账号」用于启动日志 / 状态展示兼容：pinned 或该渠道第一个 */
function getActiveAccount(provider) {
  if (!state || !state.accounts.length) return null;
  const kind = provider || 'codebuddy';
  const inKind = function (a) { return (a.provider || 'codebuddy') === kind; };
  const p = (state.pools && state.pools[kind]) || null;
  if (p && p.mode === 'pinned' && p.pinnedId) {
    const pinned = getAccount(p.pinnedId);
    if (pinned && inKind(pinned)) return pinned;
  }
  return state.accounts.find(inKind) || null;
}

function getSession() { return getActiveAccount(); }

function setSession(s, source) {
  if (!state) state = emptyPool();
  const norm = normalizeSession(s);
  if (norm) {
    const existing = state.accounts[0];
    if (existing) {
      existing.account = norm.account;
      existing.auth = norm.auth;
      existing.accounts = norm.accounts;
      if (!existing.name) existing.name = norm.account.nickname || norm.account.uid || '账号 1';
      existing.source = source || existing.source;
      existing.addedBy = existing.addedBy || source;
    } else {
      addAccount({
        id: genId(),
        name: norm.account.nickname || norm.account.uid || '账号 1',
        source: source || 'oauth',
        addedBy: source || 'oauth',
        account: norm.account,
        auth: norm.auth,
        accounts: norm.accounts,
        lastUsedAt: 0,
        useCount: 0,
        createdAt: Date.now(),
      });
    }
    persistPool();
  }
  if (source) sessionSource = source;
}

function getSessionSource() { return sessionSource; }

module.exports = {
  normalizeSession, normalizePool, loadSession, saveSession, clearSession,
  getPool, setPool, getPoolConfig, setPoolConfig,
  listAccounts, accountCountsByProvider, getAccount, findAccountByIdOrName,
  addAccount, updateAccount, removeAccount,
  isExpiringAuth, pickAccount, markUsed, getActiveAccount,
  isLoggedIn, getSession, setSession, getSessionSource,
  flushPersist,
};
