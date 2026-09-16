'use strict';

/** HTTP 路由：状态/登录/代理/管理 API/静态页面 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const logger = require('./logger');
const util = require('./util');
const buildState = require('./build');
const models = require('./models');
const sessionMod = require('./session');
const vscode = require('./vscode');
const auth = require('./auth');
const openai = require('./openai');
const responses = require('./responses');
const providers = require('./providers/all');
const modelCache = require('./providers/modelCache');
const checkin = require('./checkin');
const checkinScheduler = require('./checkinScheduler');
const credits = require('./credits');
const adminAuth = require('./adminAuth');

/* ============================ 状态对象 ============================ */

function accountPublic(acct) {
  if (!acct) return null;
  const a = acct.account || {};
  const au = acct.auth || {};
  const provider = acct.provider || 'codebuddy';
  return {
    id: acct.id,
    provider,
    name: acct.name || '',
    source: acct.source || 'file',
    addedBy: acct.addedBy || acct.source || 'file',
    uid: a.uid || '',
    nickname: a.nickname || '',
    type: a.type || 'personal',
    enterpriseId: a.enterpriseId || '',
    domain: au.domain || (provider === 'traework' ? 'trae.cn' : config.ENDPOINT_HOST),
    expiresAt: au.expiresAt || 0,
    expiresInSeconds: au.expiresAt ? Math.round((au.expiresAt - Date.now()) / 1000) : 0,
    hasToken: !!au.accessToken,
    autoCheckin: acct.autoCheckin === undefined ? true : !!acct.autoCheckin,
    lastUsedAt: acct.lastUsedAt || 0,
    useCount: acct.useCount || 0,
    createdAt: acct.createdAt || 0,
  };
}

function statusObject() {
  const kinds = providers.providerKinds();
  const active = sessionMod.getActiveAccount();
  const a = active ? active.account : null;
  // 逐渠道的池配置与账号数，供管理页分渠道展示
  const pools = {};
  const accountCounts = sessionMod.accountCountsByProvider();
  for (const k of kinds) {
    pools[k] = Object.assign({}, sessionMod.getPoolConfig(k));
    pools[k].accountCount = accountCounts[k] || 0;
    pools[k].loggedIn = sessionMod.isLoggedIn(k);
    pools[k].label = providers.labelOf(k);
  }
  const defaultKind = providers.defaultKind();
  // 给客户端展示的地址：容器里 HOST=0.0.0.0 是监听用地址，客户端无法直接访问，
  // 展示时回落为 127.0.0.1；可用 UNION_PUBLIC_HOST 覆盖（如域名/局域网 IP）。
  const publicHost = process.env.UNION_PUBLIC_HOST
    || (config.HOST === '0.0.0.0' || config.HOST === '::' ? '127.0.0.1' : config.HOST);
  return {
    loggedIn: sessionMod.isLoggedIn(),
    source: sessionMod.getSessionSource(),
    endpoint: config.ENDPOINT,
    baseUrl: `http://${publicHost}:${config.PORT}`,
    openaiBaseUrl: `http://${publicHost}:${config.PORT}/v1`,
    // 兼容旧字段：默认渠道的池信息
    pool: Object.assign({}, sessionMod.getPoolConfig(defaultKind)),
    pools,
    providers: kinds.map((k) => ({ kind: k, label: providers.labelOf(k) })),
    accounts: sessionMod.listAccounts().map(accountPublic),
    account: a ? { uid: a.uid, nickname: a.nickname, type: a.type, enterpriseId: a.enterpriseId || '' } : null,
    auth: active ? {
      accessToken: util.maskedToken(active.auth.accessToken),
      refreshToken: util.maskedToken(active.auth.refreshToken),
      domain: active.auth.domain || config.ENDPOINT_HOST,
      expiresAt: active.auth.expiresAt || 0,
      expiresInSeconds: active.auth.expiresAt ? Math.round((active.auth.expiresAt - Date.now()) / 1000) : 0,
    } : null,
    models: models.allModels(store.listModels(), store.getHiddenModels(), modelCache.extraModelsForAllProviders()),
  };
}

/* ============================ 系统配置 ============================ */

