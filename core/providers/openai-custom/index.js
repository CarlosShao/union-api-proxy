'use strict';

/**
 * 自定义 OpenAI 兼容 API 渠道（endpoint 整站接入）。
 *
 * 与 codebuddy / traework 的根本区别：
 *  - 不需要登录态、不需要账号池；凭证（API Key）随 endpoint 配置一起存，请求时自带。
 *  - 上游就是一个标准 OpenAI 兼容服务（OpenRouter / xAI / 自建 vLLM / opencode / command / …）。
 *  - 转发目标 = baseUrl + '/chat/completions' 等，payload 原样透传（OpenAI 格式本身就是上游格式）。
 *
 * 因此本 provider 只做三件事：
 *  1. 把模型前缀解析出的 endpoint id 取回配置（baseUrl / apiKey）；
 *  2. 在请求头里塞 Authorization: Bearer <apiKey>；
 *  3. 流式直透上游的 OpenAI SSE，非流式聚合上游 SSE。
 *
 * 模型前缀：用户配的 modelPrefix（默认 oc）。外部模型 id 形如 `oc/gpt-4o`，
 * 解析到本 kind 后，裸模型名 `gpt-4o` 原样发给上游。
 */

const KIND = 'openai-custom';

let store = null;
function getStore() {
  if (!store) store = require('../../store');
  return store;
}

/** 按 endpoint 缓存动态模型：{ list: ModelInfo[], at: number } */
const modelsCache = new Map();
const MODELS_TTL_MS = 60 * 60 * 1000;
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;
/** 记录失败时间，避免不可达上游无限重试 */
const failAt = new Map();

function isCacheFresh(endpointId) {
  const c = modelsCache.get(endpointId);
  return c && (Date.now() - c.at < MODELS_TTL_MS);
}

function getCachedModels(endpointId) {
  const c = modelsCache.get(endpointId);
  return c ? c.list : [];
}

function getCachedModelCount(endpointId) {
  return getCachedModels(endpointId).length;
}

function getCachedModelsForEndpoint(endpointId) {
  return getCachedModels(endpointId);
}

function setCachedModels(endpointId, list) {
  modelsCache.set(endpointId, { list: Array.isArray(list) ? list : [], at: Date.now() });
  failAt.delete(endpointId);
}

function setFailed(endpointId) {
  failAt.set(endpointId, Date.now());
  const c = modelsCache.get(endpointId);
  if (c) c.at = 0; // 标记缓存过期，但保留 list 兜底
}

function shouldRefresh(endpointId) {
  if (isCacheFresh(endpointId)) return false;
  const f = failAt.get(endpointId) || 0;
  if (Date.now() - f < FAIL_COOLDOWN_MS) return false;
  return true;
}

/**
 * 从上游模型条目里挑出第一个有效的数值字段。
 * 各家 OpenAI 兼容服务的元数据命名不统一，这里兼容常见写法。
 */
function pickNumber(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  }
  return 0;
}

/** 解析布尔能力字段（同样兼容多种命名），缺省时给合理默认 */
function pickBool(obj, keys, dflt) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null) {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v === 'true' || v === '1';
      if (typeof v === 'number') return v !== 0;
    }
  }
  return dflt;
}

/** 把上游 /models 的一条记录映射为统一的 ModelInfo */
function toModelInfo(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    // 上下文/输出上限：兼容 context_length / context_window / max_input_tokens 等命名
    maxInputTokens: pickNumber(m, ['context_length', 'context_window', 'max_input_tokens', 'max_context_tokens', 'maxInputTokens']),
    maxOutputTokens: pickNumber(m, ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'maxOutputTokens']),
    // 能力：多数聚合服务会在 /models 里标注；没有则默认支持工具（绝大多数对话模型都支持）
    tools: pickBool(m, ['supports_tool_call', 'tools', 'supports_tools', 'function_calling'], true),
    vision: pickBool(m, ['supports_vision', 'vision', 'supports_images'], false),
    reasoning: pickBool(m, ['supports_reasoning', 'reasoning'], false),
  };
}

/** 异步拉取某个 endpoint 的上游 /models，并写入缓存。 */
async function refreshModelsForEndpoint(endpoint) {
  if (!endpoint || !endpoint.id) return [];
  if (!shouldRefresh(endpoint.id)) return getCachedModels(endpoint.id);
  const s = getStore();
  const util = require('../../util');
  const timeoutMs = s.getRequestTimeoutMs();
  try {
    const r = await util.requestJson(endpoint.baseUrl + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + endpoint.apiKey, Accept: 'application/json' },
      timeoutMs: Math.min(timeoutMs, 20000),
    });
    const arr = r.json && r.json.data;
    if (r.status >= 200 && r.status < 300 && Array.isArray(arr) && arr.length) {
      const list = arr.filter((m) => m && m.id).map(toModelInfo);
      setCachedModels(endpoint.id, list);
      return list;
    }
  } catch (e) {
    setFailed(endpoint.id);
  }
  return getCachedModels(endpoint.id);
}

