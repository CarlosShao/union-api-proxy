'use strict';

/**
 * Trae CN 登录：PKCE + 本地随机端口回调。
 *
 * 与 CodeBuddy 的差异：
 *  - 官方客户端回调固定打 127.0.0.1，但**端口可自定义**；这里监听 127.0.0.1:0
 *    （由操作系统分配空闲端口），因此不会与官方客户端的 18080 冲突。
 *  - 凭证有四级回退：refreshToken -> userJwt.RefreshToken -> userJwt.Token -> authCodeInfo.AuthCode
 *  - 新版走 PKCE（AuthCode + code_verifier + 设备公钥）换 token
 */

const http = require('http');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const util = require('../../util');
const logger = require('../../logger');
const C = require('./constants');
const { OAuthHeaders } = require('./headers');
const client = require('./client');

/** 进行中的登录：state(随机) -> 回调服务器上下文 */
const pending = new Map();
const LOGIN_TTL_MS = 5 * 60 * 1000;

function randHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

/** 真实客户端 device_id 为 15 位数字 */
function randNumericId() {
  let s = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 14; i++) s += String(crypto.randomInt(0, 10));
  return s;
}

/** 32 字节十六进制 machineId（与官方客户端 telemetry machineId 同形） */
function randMachineId() { return randHex(32); }

/** PKCE：code_verifier 需与登录 URL 配对保存，换 AuthCode 时回传 */
function genPKCE() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * 解析回调 URL / 查询参数，提取凭证（四级回退）。
 * 形如：http://127.0.0.1:PORT/authorize?refreshToken=...&userInfo={...}&userJwt={...}
 * 新流程：?authCodeInfo={"AuthCode":...}&host=...
 */