function accountsPayload(provider) {
  const kinds = providers.providerKinds();
  const pools = {};
  const accountCounts = sessionMod.accountCountsByProvider();
  for (const k of kinds) {
    pools[k] = Object.assign({}, sessionMod.getPoolConfig(k));
    pools[k].accountCount = accountCounts[k] || 0;
    pools[k].loggedIn = sessionMod.isLoggedIn(k);
    pools[k].label = providers.labelOf(k);
  }
  const states = store.listCheckinStates();
  const autoCheckin = store.autoCheckinEnabled();
  const accounts = sessionMod.listAccounts(provider).map(function (acct) {
    const pub = accountPublic(acct);
    const st = states[acct.id];
    pub.checkinLastDate = st ? st.lastDate : '';
    pub.checkinNextAt = st ? st.nextAt : 0;
    return pub;
  });
  const defaultKind = providers.defaultKind();
  return {
    pool: pools[defaultKind],
    pools,
    providers: kinds.map((k) => ({ kind: k, label: providers.labelOf(k) })),
    accounts,
    autoCheckin,
  };
}

/**
 * /v1/models 的响应：只列出「已有账号的渠道」的模型。
 * 未登录任何账号的渠道不应出现（避免客户端选到用不了的模型）；默认渠道始终保留，保持旧客户端行为不变。
 * 非默认渠道优先用动态拉取的真实模型列表（静态表仅作兜底）。
 */
function modelsResponseForLoggedInProviders() {
  return models.modelsResponse(
    store.listModels(), store.getHiddenModels(),
    modelCache.extraModelsForAllProviders({ onlyLoggedIn: true })
  );
}

