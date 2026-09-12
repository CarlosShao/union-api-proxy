'use strict';

/**
 * 静态配置：环境变量 + 默认值。
 * 运行时可动态修改的配置（日志开关、默认模型等）见 store.js。
 */

const os = require('os');
const path = require('path');
const { URL } = require('url');

/**
 * 读取环境变量：优先 UNION_* 前缀，其次兼容历史 CODEBUDDY_* 前缀，最后默认值。
 * 向后兼容既有启动命令（CODEBUDDY_PROXY_PORT 等继续生效）。
 */
function env(name, fallback) {
  const v = process.env['UNION_' + name];
  if (v !== undefined && v !== '') return v;
  const legacy = process.env['CODEBUDDY_' + name];
  if (legacy !== undefined && legacy !== '') return legacy;
  return fallback;
}

const PORT = parseInt(process.env.PORT || env('PROXY_PORT', '3800'), 10);
const HOST = process.env.HOST || env('PROXY_HOST', '127.0.0.1');

const ENDPOINT = (env('ENDPOINT', 'https://copilot.tencent.com')).replace(/\/+$/, '');
const PREFIX_PATH = env('PREFIX_PATH', '/plugin');
const PLATFORM = env('PLATFORM', 'VSCode');

const DATA_DIR = env('DATA_DIR', path.join(os.homedir(), '.union-api-proxy'));
const SESSION_FILE = env('SESSION_FILE', path.join(DATA_DIR, 'session.json'));
const DB_FILE = env('DB_FILE', path.join(DATA_DIR, 'proxy.db'));

const DIST_DIR = path.join(__dirname, '..', 'dist');

const ENDPOINT_HOST = (() => { try { return new URL(ENDPOINT).host; } catch { return 'copilot.tencent.com'; } })();

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 1000;
const REFRESH_AHEAD_MS = 60 * 1000;
/** 缺少 expiresAt 的账号在此时间内刷新过则视为 token 有效（避免每请求都触发刷新） */
const AUTH_FRESH_MS = 10 * 60 * 1000;

const VERSION = (() => {
  try { return require('../package.json').version || '1.0.0'; } catch { return '1.0.0'; }
})();

const ADMIN_USERNAME = env('ADMIN_USERNAME', 'admin');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD', '');

/**
 * 是否信任反向代理（如 Cloudflare / nginx）注入的 X-Forwarded-For。
 * 仅在确认服务只被受信代理访问时设为 true，否则限流/日志将信任客户端可伪造的 IP。
 * 取值：'true' | '1' 开启；其余（含空）关闭。
 */
const TRUST_PROXY = env('TRUST_PROXY', '') === 'true' || env('TRUST_PROXY', '') === '1';

/** 会话 Cookie 名称（HttpOnly，前端不可读） */
const ADMIN_COOKIE = 'cbp_admin';
/** 会话有效期（毫秒）：默认 30 天 */
const ADMIN_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 会话滑动续期阈值：剩余时间低于该值则自动续期 */
const ADMIN_SESSION_RENEW_MS = 24 * 3600 * 1000;
/** 密码哈希参数（scrypt）：N=16384, r=8, p=1（约 16MB 内存，Node 默认上限内） */
const ADMIN_SCRYPT = { N: 1 << 14, r: 8, p: 1, keyLen: 64 };

/**
 * 系统配置默认值（可被 DB 中的 config 表覆盖）。
 * 值统一存成字符串，读取处再做类型转换。
 */
const DEFAULT_CONFIG = {
  'logging.enabled': 'true',
  'logging.details': 'true',          // 是否记录请求摘要 / tokens / 耗时等详情
  'logging.level': 'info',            // debug | info | warn | error
  'logging.retentionDays': '7',       // 日志保留天数，0 = 永久
  'logging.maxRows': '10000',         // 日志条数上限，超出后删除最旧，0 = 不限制
  'autoOpen': env('NO_OPEN', '') ? 'false' : 'true',
  'defaultModel': env('DEFAULT_MODEL', 'default'),
  'forceModel': env('FORCE_MODEL', ''),
  'apiKeyEnabled': 'true',                            // 是否校验客户端访问 /v1 与 /responses 所需的 API 密钥
  'apiKey': env('API_KEY', ''),                       // 兼容旧版：单个 API 密钥（新实现优先使用 api_keys 表）
  'adminAuthEnabled': 'false',         // 是否开启管理页/管理接口鉴权（登录后访问）
  'requestTimeoutMs': '300000',       // 上游请求超时
  'cors.origin': '*',                 // CORS Allow-Origin
  'autoCheckin': 'true',              // 账号池全局自动签到开关（默认开启）
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const LOG_CATEGORIES = ['system', 'auth', 'proxy', 'responses', 'config'];

module.exports = {
  PORT, HOST, ENDPOINT, PREFIX_PATH, PLATFORM,
  DATA_DIR, SESSION_FILE, DB_FILE, DIST_DIR, ENDPOINT_HOST,
  LOGIN_TIMEOUT_MS, LOGIN_POLL_INTERVAL_MS, REFRESH_AHEAD_MS, AUTH_FRESH_MS,
  VERSION, DEFAULT_CONFIG, LOG_LEVELS, LOG_CATEGORIES,
  ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_COOKIE, TRUST_PROXY,
  ADMIN_SESSION_TTL_MS, ADMIN_SESSION_RENEW_MS, ADMIN_SCRYPT,
};
