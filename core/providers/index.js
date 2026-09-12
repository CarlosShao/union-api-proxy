'use strict';

/**
 * Provider 注册表：多渠道（CodeBuddy / Trae CN / …）的统一抽象。
 *
 * 设计要点
 * --------
 * 1. **kind 即模型前缀**：`traework/glm-5.2` 中的 `traework` 就是 kind；无前缀的模型
 *    解析为默认渠道（codebuddy），保证旧客户端零改动。
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

/** 默认渠道：无前缀模型归属此渠道。可用 UNION_DEFAULT_PROVIDER 覆盖。 */
function defaultKind() {
  const k = process.env.UNION_DEFAULT_PROVIDER || process.env.CODEBUDDY_DEFAULT_PROVIDER || 'codebuddy';
  return registry.has(k) ? k : 'codebuddy';
}

/**
 * 解析模型串 -> { provider, kind, model }。
 *   'glm-5.2'            -> codebuddy/glm-5.2（无前缀 = 默认渠道，向后兼容）
 *   'workbuddy/glm-5.2'  -> codebuddy/glm-5.2（显式别名）
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
      // 渠道标识不区分大小写（用户可能从别处复制来大写写法）
      const lower = head.toLowerCase();
      if (registry.has(lower)) return { provider: lower, kind: lower, model: rest };
      // 别名：workbuddy 指向 codebuddy
      if (lower === 'workbuddy' && registry.has('codebuddy')) {
        return { provider: 'codebuddy', kind: 'codebuddy', model: rest };
      }
    }
  }
  return { provider: def, kind: def, model: cleaned };
}

/** 渠道显示名（用于日志/管理页） */
function labelOf(kind) {
  const p = registry.get(kind);
  return p ? (p.label || kind) : kind;
}

/** 对外模型 id = kind + '/' + 裸模型 id */
function modelIdOf(kind, id) {
  return kind + '/' + id;
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
  defaultKind, resolveModel, labelOf, modelIdOf, staticModelsByProvider,
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