function parseBoolFlag(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function configResponse() {
  return {
    values: store.publicValues(),
    runtime: {
      version: config.VERSION,
      port: config.PORT,
      host: config.HOST,
      endpoint: config.ENDPOINT,
      platform: config.PLATFORM,
      sessionFile: config.SESSION_FILE,
      dbFile: config.DB_FILE,
      dataDir: config.DATA_DIR,
      build: buildState.getBuildState(),
    },
    options: {
      levels: config.LOG_LEVELS,
      categories: config.LOG_CATEGORIES,
      models: models.allModels(store.listModels(), store.getHiddenModels(), modelCache.extraModelsForAllProviders()).map((m) => ({ id: models.modelKey(m), name: m.name, hidden: !!m.hidden, provider: m.provider || "codebuddy" })),
    },
  };
}

/* ============================ 静态 / SPA ============================ */

function distMissingHtml() {
  const b = buildState.getBuildState();
  const title = b.built ? '管理页面已过期' : '管理页面尚未构建';
  const body = b.built
    ? '检测到前端源码更新，但尚未重新构建。<br>请先运行:  <b>npm install && npm run build</b><br>然后重启服务。'
    : '请先运行:  <b>npm install && npm run build</b><br>然后重启服务。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CodeBuddy API Proxy</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}pre{background:#1b1f24;padding:20px 24px;border-radius:10px;line-height:1.7;border:1px solid #2a2f36}</style>
</head><body><pre>${title}。
${body}</pre></body></html>`;
}

function serveIndex(res) {
  const indexFile = path.join(config.DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    fs.createReadStream(indexFile).pipe(res);
  } else {
    util.sendHtml(res, 200, distMissingHtml());
  }
}

/** 服务 dist 静态资源；非文件路径（无扩展名）回退到 SPA index.html */
function serveDist(res, pathname) {
  if (pathname === '/') { serveIndex(res); return; }
  const rel = pathname.replace(/^\/+/, '');
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(config.DIST_DIR, safe);
  if (!filePath.startsWith(config.DIST_DIR) || safe.includes('..')) {
    util.sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    util.sendFile(res, filePath);
    return;
  }
  if (!path.extname(safe)) {
    serveIndex(res); // SPA 路由回退
    return;
  }
  util.sendJson(res, 404, { error: { message: `Not Found: ${pathname}` } });
}

/* ============================ 路由 ============================ */

/**
 * 容忍客户端漏写 /v1 前缀。
 * 部分客户端（如 ZCode 的自定义 provider）会把 baseURL 直接拼上 /chat/completions，
 * 若用户 baseURL 填成 http://host:port（漏了 /v1），就会打到 /chat/completions 而 404。
 * 这里把裸 OpenAI 路径映射到 /v1/* 等价路径，避免该陷阱。
 * 注意：/models 不在此列 —— 它有自己的路由（Accept 为 HTML 时回退到管理页 SPA）。
 */
const BARE_V1_ALIASES = {
  '/chat/completions': '/v1/chat/completions',
  '/completions': '/v1/completions',
  '/embeddings': '/v1/embeddings',
  '/responses': '/v1/responses',
};

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = u.pathname;
  const method = req.method || 'GET';

  // 兼容漏写 /v1 的 baseURL（仅 POST 类接口，避免影响静态资源与 SPA 路由）
  if (BARE_V1_ALIASES[pathname]) pathname = BARE_V1_ALIASES[pathname];

  if (method === 'OPTIONS') {
    res.writeHead(204, util.corsHeaders());
    res.end();
    return;
  }

  /* ---- 管理页鉴权守卫（开启时拦截所有管理接口/页面） ---- */
  const guardResult = adminAuth.guard(req, pathname, method);
  if (guardResult) {
    if (guardResult.__renew) {
      // 滑动续期成功，写回刷新后的 Cookie
      const c = adminAuth.cookieString(config.ADMIN_COOKIE, guardResult.__renew.token, { expiresAt: guardResult.__renew.expiresAt });
      res.setHeader('Set-Cookie', c);
    } else {
      util.sendJson(res, guardResult.status, guardResult.body);
      return;
    }
  }

  /* ---- 管理页鉴权：登录 / 登出 / 状态 / 改密 ---- */
  if (pathname === '/api/admin/status' && method === 'GET') {
    const authed = adminAuth.verifySession(req).ok;
    const resp = {
      enabled: store.adminAuthEnabled(),
      configured: store.adminConfigured(),
      authenticated: authed,
    };
    // 仅在已登录时返回用户名，避免向未认证的爆破者泄露账号名
    if (authed) resp.username = config.ADMIN_USERNAME;
    util.sendJson(res, 200, resp);
    return;
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password) { util.sendJson(res, 400, { error: { message: '密码不能为空' } }); return; }
      const uname = username || config.ADMIN_USERNAME;
      const rate = adminAuth.rateCheck(req, uname);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        util.sendJson(res, 429, { error: { message: '登录失败次数过多，请稍后再试' } });
        return;
      }
      const v = store.verifyAdminPassword(uname, password);
      if (!v.ok) {
        adminAuth.rateRecordFailure(req, uname);
        logger.log('warn', 'auth', `管理页登录失败: ${uname}`);
        util.sendJson(res, 401, { error: { message: '用户名或密码错误' } });
        return;
      }
      adminAuth.rateReset(req, uname);
      const ua = String(req.headers['user-agent'] || '');
      const ip = adminAuth.clientIp(req);
      const sess = store.createAdminSession(uname, { userAgent: ua, ip });
      const cookie = adminAuth.cookieString(config.ADMIN_COOKIE, sess.token, { expiresAt: sess.expiresAt });
      res.setHeader('Set-Cookie', cookie);
      logger.log('info', 'auth', `管理页登录成功: ${uname}`);
      util.sendJson(res, 200, { ok: true, mustChange: v.mustChange, expiresAt: sess.expiresAt });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `登录失败: ${e.message}` } });
    }
    return;
  }

  if (pathname === '/api/admin/logout' && (method === 'POST' || method === 'GET')) {
    const token = adminAuth.extractToken(req);
    if (token) store.revokeAdminSession(token);
    const cookie = adminAuth.cookieString(config.ADMIN_COOKIE, '', { expiresAt: 0 });
    res.setHeader('Set-Cookie', cookie);
    logger.log('info', 'auth', '管理页已退出登录');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/admin/change-password' && method === 'POST') {
    const v = adminAuth.verifySession(req);
    if (!v.ok) { util.sendJson(res, 401, { error: { message: '未登录或会话已失效', type: 'admin_auth_required' } }); return; }
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const next = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!next || next.length < 8) { util.sendJson(res, 400, { error: { message: '新密码至少 8 位' } }); return; }
      if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) { util.sendJson(res, 400, { error: { message: '新密码需同时包含字母和数字' } }); return; }
      const cur = store.verifyAdminPassword(v.username, current);
      if (!cur.ok) { util.sendJson(res, 400, { error: { message: '当前密码错误' } }); return; }
      store.setAdminPassword(v.username, next, { mustChange: false });
      logger.log('info', 'auth', `管理页密码已修改: ${v.username}`);
      util.sendJson(res, 200, { ok: true });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `修改失败: ${e.message}` } });
    }
    return;
  }

  /* ---- 健康检查 ---- */
  if (pathname === '/health') { util.sendJson(res, 200, { ok: true, loggedIn: sessionMod.isLoggedIn() }); return; }

  /* ---- 状态 ---- */
  if (pathname === '/api/status') { util.sendJson(res, 200, statusObject()); return; }

  /* ---- 系统配置 ---- */
  if (pathname === '/api/config' && method === 'GET') { util.sendJson(res, 200, configResponse()); return; }
  if (pathname === '/api/config' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = store.applyPublicPatch(body);
      if (!Object.keys(patch).length) { util.sendJson(res, 400, { error: { message: '没有可更新的配置项' } }); return; }
      store.setConfig(patch);
      logger.log('info', 'config', `配置已更新: ${Object.keys(patch).join(', ')}`, patch);
      util.sendJson(res, 200, configResponse());
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `配置更新失败: ${e.message}` } });
    }
    return;
  }

  /* ---- API 密钥管理 ---- */
  if (pathname === '/api/keys' && method === 'GET') {
    util.sendJson(res, 200, { keys: store.listApiKeysPublic(), enabled: store.clientKeyVerificationEnabled() });
    return;
  }
  if (pathname === '/api/keys' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.addApiKey({ name: body && body.name, key: body && body.key, accountId: body && body.accountId });
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增 API 密钥: ${r.key.name}`);
      util.sendJson(res, 200, { key: r.key });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增密钥失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/keys/') && method === 'PUT') {
    const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const accountId = (body && body.accountId !== undefined) ? String(body.accountId).trim() : '';
      const r = store.setApiKeyAccount(id, accountId);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `API 密钥账号已更新: ${r.key.name} -> ${accountId || '(账号池)'}`);
      util.sendJson(res, 200, { key: r.key });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `更新密钥账号失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/keys/regenerate/') && method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/api/keys/regenerate/'.length));
    const r = store.regenerateApiKey(id);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    logger.log('info', 'config', `重新生成 API 密钥: ${r.key.name}`);
    util.sendJson(res, 200, { key: r.key });
    return;
  }
  if (pathname.startsWith('/api/keys/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
    const r = store.removeApiKey(id);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    logger.log('info', 'config', `删除 API 密钥: ${id}`);
    util.sendJson(res, 200, { ok: true, id });
    return;
  }

  /* ---- 日志 ---- */
  if (pathname === '/api/logs' && method === 'GET') {
    const q = {
      level: u.searchParams.get('level') || '',
      category: u.searchParams.get('category') || '',
      q: u.searchParams.get('q') || '',
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
      limit: u.searchParams.get('limit') || '100',
      offset: u.searchParams.get('offset') || '0',
    };
    util.sendJson(res, 200, store.queryLogs(q));
    return;
  }
  if (pathname === '/api/logs' && method === 'DELETE') {
    store.clearLogs();
    logger.log('info', 'system', '日志已清空');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  /* ---- 日志统计 ---- */
  if (pathname === '/api/stats') {
    const s = store.stats();
    s.usage = store.usageTotals();
    util.sendJson(res, 200, s);
    return;
  }

  /* ---- 用量记录 ---- */
  if (pathname === '/api/usage' && method === 'GET') {
    const q = {
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
      accountId: u.searchParams.get('accountId') || '',
      apiKeyId: u.searchParams.get('apiKeyId') || '',
      model: u.searchParams.get('model') || '',
      status: u.searchParams.get('status') || '',
      limit: u.searchParams.get('limit') || '50',
      offset: u.searchParams.get('offset') || '0',
    };
    util.sendJson(res, 200, store.queryUsage(q));
    return;
  }
  if (pathname === '/api/usage/stats' && method === 'GET') {
    const dimension = u.searchParams.get('dimension') === 'apiKey' ? 'apiKey' : 'account';
    const result = store.usageStatsByDay({
      dimension,
      from: u.searchParams.get('from') || '',
      to: u.searchParams.get('to') || '',
    });
    util.sendJson(res, 200, { dimension, ...result, totals: store.usageTotals() });
    return;
  }

  /* ---- 从 VSCode 导入登录态 ---- */
  if (pathname === '/api/import-vscode') {
    // 已添加过（来源为 vscode）则不再重复导入
    if (sessionMod.listAccounts().some(function (a) { return a.source === 'vscode'; })) {
      util.sendJson(res, 200, { ok: false, alreadyAdded: true, error: '已从 VSCode 插件读取过账号，无需重复导入' });
      return;
    }
    const r = vscode.readVscodeSession();
    if (r && r.session) {
      const acct = sessionMod.addAccount({
        name: '',
        source: 'vscode',
        addedBy: 'vscode',
        account: r.session.account,
        auth: r.session.auth,
        accounts: r.session.accounts || [],
        lastUsedAt: 0,
        useCount: 0,
        createdAt: Date.now(),
      });
      logger.log('info', 'auth', `已从 VSCode (${r.source}) 导入登录态，策略: ${r.strategy}`);
      util.sendJson(res, 200, { ok: true, source: r.source, strategy: r.strategy, account: acct ? acct.account : null });
    } else {
      util.sendJson(res, 200, { ok: false, error: '未能在 VSCode 中找到有效的 CodeBuddy 登录态' });
    }
    return;
  }

  /* ---- 会话 ---- */
  if (pathname === '/session') {
    if (!sessionMod.isLoggedIn()) { util.sendJson(res, 401, { error: { message: '未登录', type: 'authentication_error' } }); return; }
    util.sendJson(res, 200, statusObject());
    return;
  }

  /* ---- 登录 ---- */
  if (pathname === '/login/state' && method === 'GET') {
    try {
      const data = await auth.fetchAuthState();
      const name = u.searchParams.get('name') || '';
      auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now(), name });
      auth.completeLogin(data.state, name);
      util.sendJson(res, 200, { state: data.state, authUrl: data.authUrl });
    } catch (e) { util.sendJson(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/login/status' && method === 'GET') {
    const state = u.searchParams.get('state');
    if (!state) { util.sendJson(res, 400, { error: '缺少 state 参数' }); return; }
    const entry = auth.pendingLogins.get(state);
    if (!entry) { util.sendJson(res, 404, { error: '未知 state' }); return; }
    if (entry.status === 'success') { util.sendJson(res, 200, { status: 'success', accountId: entry.accountId, account: entry.account }); auth.pendingLogins.delete(state); return; }
    if (entry.status === 'error') { util.sendJson(res, 200, { status: 'error', error: entry.error }); auth.pendingLogins.delete(state); return; }
    if (Date.now() - entry.startedAt > config.LOGIN_TIMEOUT_MS) { entry.status = 'timeout'; util.sendJson(res, 200, { status: 'timeout', error: '登录超时' }); auth.pendingLogins.delete(state); return; }
    util.sendJson(res, 200, { status: 'pending' });
    return;
  }

  if (pathname === '/api/logout' && (method === 'POST' || method === 'GET')) {
    sessionMod.clearSession();
    logger.log('info', 'auth', '已退出登录');
    util.sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/logout' && (method === 'GET' || method === 'POST')) {
    sessionMod.clearSession();
    logger.log('info', 'auth', '已退出登录');
    res.writeHead(302, { Location: '/home' });
    res.end();
    return;
  }

  /* ---- 账号池管理 ---- */
  if (pathname === '/api/accounts' && method === 'GET') {
    // 可选 ?provider=traework 只看某渠道；缺省返回全部渠道
    util.sendJson(res, 200, accountsPayload(u.searchParams.get('provider') || undefined));
    return;
  }

  if (pathname === '/api/accounts' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      if (body.autoCheckin === undefined) {
        util.sendJson(res, 400, { error: { message: '没有可更新的字段' } });
        return;
      }
      const on = parseBoolFlag(body.autoCheckin);
      store.setAutoCheckinEnabled(on);
      const accounts = sessionMod.listAccounts();
      for (const acct of accounts) {
        try { sessionMod.updateAccount(acct.id, { autoCheckin: on }); } catch (e) { /* ignore */ }
      }
      logger.log('info', 'config', '全局自动签到已' + (on ? '开启' : '关闭'));
      if (on) {
        try { await checkinScheduler.tick(); } catch (e) { /* ignore */ }
      }
      util.sendJson(res, 200, accountsPayload());
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新失败: ' + e.message } });
    }
    return;
  }

  if (pathname === '/api/accounts/login' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
      // channel 指定走哪个渠道的登录流程；缺省 = 默认渠道（CodeBuddy，保持旧行为）
      const kind = (body && typeof body.channel === 'string' && body.channel.trim()) ? body.channel.trim() : providers.defaultKind();
      const provider = providers.getProvider(kind);
      if (!provider) { util.sendJson(res, 400, { error: { message: `未知渠道: ${kind}` } }); return; }

      // Trae 等渠道自带 login 编排（PKCE + 本地随机端口回调）
      if (provider.login && typeof provider.login.start === 'function') {
        const { state, authUrl } = await provider.login.start();
        util.sendJson(res, 200, { state, authUrl, name, channel: kind });
        return;
      }

      const data = await auth.fetchAuthState();
      auth.pendingLogins.set(data.state, { status: 'pending', startedAt: Date.now(), name, channel: kind });
      auth.completeLogin(data.state, name);
      util.sendJson(res, 200, { state: data.state, authUrl: data.authUrl, name, channel: kind });
    } catch (e) { util.sendJson(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/api/accounts/login/status' && method === 'GET') {
    const state = u.searchParams.get('state');
    if (!state) { util.sendJson(res, 400, { error: '缺少 state 参数' }); return; }
    // 先查渠道自带的登录编排（如 Trae 的 PKCE 流程会自己持有 pending 表）
    for (const provider of providers.listProviders()) {
      if (!provider.login || typeof provider.login.status !== 'function') continue;
      const st = provider.login.status(state);
      if (st && st.status !== 'unknown') {
        if (st.status === 'success') {
          // 登录成功后把账号写入账号池
          const acct = sessionMod.addAccount(st.account);
          if (!acct) { util.sendJson(res, 200, { status: 'error', error: '账号写入失败' }); return; }
          logger.log('info', 'auth', `[${provider.label}] 账号已加入账号池: ${acct.name || (acct.account && acct.account.uid)}`);
          util.sendJson(res, 200, { status: 'success', accountId: acct.id, account: accountPublic(acct) });
          return;
        }
        util.sendJson(res, 200, { status: st.status, error: st.error });
        return;
      }
    }
    const entry = auth.pendingLogins.get(state);
    if (!entry) { util.sendJson(res, 404, { error: '未知 state' }); return; }
    if (entry.status === 'success') { util.sendJson(res, 200, { status: 'success', accountId: entry.accountId, account: entry.account }); auth.pendingLogins.delete(state); return; }
    if (entry.status === 'error') { util.sendJson(res, 200, { status: 'error', error: entry.error }); auth.pendingLogins.delete(state); return; }
    if (Date.now() - entry.startedAt > config.LOGIN_TIMEOUT_MS) { entry.status = 'timeout'; util.sendJson(res, 200, { status: 'timeout', error: '登录超时' }); auth.pendingLogins.delete(state); return; }
    util.sendJson(res, 200, { status: 'pending' });
    return;
  }

  if (pathname === '/api/accounts/login/cancel' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const state = (body && typeof body.state === 'string') ? body.state : '';
      if (state) {
        for (const provider of providers.listProviders()) {
          if (provider.login && typeof provider.login.cancel === 'function') provider.login.cancel(state);
        }
        auth.pendingLogins.delete(state);
      }
      util.sendJson(res, 200, { ok: true });
    } catch (e) { util.sendJson(res, 400, { error: { message: e.message } }); }
    return;
  }

  if (pathname === '/api/accounts/import' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const refreshToken = (body && typeof body.refreshToken === 'string') ? body.refreshToken.trim() : '';
      const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
      const domain = (body && typeof body.domain === 'string') ? body.domain.trim() : '';
      if (!refreshToken) { util.sendJson(res, 400, { error: { message: 'refreshToken 不能为空' } }); return; }
      const acct = await auth.importByRefreshToken(refreshToken, name, domain);
      util.sendJson(res, 200, { account: accountPublic(acct) });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '导入失败: ' + e.message } });
    }
    return;
  }

  if (pathname === '/api/pool' && method === 'GET') {
    // 不传 provider 时返回全部渠道的池配置（管理页按渠道分别展示）
    const kind = u.searchParams.get('provider');
    if (kind) { util.sendJson(res, 200, sessionMod.getPoolConfig(kind)); return; }
    const all = {};
    for (const k of providers.providerKinds()) all[k] = sessionMod.getPoolConfig(k);
    util.sendJson(res, 200, all);
    return;
  }
  if (pathname === '/api/pool' && method === 'PUT') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = {};
      if (body.mode === 'pool' || body.mode === 'pinned') patch.mode = body.mode;
      if (typeof body.strategy === 'string' && body.strategy) patch.strategy = body.strategy;
      if (body.pinnedId !== undefined) patch.pinnedId = body.pinnedId || null;
      const kind = (typeof body.provider === 'string' && body.provider.trim()) ? body.provider.trim() : undefined;
      const pool = sessionMod.setPoolConfig(patch, kind);
      logger.log('info', 'config', `账号池配置已更新（${kind || '默认渠道'}）`, pool);
      util.sendJson(res, 200, pool);
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新失败: ' + e.message } });
    }
    return;
  }

  if (pathname.startsWith('/api/accounts/') && method === 'PUT' && !pathname.includes('/login')) {
    const id = decodeURIComponent(pathname.slice('/api/accounts/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const patch = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) { util.sendJson(res, 400, { error: { message: 'name 不能为空' } }); return; }
        patch.name = body.name;
      }
      if (body.autoCheckin !== undefined) patch.autoCheckin = body.autoCheckin === true || body.autoCheckin === 'true' || body.autoCheckin === 1 || body.autoCheckin === '1';
      if (!Object.keys(patch).length) { util.sendJson(res, 400, { error: { message: '没有可更新的字段' } }); return; }
      const acct = sessionMod.updateAccount(id, patch);
      if (!acct) { util.sendJson(res, 404, { error: { message: '未找到该账号' } }); return; }
      if (patch.name) logger.log('info', 'config', '账号已重命名: ' + acct.name);
      if (patch.autoCheckin !== undefined) logger.log('info', 'config', '账号自动签到已' + (patch.autoCheckin ? '开启' : '关闭') + ': ' + acct.name);
      util.sendJson(res, 200, accountPublic(acct));
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新账号失败: ' + e.message } });
    }
    return;
  }

  if (pathname.startsWith('/api/accounts/') && method === 'DELETE' && !pathname.includes('/login')) {
    const id = decodeURIComponent(pathname.slice('/api/accounts/'.length));
    const removed = sessionMod.removeAccount(id);
    if (!removed) { util.sendJson(res, 404, { error: { message: '未找到该账号' } }); return; }
    logger.log('info', 'auth', '账号已删除: ' + id);
    util.sendJson(res, 200, { ok: true, id });
    return;
  }

  /* ---- 每日签到（可指定账号） ---- */
  if (pathname === '/api/checkin/status' && method === 'GET') {
    try {
      const accountId = u.searchParams.get('accountId') || '';
      const r = await checkin.checkinStatus(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '查询签到状态失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '查询签到状态失败: ' + e.message } });
    }
    return;
  }
  if (pathname === '/api/checkin' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const accountId = (body && typeof body.accountId === 'string' && body.accountId) ? body.accountId : '';
      const r = await checkin.dailyCheckin(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '签到失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '签到失败: ' + e.message } });
    }
    return;
  }

  /* ---- 积分余额（可指定账号） ---- */
  if (pathname === '/api/credits' && method === 'GET') {
    try {
      const accountId = u.searchParams.get('accountId') || '';
      const r = await credits.getCredits(accountId);
      if (!r.ok) { util.sendJson(res, 502, { error: { message: r.error || '查询积分余额失败' } }); return; }
      util.sendJson(res, 200, r);
    } catch (e) {
      const status = e && e.status === 404 ? 404 : 502;
      util.sendJson(res, status, { error: { message: '查询积分余额失败: ' + e.message } });
    }
    return;
  }

  /* ---- 模型列表（内置 + 自定义合并） ---- */
  if (pathname === '/v1/models') {
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, keyCheck.rateLimited ? 429 : 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
    // 异步刷新自定义 endpoint 上游 /models（fire-and-forget，不阻塞返回）
    models.refreshCustomApiModels().catch(() => {});
    const customProvider = providers.getProvider('openai-custom');
    const base = modelsResponseForLoggedInProviders();
    const extras = models.customApiModelEntries(store, customProvider);
    base.data = base.data.concat(extras);
    util.sendJson(res, 200, base);
    return;
  }
  if (pathname === '/models' && method === 'GET') {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) { serveIndex(res); return; }
    const keyCheck = auth.verifyClientKey(req);
    if (!keyCheck.ok) { util.sendJson(res, keyCheck.rateLimited ? 429 : 401, { error: { message: keyCheck.message, type: 'authentication_error' } }); return; }
    // 异步刷新自定义 endpoint 上游 /models（fire-and-forget，不阻塞返回）
    models.refreshCustomApiModels().catch(() => {});
    const customProvider = providers.getProvider('openai-custom');
    const base = models.modelsResponse(store.listModels(), store.getHiddenModels(), modelCache.extraModelsForAllProviders());
    base.data = base.data.concat(models.customApiModelEntries(store, customProvider));
    util.sendJson(res, 200, base);
    return;
  }

  /* ---- 自定义模型管理 API ---- */
  if (pathname === '/api/models' && method === 'GET') {
    // 先刷新自定义 endpoint 的上游模型（带缓存，首次稍慢），再合并展示
    await models.refreshCustomApiModels();
    const all = models.allModels(store.listModels(), store.getHiddenModels(), modelCache.extraModelsForAllProviders());
    // 合并自定义 OpenAI 兼容 endpoint 的模型（按 endpoint 维度归类到 openai-custom 渠道）
    const customProvider = providers.getProvider('openai-custom');
    const custom = models.customApiModelsForManage(store, customProvider);
    util.sendJson(res, 200, { models: all.concat(custom) });
    return;
  }
  if (pathname === '/api/models' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.addModel(body);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增自定义模型: ${r.model.id}`, r.model);
      util.sendJson(res, 200, { model: r.model });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增模型失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/models/') && method === 'DELETE') {
    // 对外 id 可能带渠道前缀（traework/xxx），拆出 provider 精确定位
    const rawId = decodeURIComponent(pathname.slice('/api/models/'.length));
    const { kind, model } = providers.resolveModel(rawId);
    const hasPrefix = rawId !== model;
    const r = store.removeModel(model, hasPrefix ? kind : undefined);
    if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
    if (!r.deleted) { util.sendJson(res, 404, { error: { message: '未找到该模型' } }); return; }
    logger.log('info', 'config', `删除自定义模型: ${rawId}`);
    util.sendJson(res, 200, { ok: true, id: rawId });
    return;
  }
  if (pathname.startsWith('/api/models/') && method === 'PUT' && pathname.endsWith('/hidden')) {
    const id = decodeURIComponent(pathname.slice('/api/models/'.length, -'/hidden'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const hidden = body && (body.hidden === true || body.hidden === 'true' || body.hidden === 1 || body.hidden === '1');
      const r = store.setModelHidden(id, hidden);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', (hidden ? '隐藏模型: ' : '显示模型: ') + id);
      util.sendJson(res, 200, { ok: true, id, hidden });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: '更新模型隐藏状态失败: ' + e.message } });
    }
    return;
  }

  /* ---- 自定义 OpenAI 兼容 API 管理 ---- */
  if (pathname === '/api/custom-apis' && method === 'GET') {
    // 刷新上游模型（带缓存，首次稍慢），使列表里的模型计数准确
    await models.refreshCustomApiModels();
    const customProvider = providers.getProvider('openai-custom');
    const list = store.listCustomApis().map((e) => {
      const { apiKey, ...rest } = e;
      const modelCount = (e.models && e.models.length)
        ? e.models.length
        : (customProvider && typeof customProvider.getCachedModelCount === 'function'
          ? customProvider.getCachedModelCount(e.id) : 0);
      return { ...rest, apiKeyMasked: apiKey ? (apiKey.length <= 8 ? '***' : apiKey.slice(0, 6) + '…' + apiKey.slice(-4)) : '', modelCount };
    });
    util.sendJson(res, 200, { apis: list });
    return;
  }
  if (pathname === '/api/custom-apis' && method === 'POST') {
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.addCustomApi(body);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `新增自定义 API: ${r.api.name} (${r.api.modelPrefix})`);
      util.sendJson(res, 200, { api: r.api });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `新增自定义 API 失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/custom-apis/') && method === 'PUT') {
    const id = decodeURIComponent(pathname.slice('/api/custom-apis/'.length));
    try {
      const buf = await util.readBody(req);
      const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      const r = store.updateCustomApi(id, body);
      if (r.error) { util.sendJson(res, 400, { error: { message: r.error } }); return; }
      logger.log('info', 'config', `更新自定义 API: ${id}`);
      util.sendJson(res, 200, { api: r.api });
    } catch (e) {
      util.sendJson(res, 400, { error: { message: `更新自定义 API 失败: ${e.message}` } });
    }
    return;
  }
  if (pathname.startsWith('/api/custom-apis/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/custom-apis/'.length));
    const r = store.removeCustomApi(id);
    if (!r.deleted) { util.sendJson(res, 404, { error: { message: '未找到该自定义 API' } }); return; }
    logger.log('info', 'config', `删除自定义 API: ${id}`);
    util.sendJson(res, 200, { ok: true, id });
    return;
  }
  if (pathname.startsWith('/api/custom-apis/') && pathname.endsWith('/test') && method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/api/custom-apis/'.length, -'/test'.length));
    const ep = store.customApiById(id);
    if (!ep) { util.sendJson(res, 404, { error: { message: '未找到该自定义 API' } }); return; }
    try {
      const r = await util.requestJson(ep.baseUrl + '/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + ep.apiKey, Accept: 'application/json' },
        timeoutMs: 15000,
      });
      const ok = r.status >= 200 && r.status < 300;
      const arr = r.json && r.json.data;
      util.sendJson(res, ok ? 200 : 502, {
        ok,
        status: r.status,
        modelCount: Array.isArray(arr) ? arr.length : 0,
        error: ok ? undefined : (r.json && (r.json.error && r.json.error.message) || String(r.body || '').slice(0, 200)),
      });
    } catch (e) {
      util.sendJson(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  /* ---- Responses API ---- */
  if (method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) { await responses.handleResponses(req, res); return; }

  /* ---- OpenAI 兼容转发 ---- */
  if (method === 'POST' && openai.UPSTREAM_MAP[pathname]) { await openai.handleProxy(req, res, pathname); return; }

  /* ---- 静态资源 / SPA（仅 GET，且不拦截 API / 代理路径） ---- */
  if (method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/v1/') && !pathname.startsWith('/v2/')) {
    serveDist(res, pathname);
    return;
  }

  util.sendJson(res, 404, { error: { message: `Not Found: ${method} ${pathname}` } });
}

module.exports = { route, statusObject };