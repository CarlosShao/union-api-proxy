'use strict';

/**
 * 模型目录与 /v1/models 响应。
 *
 * MODEL_CATALOG 是 **静态兜底表**，按 `GET /console/enterprises/personal/models`
 * 的实测返回维护（该接口随账号权益变化，运行时优先用动态拉取，见 providers/modelCache.js）。
 * 字段映射：supportsToolCall -> tools, supportsImages -> vision,
 *           supportsReasoning -> reasoning, maxInputTokens/maxOutputTokens 原样保留。
 *
 * 用户可在管理页新增的自定义模型存储于 SQLite（见 store.js），
 * 通过 allModels() 与内置目录合并后对外暴露。
 */

/** 对外短前缀（cc/tc）的映射来源；providers/index 不反向依赖本文件，无循环 */
const providers = require('./providers');

/** 内置兜底目录（实测自上游 models 接口，仅国内模型） */
const MODEL_CATALOG = [
  // —— 默认 / 自动 ——
  { id: 'auto', name: 'Auto', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn', isDefault: true },
  { id: 'default', name: 'Default', maxInputTokens: 200000, maxOutputTokens: 24000, tools: true, vision: false, reasoning: false, region: 'cn' },
  // —— 混元 ——
  { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hy3-x', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1000000, maxOutputTokens: 64000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hy4-preview-x', name: 'Hy4 preview', maxInputTokens: 1000000, maxOutputTokens: 64000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hunyuan-2.0-thinking', name: 'Hunyuan-2.0-Thinking', maxInputTokens: 128000, maxOutputTokens: 24000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', maxInputTokens: 200000, maxOutputTokens: 8192, tools: true, vision: false, reasoning: false, region: 'cn' },
  // —— GLM ——
  { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 48000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1000000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000, maxOutputTokens: 48000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200000, maxOutputTokens: 48000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'glm-5.0', name: 'GLM-5.0', maxInputTokens: 200000, maxOutputTokens: 48000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200000, maxOutputTokens: 64000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'glm-4.7', name: 'GLM-4.7', maxInputTokens: 200000, maxOutputTokens: 48000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-4.6', name: 'GLM-4.6', maxInputTokens: 168000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true, region: 'cn' },
  { id: 'glm-4.6v', name: 'GLM-4.6V', maxInputTokens: 128000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, region: 'cn' },
  // —— Kimi ——
  { id: 'kimi-k3-1', name: 'Kimi-K3', maxInputTokens: 1000000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', maxInputTokens: 1000000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', maxInputTokens: 256000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 256000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', maxInputTokens: 164000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking', maxInputTokens: 164000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  // —— MiniMax ——
  { id: 'minimax-m3', name: 'MiniMax-M3', maxInputTokens: 512000, maxOutputTokens: 128000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', maxInputTokens: 200000, maxOutputTokens: 48000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
  // —— DeepSeek ——
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', maxInputTokens: 1000000, maxOutputTokens: 50000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 50000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000, tools: true, vision: true, reasoning: true, onlyReasoning: true, region: 'cn' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', maxInputTokens: 96000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true, onlyReasoning: true, region: 'cn' },
];

/**
 * 把内置目录与数据库中的自定义模型合并（自定义模型覆盖同 provider+id 内置项）。
 * hiddenIds：被隐藏的模型「对外 id」集合。多渠道下对外 id 形如 `tc/glm-5.2`；
 * 兼容多种历史写法：新短前缀（tc/xxx）、tw 短前缀、内部 kind 前缀（traework/xxx）与裸 id。
 *
 * customModels 可带 provider 字段（缺省 codebuddy）。
 * extra：其它渠道的内置模型 { traework: [ModelInfo, ...] }（key 为内部 kind）。
 *
 * /api/* 管理接口返回全部（含 hidden 标记）；/v1/models 与 /models 过滤 hidden 后返回。
 */
function allModels(customModels, hiddenIds, extra) {
  const hidden = new Set(Array.isArray(hiddenIds) ? hiddenIds : []);
  const byKey = new Map();
  const put = (m, provider, builtin) => {
    const p = provider || m.provider || 'codebuddy';
    const key = providers.externalPrefixOf(p) + '/' + m.id;
    byKey.set(key, { ...m, provider: p, builtin: !!builtin, key, legacyKey: p + '/' + m.id });
  };

  for (const m of MODEL_CATALOG) put(m, 'codebuddy', true);
  for (const [kind, list] of Object.entries(extra || {})) {
    for (const m of (list || [])) put(m, kind, true);
  }
  for (const m of (customModels || [])) put(m, m.provider || 'codebuddy', false);

  const list = Array.from(byKey.values()).map((m) => ({
    ...m,
    // 隐藏标记兼容多种写法：当前短前缀（cc/tc）、内部 kind 前缀与裸 id（含改名前的旧数据）
    hidden: hidden.has(m.key) || hidden.has(m.legacyKey) || hidden.has(m.id),
  }));
  // 稳定排序：仅把 hidden 项移到末尾，不改变其它项的原始相对顺序
  return list.filter((m) => !m.hidden).concat(list.filter((m) => m.hidden));
}

/**
 * 模型的对外 id：始终带渠道短前缀（如 cc/glm-5.2、tc/glm-5.3）。
 *
 * 前缀只影响「对外展示与选择」；请求解析（providers.resolveModel）仍接受
 * 无前缀写法与旧前缀（codebuddy/traework/workbuddy），旧客户端配置继续可用。
 */
function modelKey(m) {
  return providers.externalPrefixOf(m.provider || 'codebuddy') + '/' + m.id;
}

function modelsResponse(customModels, hiddenIds, extra) {
  const now = Math.floor(Date.now() / 1000);
  const data = allModels(customModels, hiddenIds, extra)
    .filter((m) => !m.hidden)
    .map((m) => {
      const entry = {
        id: modelKey(m), object: 'model', created: now,
        owned_by: providers.externalPrefixOf(m.provider || 'codebuddy'),
        name: m.name, is_default: !!m.isDefault,
      };
      // 上下文/输出上限（无数据则不输出该字段，避免客户端误判为 0）
      if (m.maxInputTokens > 0) entry.context_length = m.maxInputTokens;
      if (m.maxOutputTokens > 0) entry.max_output_tokens = m.maxOutputTokens;
      return entry;
    });
  return { object: 'list', data };
}

module.exports = { MODEL_CATALOG, allModels, modelsResponse, modelKey };
