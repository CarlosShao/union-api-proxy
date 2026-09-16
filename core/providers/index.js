'use strict';

/**
 * Provider 注册表：多渠道（CodeBuddy / Trae CN / …）的统一抽象。
 *
 * 设计要点
 * --------
 * 1. **kind 即渠道标识**：对外的模型短前缀（`cc/`、`tw/`）由 EXTERNAL_PREFIX 映射自
 *    kind；请求解析两种写法都接受。无前缀的模型解析为默认渠道（codebuddy），
 *    保证旧客户端零改动。
 * 2. **能力可选**：provider 只需实现自己支持的成员。路由/调度器用
 *    `typeof p.checkin === 'function'` 探测，未实现即视为该渠道不支持签到，
 *    而不是抛错。Trae 有签到、未来某渠道没有，就少写一个函数即可。
 * 3. **纯协议层**：provider 不读写数据库、不碰账号池；账号由调用方传入。
 *    持久化与选号留在 routes/session 层，避免渠道实现耦合存储细节。
 *
 * 新增渠道步骤：在 core/providers/<kind>/ 实现本文件底部注释中的接口，
 * 然后在 index.js 末尾 register() 一行即可，无需改动转发链路。
 */

const registry = new Map();

/** 注册一个 provider（重复注册同 kind 会覆盖，便于测试） */
function register(provider) {
  if (!provider || !provider.kind) throw new Error('provider.kind 不能为空');
  registry.set(provider.kind, provider);
  return provider;
}

function getProvider(kind) {
  return registry.get(kind) || null;
}

/** 全部已注册渠道（按注册顺序） */
function listProviders() {
  return Array.from(registry.values());
}

function providerKinds() {
  return Array.from(registry.keys());
}

/**
 * 自定义前缀解析器（动态）：供 openai-custom 渠道注册。
 * 给定前缀串，返回它归属的 kind（'openai-custom'）或 null。
 * 这样运行时新增/修改 endpoint 前缀时，resolveModel 无需重启即可识别。
 */
let customPrefixResolver = null;
function setCustomPrefixResolver(fn) { customPrefixResolver = typeof fn === 'function' ? fn : null; }
function resolveCustomPrefix(prefix) {
  if (!customPrefixResolver || !prefix) return null;
  try { return customPrefixResolver(String(prefix).toLowerCase()); } catch { return null; }
}

/** 默认渠道：无前缀模型归属此渠道。可用 UNION_DEFAULT_PROVIDER 覆盖。 */
function defaultKind() {
  const k = process.env.UNION_DEFAULT_PROVIDER || process.env.CODEBUDDY_DEFAULT_PROVIDER || 'codebuddy';
  return registry.has(k) ? k : 'codebuddy';
}

/**
 * 解析模型串 -> { provider, kind, model }。
 *   'glm-5.2'            -> codebuddy/glm-5.2（无前缀 = 默认渠道，向后兼容）
 *   'cc/glm-5.2'         -> codebuddy/glm-5.2（对外短前缀）
 *   'codebuddy/glm-5.2'  -> codebuddy/glm-5.2（内部 kind 写法，继续兼容）
 *   'workbuddy/glm-5.2'  -> codebuddy/glm-5.2（历史别名）
 *   'tc/glm-5.2'         -> traework/glm-5.2（对外短前缀；旧写法 tw/ 也兼容）
 *   'traework/glm-5.2'   -> traework/glm-5.2
 * 含 '/' 但首段不是已知渠道时，整个串当作模型名交给默认渠道（模型名本身可能含斜杠）。
 */
function resolveModel(modelStr) {
  const raw = typeof modelStr === 'string' ? modelStr.trim() : '';
  const def = defaultKind();
  if (!raw) return { provider: def, kind: def, model: '' };
  // 去掉前导斜杠等畸形写法（如 '/glm-5.2'），否则会原样发给上游导致参数错误
  const cleaned = raw.replace(/^\/+/, '');
  if (!cleaned) return { provider: def, kind: def, model: '' };
  const idx = cleaned.indexOf('/');
  if (idx > 0) {
    const head = cleaned.slice(0, idx);
    const rest = cleaned.slice(idx + 1);
    if (rest) {
      // 前缀不区分大小写（用户可能从别处复制来大写写法）
      const lower = head.toLowerCase();
      // 别名优先：对外短前缀 cc/tw 与历史别名 workbuddy -> 内部 kind
      const aliased = PREFIX_ALIASES[lower];
      if (aliased && registry.has(aliased)) return { provider: aliased, kind: aliased, model: rest };
      // 内部 kind 直接作前缀的写法（codebuddy/traework）继续可用
      if (registry.has(lower)) return { provider: lower, kind: lower, model: rest };
      // 自定义 OpenAI 兼容 endpoint 前缀（如 oc / 用户自定 / endpoint id），运行时动态解析
      const customKind = resolveCustomPrefix(lower);
      if (customKind && registry.has(customKind)) return { provider: customKind, kind: customKind, model: rest };
    }
  }
  return { provider: def, kind: def, model: cleaned };
}

