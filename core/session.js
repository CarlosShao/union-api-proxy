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
      // 渠道专有字段：白名单式归一化会把它们丢掉，导致上游设备指纹缺失
      // （Trae 签到/额度接口校验 x-device-id，缺失会以 1001 拒绝）
      apiHost: auth.apiHost || '',
      machineId: auth.machineId || '',
      deviceId: auth.deviceId || '',
      enterpriseId: auth.enterpriseId || '',
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
  return {
    provider,
    mode: 'pool',
    strategy: 'round-robin',
    pinnedId: null,
    cursor: 0,
    stickyEnabled: true,   // 会话粘性：把一次对话固定到同一账号（保住 prompt cache）
    stickyTtlMin: 30,      // 绑定存活分钟数
    failoverEnabled: true, // 上游失败时自动换一个账号重试一次
  };
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
      stickyEnabled: raw.pool.stickyEnabled !== false,
      stickyTtlMin: Number(raw.pool.stickyTtlMin) > 0 ? Number(raw.pool.stickyTtlMin) : 30,
      failoverEnabled: raw.pool.failoverEnabled !== false,
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
      stickyEnabled: !cfg.pool || cfg.pool.stickyEnabled !== false,
      stickyTtlMin: (cfg.pool && Number(cfg.pool.stickyTtlMin) > 0) ? Number(cfg.pool.stickyTtlMin) : 30,
      failoverEnabled: !cfg.pool || cfg.pool.failoverEnabled !== false,
    };
  }
  state = { version: 2, pools, accounts };
  // 启动时清理陈旧绑定：停机期间进行中的任务视为已结束。
  // 不清也能跑（会按 last_seen_at 惰性过期），但表会一直涨。
  try { store.pruneSessionBindings(2 * 60 * 60 * 1000); } catch (e) { /* ignore */ }
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
    // 池配置按渠道分别落库。
    // 注意：这里必须**逐字段写全**。account_pool.config 是整体覆盖的 JSON，
    // 少写一个字段就会把它从库里抹掉（下次 loadFromDb 读到缺失值 → 回默认值）。
    for (const [kind, p] of Object.entries(state.pools || {})) {
      store.setAccountPool({ version: 2, pool: {
        mode: p.mode,
        strategy: p.strategy,
        pinnedId: p.pinnedId,
        cursor: p.cursor,
        stickyEnabled: p.stickyEnabled !== false,
        stickyTtlMin: Number(p.stickyTtlMin) > 0 ? Number(p.stickyTtlMin) : 30,
        failoverEnabled: p.failoverEnabled !== false,
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
    // 账号全清，绑定必然全部指向不存在的账号，一并清掉
    store.deleteAllSessionBindings();
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
    // 必须连带删掉会话绑定：残留绑定指向已删除的账号，pickAccountForSession
    // 每次都会判定失效并重新选，粘性等于静默失效（还会每次多查一次库）。
    try { store.deleteSessionBindingsByAccount(id); } catch (e) { /* ignore */ }
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
  // 会话粘性开关。注意 stickyEnabled 是布尔，false 也是有效值，不能用
  // `if (patch.x)` 判断 —— 那会让「关闭粘性」永远写不进去。
  if (patch.stickyEnabled !== undefined) p.stickyEnabled = !!patch.stickyEnabled;
  if (Number(patch.stickyTtlMin) > 0) p.stickyTtlMin = Number(patch.stickyTtlMin);
  if (patch.failoverEnabled !== undefined) p.failoverEnabled = !!patch.failoverEnabled;
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
  // pool.strategy 此前**从未被读取**——管理页能设 quota-weighted / least-used，
  // 但选号一直是无条件轮询，设了等于没设。这里才真正按策略走。
  const p2 = p;
  if (p2.strategy && p2.strategy !== 'round-robin') {
    const byStrategy = pickAccountByStrategy(kind);
    if (byStrategy) return byStrategy;
  }
  const cursor = ((p.cursor || 0) % valid.length + valid.length) % valid.length;
  p.cursor = (cursor + 1) % valid.length;
  // cursor 只留在内存：轮询游标无需即时落库，重启后归零无害。
  // 注意这里**不能**像上游那样每次 pick 都 persistPool()——本地已刻意改成
  // deferPersist→全量池重写，那会在流式响应中途阻塞事件循环，是本地修掉过的性能问题。
  return valid[cursor];
}

/* ---- 额度加权选号 ---- */

/**
 * 额度缓存：accountId -> { usageLeft, usageTotal, todayUsed, at }。
 * 由 refreshQuotaCache() 异步填充。放内存，与冷却表同理：额度随时在变，
 * 缓存意义在于「选号时不要同步等网络」。
 */
const quotaCache = new Map();

function setQuotaCache(accountId, info) {
  if (!accountId || !info) return false;
  quotaCache.set(accountId, {
    usageLeft: Number(info.usageLeft) || 0,
    usageTotal: Number(info.usageTotal) || 0,
    todayUsed: Number(info.todayUsed) || 0,
    at: Date.now(),
  });
  return true;
}

function getQuotaCache(accountId) { return quotaCache.get(accountId) || null; }
function clearQuotaCache() { quotaCache.clear(); }

/**
 * 候选账号里有多少比例拿得到额度数据。
 * 低于全覆盖时**必须退化为轮询** —— 否则「只有一个账号有缓存」会把请求永远压到
 * 那一个账号上（上游的 pickLeastUsed 就有这个饿死问题）。
 */
function quotaCoverage(candidates) {
  if (!candidates.length) return 0;
  let n = 0;
  for (const a of candidates) if (quotaCache.has(a.id)) n++;
  return n / candidates.length;
}

/** 按剩余额度占比加权随机挑一个（占比而非绝对值：避免大套餐账号长期霸占） */
function pickQuotaWeighted(candidates) {
  const weights = candidates.map((a) => {
    const q = quotaCache.get(a.id);
    if (!q || !(q.usageTotal > 0)) return 1;
    const ratio = Math.max(0, Math.min(1, q.usageLeft / q.usageTotal));
    // 完全没有额度（ratio=0）也要给一个极小权重之外的兜底：
    // 真正的 0 会让该账号永远选不上，这里保留 0.05 的下限，
    // 避免「额度为 0 的账号」在缓存过期期间彻底饿死、用户以为账号不存在。
    return Math.max(ratio, 0.05);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  if (!(total > 0)) return candidates[0];
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** 挑今日消耗最少的（均衡各账号的日消耗） */
function pickLeastUsed(candidates) {
  let best = null;
  let bestVal = Infinity;
  for (const a of candidates) {
    const q = quotaCache.get(a.id);
    const v = q ? q.todayUsed : 0;
    if (v < bestVal) { bestVal = v; best = a; }
  }
  return best || candidates[0];
}

/**
 * 按渠道池配置的 strategy 选号。
 * 额度数据不完整时一律退化���轮询（宁可分布不均，也不要饿死某几个账号）。
 */
function pickAccountByStrategy(provider) {
  const kind = provider || 'codebuddy';
  const p = poolOf(kind);
  const candidates = healthyAccounts(kind);
  if (!candidates.length) return null;

  const strategy = p.strategy || 'round-robin';
  if (strategy === 'round-robin') {
    const cursor = ((p.cursor || 0) % candidates.length + candidates.length) % candidates.length;
    p.cursor = (cursor + 1) % candidates.length;
    return candidates[cursor];
  }
  if (strategy !== 'quota-weighted' && strategy !== 'least-used') {
    // 未知策略不静默退化：按轮询处理并在日志里能看出来（管理页也会显示原值）
    const cursor = ((p.cursor || 0) % candidates.length + candidates.length) % candidates.length;
    p.cursor = (cursor + 1) % candidates.length;
    return candidates[cursor];
  }
  // 额度数据必须覆盖全部候选，否则退化轮询（见 quotaCoverage 的说明）
  if (quotaCoverage(candidates) < 1) {
    const cursor = ((p.cursor || 0) % candidates.length + candidates.length) % candidates.length;
    p.cursor = (cursor + 1) % candidates.length;
    return candidates[cursor];
  }
  return strategy === 'quota-weighted' ? pickQuotaWeighted(candidates) : pickLeastUsed(candidates);
}

/**
 * 异步刷新某渠道各账号的额度缓存。失败只影响加权策略，不影响请求。
 * @param {string} provider
 * @param {number} limitMin 距上次刷新不足该分钟数则跳过
 */
async function refreshQuotaCache(provider, limitMin) {
  const kind = provider || 'codebuddy';
  const minMs = (Number(limitMin) > 0 ? Number(limitMin) : 10) * 60 * 1000;
  const now = Date.now();
  const accounts = healthyAccounts(kind);
  let refreshed = 0;
  for (const a of accounts) {
    const prev = quotaCache.get(a.id);
    if (prev && (now - prev.at) < minMs) continue;
    try {
      const credits = require('./credits');
      const info = await credits.getCredits(a.id);
      if (info && info.ok) { setQuotaCache(a.id, info); refreshed++; }
    } catch (e) { /* 单个账号查失败不影响其它 */ }
  }
  return refreshed;
}

/* ---- 账号冷却（失败转移的底座） ---- */

/**
 * 冷却表：accountId -> { until, reason, at }。
 * 刻意放内存不落库 —— 冷却是「当前这会儿用不了」，重启后应该立刻恢复可用，
 * 落库反而会让一次偶发失败在重启后依然生效。
 */
const unhealthyMap = new Map();

/** 各错误类型的冷却时长（毫秒）。没有条目的类型不做冷却。 */
const COOLDOWN_MS = {
  credit: 30 * 60 * 1000,   // 额度耗尽：等很久也不会自己好
  session: 5 * 60 * 1000,   // 登录态失效：多半要重新登录
  rate: 60 * 1000,          // 软限流：一分钟就够
  server: 2 * 60 * 1000,    // 上游 5xx：稍等重试
};

function markUnhealthy(accountId, ms, reason) {
  if (!accountId || !(ms > 0)) return false;
  const now = Date.now();
  const prev = unhealthyMap.get(accountId);
  // 已有冷却时取更晚的到期时间，别让后一次较短的失败把冷却缩短
  const until = Math.max(now + ms, prev ? prev.until : 0);
  unhealthyMap.set(accountId, { until, reason: String(reason || ''), at: now });
  return true;
}

function markHealthy(accountId) {
  if (!accountId) return false;
  return unhealthyMap.delete(accountId);
}

/** 清空全部冷却（管理页「解除全部冷却」用；也是回归测试重置状态用） */
function clearUnhealthy() {
  const n = unhealthyMap.size;
  unhealthyMap.clear();
  return n;
}

/** 该账号当前是否处于冷却中（顺带顺手清掉已过期的条目） */
function isUnhealthy(accountId, now) {
  const e = unhealthyMap.get(accountId);
  if (!e) return false;
  if ((now || Date.now()) >= e.until) { unhealthyMap.delete(accountId); return false; }
  return true;
}

function getUnhealthy(accountId, now) {
  if (!isUnhealthy(accountId, now)) return null;
  return unhealthyMap.get(accountId);
}

function listUnhealthy(now) {
  const t = now || Date.now();
  const out = [];
  for (const [accountId, e] of unhealthyMap.entries()) {
    if (t >= e.until) { unhealthyMap.delete(accountId); continue; }
    const acct = getAccount(accountId);
    out.push({
      accountId,
      accountName: acct ? (acct.name || '') : '(已删除)',
      provider: acct ? (acct.provider || 'codebuddy') : '',
      until: e.until,
      remainingMs: e.until - t,
      reason: e.reason,
    });
  }
  return out;
}

/**
 * 某渠道下「当前可用」的账号：滤掉无 token、跨渠道、以及冷却中的。
 *
 * **provider 参数是必须的**。上游同名函数没有这个参数，照抄会把 inKind 过滤
 * 整个丢掉 —— 于是 Trae 的账号能被 CodeBuddy 的请求选中，等于把一个渠道的
 * 凭据发去另一个渠道的上游域名。
 *
 * @param {string} provider 渠道
 * @param {object} [opts] { excludeId } 额外排除的账号（如刚失败的那个）
 */
function healthyAccounts(provider, opts) {
  if (!state || !state.accounts.length) return [];
  const kind = provider || 'codebuddy';
  const inKind = (a) => (a.provider || 'codebuddy') === kind && a.auth && a.auth.accessToken;
  const pool = state.accounts.filter(inKind);
  if (!pool.length) return [];
  const excludeId = opts && opts.excludeId;
  const ok = pool.filter((a) => a.id !== excludeId && !isUnhealthy(a.id));
  // 全被冷却/排除时退化为「忽略健康度」，避免一个都不能选直接报「没有可用账号」。
  // 用原始池（仍受 inKind 约束）而不是全部账号。
  return ok.length ? ok : pool.filter((a) => a.id !== excludeId) ;
}

/**
 * 失败转移：给刚失败的账号换一个（尽量健康的）同渠道账号。
 * @param {string} failedAccountId 刚失败的账号
 * @param {string} provider 渠道
 * @returns {object|null}
 */
function pickFailoverAccount(failedAccountId, provider) {
  const kind = provider || 'codebuddy';
  const p = poolOf(kind);
  if (p.failoverEnabled === false) return null;      // 显式关闭
  if (p.mode === 'pinned' && p.pinnedId) return null; // 指定模式下不擅自换号
  const candidates = healthyAccounts(kind, { excludeId: failedAccountId });
  if (!candidates.length) return null;
  // 在候选里轮询，避免总是挑到同一个
  const cursor = ((p.cursor || 0) % candidates.length + candidates.length) % candidates.length;
  p.cursor = (cursor + 1) % candidates.length;
  return candidates[cursor];
}

/* ---- 会话粘性（session stickiness） ---- */

function hashKey(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
}

/** 取消息的纯文本前若干字符，用于指纹 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (c) {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') return typeof c.text === 'string' ? c.text : '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return contentToText(Array.isArray(content) ? content : [content]);
  return String(content);
}

/** 会话指纹的一部分：全部 system 消息 + 第一条 user 消息 */
function messagePrefixFingerprint(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const systems = [];
  let firstUser = '';
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') systems.push(contentToText(m.content).slice(0, 200));
    else if (!firstUser && m.role === 'user') firstUser = contentToText(m.content).slice(0, 200);
  }
  return systems.join('\n---\n') + '\n@@@\n' + firstUser;
}

/**
 * 计算会话键。**kind 必须参与哈希** —— 本项目是多渠道聚合：同一个客户端、同一段
 * 系统提示词，可能同时打 cc/ 与 tc/ 的模型。若不把渠道算进去，两边会算出同一个
 * session_key，粘性就会把 B 渠道绑定的账号发给 A 渠道的请求 —— 那等于把一个渠道的
 * 凭据发去另一个渠道的上游域名。
 *
 * 优先级：
 *   1. X-Session-Id 头（客户端显式声明，最权威）
 *   2. API 密钥 id（同一密钥 = 同一使用方）
 *   3. 对话前缀指纹（全部 system 消息 + 首条 user 消息，零配置）
 */
function computeSessionKey(kind, opts) {
  const o = opts || {};
  let raw = '';
  if (o.sessionId) raw = 'sid:' + o.sessionId;
  else if (o.apiKeyId) raw = 'key:' + o.apiKeyId;
  else if (Array.isArray(o.messages) && o.messages.length) raw = 'fp:' + messagePrefixFingerprint(o.messages);
  if (!raw) return null;
  return hashKey((kind || 'codebuddy') + '|' + raw);
}

/** 绑定是否已过期（按渠道的 stickyTtlMin） */
function bindingExpired(binding, now) {
  if (!binding) return true;
  const p = poolOf(binding.provider);
  const ttlMin = Number(p.stickyTtlMin) > 0 ? Number(p.stickyTtlMin) : 30;
  const last = Number(binding.lastSeenAt) || 0;
  if (!last) return true;
  return (now || Date.now()) - last > ttlMin * 60 * 1000;
}

/**
 * 为一次「会话」选账号：有有效绑定就复用，否则轮询选一个并写绑定。
 *
 * 三重跨渠道防护（缺一不可）：
 *   1. computeSessionKey 已把渠道混入哈希；
 *   2. 绑定行里另存了 provider，这里再比对一次；
 *   3. 取回的账号仍要过 inKind 过滤。
 *
 * @param {string|null} sessionKey
 * @param {string} provider 渠道
 * @returns {object|null} 账号
 */
function pickAccountForSession(sessionKey, provider) {
  const kind = provider || 'codebuddy';
  const inKind = (a) => !!a && (a.provider || 'codebuddy') === kind;
  const p = poolOf(kind);

  if (sessionKey && p.stickyEnabled !== false) {
    const b = store.getSessionBinding(sessionKey);
    if (b && b.provider === kind && !bindingExpired(b)) {
      const acct = getAccount(b.accountId);
      // 账号被删 / 渠道被改 / 令牌没了 -> 清掉陈旧绑定后重新选
      if (acct && inKind(acct) && acct.auth && acct.auth.accessToken) {
        store.touchSessionBinding(sessionKey);
        return acct;
      }
      store.deleteSessionBinding(sessionKey);
    } else if (b) {
      store.deleteSessionBinding(sessionKey);   // 过期或渠道不符
    }
  }

  const acct = pickAccount(null, kind);
  if (acct && sessionKey && p.stickyEnabled !== false) {
    try { store.setSessionBinding(sessionKey, acct.id, kind); } catch { /* 落库失败只是失去粘性，不影响请求 */ }
  }
  return acct;
}

/** 客户端声明会话结束（X-Session-End 头 / body 标记）时释放绑定 */
function releaseSession(sessionKey) {
  if (!sessionKey) return false;
  try { return store.deleteSessionBinding(sessionKey) > 0; } catch { return false; }
}

/** 失败转移换号后，把已有绑定改指到新账号（否则下一次请求又被粘回坏账号） */
function rebindSession(sessionKey, accountId, provider) {
  if (!sessionKey || !accountId) return false;
  try {
    store.setSessionBinding(sessionKey, accountId, provider || 'codebuddy');
    return true;
  } catch { return false; }
}

/** 列出当前绑定（管理页诊断用；session_key 是哈希，不含消息内容） */
/** 清理陈旧绑定（供调度器/启动调用） */
function pruneSessionBindings(ttlMs) {
  try { return store.pruneSessionBindings(ttlMs); } catch (e) { return 0; }
}

function listSessionBindings(limit) {
  try { return store.listSessionBindings(limit); } catch { return []; }
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
  // 会话粘性
  computeSessionKey, pickAccountForSession, releaseSession, rebindSession, listSessionBindings, pruneSessionBindings,
  // 账号冷却 / 失败转移
  COOLDOWN_MS, markUnhealthy, markHealthy, clearUnhealthy, isUnhealthy, getUnhealthy, listUnhealthy,
  healthyAccounts, pickFailoverAccount,
  // 额度加权选号
  setQuotaCache, getQuotaCache, clearQuotaCache, refreshQuotaCache, pickAccountByStrategy,
  isLoggedIn, getSession, setSession, getSessionSource,
  flushPersist,
};
