'use strict';

/**
 * Trae CN 静态模型兜底表。
 *
 * 仅在 `get_detail_param` 动态拉取失败时使用 —— 上游返回的 config_info_list
 * 才是权威列表（会随账号权益变化）。这里保留常见项，保证离线/首次启动时
 * /v1/models 仍有可用条目。
 *
 * 型号来自本机 Trae CN 客户端实测日志（2026-09）。
 */

/**
 * 静态兜底模型表。
 *
 * 仅在 `get_detail_param` 动态拉取失败时使用。上游的 config_info_list 才是权威列表
 * （随账号权益变化），此处按实测结果维护，避免兜底时列出账号实际拿不到的模型。
 *
 * 实测来源：Trae CN 账号 2026-09 的 get_detail_param 返回。
 */
const STATIC_MODELS = [
  { id: 'glm-5.3', name: 'GLM-5.3', tools: true, reasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', tools: true, reasoning: true },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', tools: true, reasoning: true },
  { id: 'glm-5', name: 'GLM-5', tools: true, reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', tools: true, reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', tools: true, reasoning: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', tools: true, reasoning: true },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao-Seed-2.1-Pro', tools: true, reasoning: true },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao-Seed-2.1-Turbo', tools: true, reasoning: true },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.0-Code', tools: true },
  { id: 'Doubao-Seed-Evolving', name: 'Doubao-Seed-Evolving', tools: true, reasoning: true },
  { id: 'seed-code-pro-0430', name: 'Seed-Code-Pro-0430', tools: true },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', tools: true, reasoning: true },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro (Official)', tools: true, reasoning: true },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', tools: true, reasoning: true },
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash (Official)', tools: true, reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', tools: true, reasoning: true },
  { id: 'qwen-3.7-plus', name: 'Qwen-3.7-Plus', tools: true, reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', tools: true, reasoning: true },
];

/**
 * 返回静态模型（统一为 ModelInfo 结构）。
 * 无 contextWindow/maxTokens 数据时留 0，由 /v1/models 决定是否输出该字段。
 */
function staticModels() {
  return STATIC_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    maxInputTokens: m.maxInputTokens || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    tools: !!m.tools,
    vision: !!m.vision,
    reasoning: !!m.reasoning,
  }));
}

module.exports = { STATIC_MODELS, staticModels };