/** 渠道显示名（用于日志/管理页） */
function labelOf(kind) {
  const p = registry.get(kind);
  return p ? (p.label || kind) : kind;
}

/**
 * 对外短前缀（用户可见）：cc=codebuddy、tc=traework。
 * 内部 kind 与 DB 的 provider 列保持原值不变，短前缀只用于对外 id 的展示与解析。
 */
const EXTERNAL_PREFIX = { codebuddy: 'cc', traework: 'tc' };

/** 请求侧前缀别名 -> 内部 kind（新短前缀、旧 tw 写法与历史写法都接受） */
const PREFIX_ALIASES = { cc: 'codebuddy', tc: 'traework', tw: 'traework', workbuddy: 'codebuddy' };

/** 内部 kind -> 对外短前缀（未登记的渠道原样返回，行为同旧版） */
function externalPrefixOf(kind) {
  return EXTERNAL_PREFIX[kind] || kind || '';
}

/** 对外模型 id = 短前缀 + '/' + 裸模型 id（如 cc/glm-5.2、tw/glm-5.3） */
function modelIdOf(kind, id) {
  return externalPrefixOf(kind) + '/' + id;
}

/**
 * 收集「默认渠道之外」各渠道的静态模型，供 models.allModels 合并。
 * 返回 { traework: [ModelInfo...] }；默认渠道的目录由 models.js 内置维护，不重复。
 */
function staticModelsByProvider() {
  const def = defaultKind();
  const out = {};
  for (const p of registry.values()) {
    if (p.kind === def) continue;
    if (typeof p.staticModels !== 'function') continue;
    try {
      const list = p.staticModels() || [];
      if (list.length) out[p.kind] = list;
    } catch { /* 单个渠道的静态表异常不应影响整体 */ }
  }
  return out;
}

module.exports = {
  register, getProvider, listProviders, providerKinds,
  defaultKind, resolveModel, labelOf, modelIdOf, externalPrefixOf, staticModelsByProvider,
  setCustomPrefixResolver, resolveCustomPrefix,
};

/* ------------------------------------------------------------------
 * Provider 接口（全部可选，按需实现）
 * ------------------------------------------------------------------
 * kind:            string  必填，渠道标识，同时是模型前缀
 * label:           string  管理页显示名，如 'Trae CN'
 * description:     string  可选说明
 *
 * -- 凭证 --
 * refreshToken(auth) -> auth        刷新 accessToken（返回新 auth 对象）
 * validateAuth(auth) -> boolean     可选：凭证是否可用
 *
 * -- 登录（可选，用于浏览器 OAuth 流程） --
 * login.start() -> { state, authUrl }    发起登录
 * login.poll(state) -> { status, ... }   轮询结果：pending | success | error
 * login.cancel(state) -> void
 *
 * -- 模型 --
 * staticModels() -> ModelInfo[]      同步兜底列表（上游拉取失败时用）
 * listModels(auth) -> Promise<ModelInfo[]>
 *   ModelInfo: { id, name, maxInputTokens, maxOutputTokens, tools, vision, reasoning }
 *
 * -- 聊天转发 --
 * preparePayload(payload) -> void            原地改写请求体（转成上游格式）
 * buildChatHeaders(auth, opts) -> object     构造上游请求头
 * chatUrl(auth) -> string                    上行地址
 * aggregate(sseText) -> completion           非流式：把上游 SSE 聚合成 chat.completion
 * createSseConverter() -> { feed(s), end() } 流式：上游 SSE -> OpenAI SSE 文本转换器
 *
 * -- 错误分类（可选） --
 * classifyError(status, body) -> { kind, fatal }
 *   kind: 'credit' | 'rate' | 'session' | 'server' | 'client' | 'none'
 *
 * -- 计费（可选） --
 * checkin(auth) -> Promise<{ ok, already?, credits? }>
 * checkinStatus(auth) -> Promise<{ checkedIn, credits, enable }>
 * credits(auth) -> Promise<{ used, left, total }>
 * creditDetail(auth) -> Promise<Array<{ name, total, used, remain }>>
 * ------------------------------------------------------------------ */