/**
 * 触发所有启用 endpoint 的动态模型刷新（fire-and-forget，不阻塞调用方）。
 * /v1/models 会先发这个再读缓存；/api/models 会 await 它。
 */
function refreshAllModels() {
  const s = getStore();
  const list = s.listCustomApis().filter((e) => e.enabled);
  return Promise.allSettled(list.map(refreshModelsForEndpoint));
}

/** 该渠道自带凭证，无需账号池/登录 */
function isSelfCredential() { return true; }

/** 解析「模型前缀」对应的 endpoint 配置（前缀即 custom_apis.model_prefix） */
function endpointFor(modelPrefix) {
  const s = getStore();
  const list = s.listCustomApis();
  // 优先精确匹配 modelPrefix，其次匹配 id（如 capi_xxxx）
  let found = list.find((e) => e.enabled && e.modelPrefix === modelPrefix);
  if (!found) found = list.find((e) => e.enabled && e.id === modelPrefix);
  return found || null;
}

/** 兼容别名：openai.js 兜底时调用，按前缀定位 endpoint */
function lookupByModelPrefix(prefix) { return endpointFor(prefix); }

function staticModels() {
  // 无静态目录：模型由 /v1/models 动态返回（见 providers/modelCache 或路由层拼装）
  return [];
}

async function listModels(ep) {
  // ep 为 endpoint 配置对象（由路由层传入）
  const endpoint = ep && ep.baseUrl ? ep : null;
  if (!endpoint) return [];
  // 白名单优先：用户明确指定模型时直接返回（不依赖上游 /models，故无元数据）
  if (endpoint.models && endpoint.models.length) {
    return endpoint.models.map((id) => ({
      id, name: id, maxInputTokens: 0, maxOutputTokens: 0,
      tools: true, vision: false, reasoning: false,
    }));
  }
  // 未配置白名单：触发上游 /models 拉取（带缓存）。
  return refreshModelsForEndpoint(endpoint);
}

/** 取出某 endpoint 当前缓存的模型数量（给管理页列表“2 模型”展示） */
function cachedModelCount(endpoint) {
  return getCachedModelCount(endpoint && endpoint.id);
}

/** 请求体改写：OpenAI 兼容服务一般无需改写；仅剥离代理专用字段（accountId 等已在 openai.js 移除） */
function preparePayload(payload) { return payload; }

/** 构造上游请求头：自带 API Key */
function buildChatHeaders(ep) {
  const headers = {
    'Authorization': 'Bearer ' + (ep && ep.apiKey || ''),
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Requested-With': 'XMLHttpRequest',
  };
  return headers;
}

/** 上游聊天地址：baseUrl + 标准路径 */
function chatUrl(ep) {
  return (ep && ep.baseUrl || '') + '/chat/completions';
}

function embeddingsUrl(ep) {
  return (ep && ep.baseUrl || '') + '/embeddings';
}

function completionsUrl(ep) {
  return (ep && ep.baseUrl || '') + '/completions';
}

/** 非流式：上游已是标准 OpenAI SSE，聚合逻辑与通用一致 */
function aggregate(sseText) {
  return require('../../openai').aggregateSseToCompletion(sseText);
}

/** 流式：上游已是 OpenAI SSE，无需转换（util.pipeSseToClient 默认路径会做空字段剥离） */
function createSseConverter() { return null; }

function classifyError(status, body) {
  const text = String(body || '');
  if (status === 200) return { kind: 'none', fatal: false };
  if (status === 401 || status === 403) return { kind: 'session', fatal: false };
  if (status === 429) return { kind: 'rate', fatal: false };
  if (status === 404) return { kind: 'notfound', fatal: false };
  if (status >= 500) return { kind: 'server', fatal: false };
  if (status >= 400) return { kind: 'client', fatal: false };
  return { kind: 'none', fatal: false };
}

module.exports = {
  kind: KIND,
  label: 'OpenAI Compatible',
  description: '自定义 OpenAI 兼容 endpoint（OpenRouter / xAI / opencode / command / 自建等）',
  isSelfCredential,
  staticModels, listModels,
  preparePayload, buildChatHeaders, chatUrl, embeddingsUrl, completionsUrl,
  aggregate, createSseConverter, classifyError,
  // 扩展：供 openai.js 定位 endpoint
  endpointFor, lookupByModelPrefix,
  // 动态模型缓存（供 /v1/models 与 /api/models 使用）
  refreshAllModels, refreshModelsForEndpoint,
  getCachedModelCount, getCachedModelsForEndpoint, cachedModelCount,
};