function parseCallback(rawUrl) {
  const out = { refreshToken: '', accessToken: '', authCode: '', host: '', uid: '', nickname: '', enterpriseId: '' };
  const text = String(rawUrl || '').trim();
  if (!text) return out;

  let q;
  try {
    q = new URL(text).searchParams;
  } catch {
    // 允许直接粘贴 query 串
    q = new URLSearchParams(text.replace(/^\?/, ''));
  }

  const tryJson = (v) => {
    if (!v) return null;
    for (const candidate of [v, safeDecode(v)]) {
      try {
        const o = JSON.parse(candidate);
        if (o && typeof o === 'object') return o;
      } catch { /* 继续尝试下一层解码 */ }
    }
    return null;
  };

  out.host = q.get('host') || '';

  const userInfo = tryJson(q.get('userInfo'));
  if (userInfo) {
    out.uid = userInfo.UserID || userInfo.userId || userInfo.uid || '';
    out.nickname = userInfo.ScreenName || userInfo.screenName || userInfo.nickname || '';
    out.enterpriseId = userInfo.TenantID || userInfo.EnterpriseID || userInfo.enterpriseId || '';
  }

  // 1) 直接给 refreshToken
  out.refreshToken = q.get('refreshToken') || '';
  if (out.refreshToken) return out;

  // 2) userJwt 里找
  const userJwt = tryJson(q.get('userJwt'));
  if (userJwt) {
    out.refreshToken = userJwt.RefreshToken || userJwt.refreshToken || '';
    if (out.refreshToken) return out;
    // 3) 兜底：userJwt 的 Token 直接当 accessToken（本轮可用，但无法刷新）
    out.accessToken = userJwt.Token || userJwt.token || userJwt.AccessToken || '';
    if (out.accessToken) return out;
  }

  // 4) PKCE 新流程
  const codeInfo = tryJson(q.get('authCodeInfo'));
  if (codeInfo) out.authCode = codeInfo.AuthCode || codeInfo.authCode || '';
  return out;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** AuthCode + code_verifier + 设备公钥 换取 token */
async function exchangeAuthCode(state, authCode, codeVerifier, device) {
  const key = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const deviceInfo = {
    DeviceID: device.deviceId,
    MachineID: device.machineId,
    PlatformCode: 'SOLO_PC',
    DeviceType: 'PC',
    DeviceName: process.env.USERNAME || process.env.USER || 'PC',
    DeviceModel: C.DeviceBrand,
    ClientVersion: C.IdeVersion,
    DevicePublicKey: key.publicKey,
    DeviceBrand: C.DeviceBrand,
    DeviceCPU: '',
    OSInfo: 'windows',
    OSVersion: C.OSVersion,
  };
  const body = {
    ClientID: C.ClientID,
    AuthCode: authCode,
    CodeVerifier: codeVerifier,
    DeviceInfo: deviceInfo,
    IDEVersion: C.IdeVersion,
  };
  // 依次尝试候选 origin：回调 host 优先，再回退 api.trae.cn / api.trae.com.cn
  const origins = [];
  for (const h of [device.host, C.UgHost, C.OAuthHost]) {
    const v = (h || '').replace(/\/+$/, '');
    if (v && !origins.includes(v)) origins.push(v);
  }
  let lastErr = '';
  for (const origin of origins) {
    try {
      const r = await util.requestJson(origin + C.EpAuthCodeExchange, {
        method: 'POST', headers: OAuthHeaders(), body, timeoutMs: 30000,
      });
      const parsed = pickToken(r.json);
      if (parsed.token) { parsed.host = origin; return parsed; }
      lastErr = `${origin} => ${JSON.stringify(r.json || r.body).slice(0, 160)}`;
    } catch (e) {
      lastErr = `${origin} => ${e.message}`;
    }
  }
  throw new Error('AuthCode 换取 token 失败: ' + lastErr);
}

/** 从各种响应包裹层里取 token（Result / result / data / 顶层） */
function pickToken(json) {
  const out = { token: '', refreshToken: '', expiresAt: 0 };
  if (!json || typeof json !== 'object') return out;
  for (const box of [json.Result, json.result, json.data, json]) {
    if (!box || typeof box !== 'object') continue;
    const token = box.AccessToken || box.accessToken || box.access_token || box.Token || box.token || '';
    if (!token) continue;
    out.token = token;
    out.refreshToken = box.RefreshToken || box.refreshToken || box.refresh_token || '';
    const exp = box.TokenExpireAt || box.tokenExpireAt || box.ExpiresAt || box.expiresAt || box.expiredAt || 0;
    out.expiresAt = client.normalizeExpiresAt(exp);
    break;
  }
  return out;
}

/** 发起登录：起本地回调服务，返回授权 URL 与 state */
async function start() {
  const machineId = randHex(32);
  const deviceId = randNumericId();
  const { verifier, challenge } = genPKCE();
  const state = randHex(16);

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const callbackUrl = `http://127.0.0.1:${port}/authorize`;

  const ctx = {
    machineId, deviceId, verifier, callbackUrl, server, status: 'pending',
    startedAt: Date.now(), error: '', account: null, host: '',
  };
  pending.set(state, ctx);

  server.on('request', (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (u.pathname !== '/authorize') { res.writeHead(404); res.end(); return; }
    const parsed = parseCallback(u.toString());
    ctx.host = parsed.host || ctx.host;
    ctx.callback = parsed;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;padding:24px">Trae CN 登录已完成，可以关闭此页面。</body></html>');
    finishLogin(state).catch((e) => {
      ctx.status = 'error';
      ctx.error = e.message;
      logger.log('error', 'auth', '[Trae] 登录流程出错: ' + e.message);
    });
  });

  // 超时清理：避免回调服务与 pending 记录长期滞留
  ctx.timer = setTimeout(() => {
    if (ctx.status === 'pending') { ctx.status = 'timeout'; ctx.error = '登录超时'; }
    closeCtx(state);
  }, LOGIN_TTL_MS);
  if (ctx.timer.unref) ctx.timer.unref();

  const authUrl = buildAuthUrl({ callbackUrl, machineId, deviceId, challenge, state });
  logger.log('info', 'auth', `[Trae] 已发起登录，回调端口 ${port}`);
  return { state, authUrl };
}

/** 构造授权 URL（参数照搬官方客户端） */
function buildAuthUrl({ callbackUrl, machineId, deviceId, challenge, state }) {
  const u = new URL(C.ConsoleHost + '/authorization');
  const v = u.searchParams;
  v.set('login_version', '1');
  v.set('auth_from', 'solo');
  v.set('login_channel', 'native_ide');
  v.set('plugin_version', C.PluginVersion);
  v.set('auth_type', 'local');
  v.set('client_id', C.ClientID);
  v.set('redirect', '0');
  v.set('login_trace_id', state);
  v.set('auth_callback_url', callbackUrl);
  v.set('machine_id', machineId);
  v.set('device_id', deviceId);
  v.set('x_device_id', deviceId);
  v.set('x_machine_id', machineId);
  v.set('x_device_brand', C.DeviceBrand);
  v.set('x_device_type', 'windows');
  v.set('x_os_version', C.OSVersion);
  v.set('x_env', '');
  v.set('x_app_version', C.IdeVersion);
  v.set('x_app_type', 'stable');
  v.set('code_challenge', challenge);
  v.set('code_challenge_method', 'S256');
  v.set('hide_saas_login', 'true');
  v.set('channel_name', 'common');
  v.set('click_id', 'TRAE SOLOSetup-stable-' + C.PluginVersion);
  return u.toString();
}

/** 回调到达后换取凭证并落库所需的账号结构 */
async function finishLogin(state) {
  const ctx = pending.get(state);
  if (!ctx) throw new Error('未知的登录 state');
  const cb = ctx.callback || {};
  const device = { machineId: ctx.machineId, deviceId: ctx.deviceId, host: ctx.host || C.OAuthHost };

  let auth = {
    accessToken: cb.accessToken || '',
    refreshToken: cb.refreshToken || '',
    domain: 'trae.cn',
    apiHost: ctx.host || C.OAuthHost,
    machineId: ctx.machineId,
    deviceId: ctx.deviceId,
    lastRefreshTime: Date.now(),
  };

  if (!auth.accessToken && !auth.refreshToken && !cb.authCode) {
    throw new Error('回调中未找到任何凭证（refreshToken / userJwt / authCode 均为空）');
  }

  const acct = { auth, account: {}, name: '' };

  if (cb.authCode) {
    const res = await exchangeAuthCode(state, cb.authCode, ctx.verifier, device);
    auth = Object.assign(auth, {
      accessToken: res.token, refreshToken: res.refreshToken || '', expiresAt: res.expiresAt || 0,
      apiHost: res.host || auth.apiHost,
    });
    acct.auth = auth;
  } else if (auth.refreshToken) {
    acct.auth = auth;
    const next = await client.refreshToken(acct);
    acct.auth = next;
  } else {
    // 仅有 accessToken：本轮可用但无法自动续期
    logger.log('warn', 'auth', '[Trae] 回调仅提供 accessToken，无 refreshToken，之后需重新登录');
  }

  let info = { uid: cb.uid, nickname: cb.nickname, enterpriseId: cb.enterpriseId };
  try {
    const fetched = await client.getUserInfo(acct);
    info = {
      uid: fetched.uid || info.uid,
      nickname: fetched.nickname || info.nickname,
      enterpriseId: fetched.enterpriseId || info.enterpriseId,
    };
  } catch (e) {
    logger.log('warn', 'auth', '[Trae] 获取用户信息失败（沿用回调信息）: ' + e.message);
  }
  if (!info.uid) throw new Error('登录成功但未取到用户 ID');

  ctx.status = 'success';
  ctx.account = {
    provider: 'traework',
    name: '',
    source: 'oauth',
    addedBy: 'oauth',
    account: { uid: info.uid, nickname: info.nickname, type: 'personal', enterpriseId: info.enterpriseId || '' },
    auth: acct.auth,
    accounts: [],
    lastUsedAt: 0,
    useCount: 0,
    createdAt: Date.now(),
  };
  logger.log('info', 'auth', `[Trae] 登录成功: ${info.nickname || info.uid}`);
  // 收尾：回调已完成，关闭本地服务
  closeCtx(state);
  return ctx.account;
}

function closeCtx(state) {
  const ctx = pending.get(state);
  if (!ctx) return;
  if (ctx.timer) clearTimeout(ctx.timer);
  try { ctx.server.close(); } catch { /* 已关闭 */ }
}

/** 查询登录状态（前端轮询用） */
function status(state) {
  const ctx = pending.get(state);
  if (!ctx) return { status: 'unknown' };
  if (ctx.status === 'success') {
    const account = ctx.account;
    pending.delete(state);
    return { status: 'success', account };
  }
  if (ctx.status === 'error') { const e = ctx.error; pending.delete(state); return { status: 'error', error: e }; }
  if (ctx.status === 'timeout') { const e = ctx.error; pending.delete(state); return { status: 'timeout', error: e }; }
  if (Date.now() - ctx.startedAt > LOGIN_TTL_MS) {
    closeCtx(state); pending.delete(state);
    return { status: 'timeout', error: '登录超时' };
  }
  return { status: 'pending' };
}

function cancel(state) {
  const ctx = pending.get(state);
  if (ctx) closeCtx(state);
  pending.delete(state);
}

module.exports = { start, status, cancel, parseCallback, buildAuthUrl, genPKCE, pending, randNumericId, randMachineId };
