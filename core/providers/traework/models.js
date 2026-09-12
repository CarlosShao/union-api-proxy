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
 * 仅在动态拉取（批量场景表 + 定价表）失败时使用。上游返回才是权威列表
 * （随账号权益与客户端指纹变化），此处按实测结果维护，避免兜底时列出账号
 * 实际拿不到的模型。
 *
 * 实测来源：2026-09-12 Trae CN 账号 batch_get_detail_param + /api/remote/v1/models
 * （旧指纹 0.1.52/20260811 下，glm-5.3 系列在 solo_agent 场景可对话）。
 * glm-5.3-flash 的 1M 上下文取自客户端 Max 模式宣传口径，API 元数据暂未提供。
 */
const STATIC_MODELS = [
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1000000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'glm-5', name: 'GLM-5', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'qwen-3.7-plus', name: 'Qwen-3.7-Plus', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao-Seed-2.1-Pro', maxInputTokens: 256000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao-Seed-2.1-Turbo', maxInputTokens: 256000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.0-Code', maxInputTokens: 232768, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'Doubao-Seed-Evolving', name: 'Doubao-Seed-Evolving', maxInputTokens: 256000, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'seed-code-pro-0430', name: 'Seed-Code-Pro-0430', maxInputTokens: 232768, maxOutputTokens: 32000, tools: true, vision: true, reasoning: true },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro (Official)', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash (Official)', maxInputTokens: 200000, maxOutputTokens: 32000, tools: true, vision: false, reasoning: true },
];

/**
 * 已知元数据修正（仅填充动态列表中缺失的字段，不覆盖上游实测值）。
 * glm-5.3-flash 的 1M 上下文来自客户端 Max 模式宣传口径，API 元数据暂未提供。
 * chatFunction：flash 只在 solo_agent 场景的对话表里（旧指纹实测），启动即需正确
 * 映射，否则动态列表拉取前的请求会落到默认 solo_work_lite 而 4001。
 */
const MODEL_OVERRIDES = {
  'glm-5.3-flash': { maxInputTokens: 1000000, chatFunction: 'solo_agent' },
};

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

module.exports = { STATIC_MODELS, MODEL_OVERRIDES, staticModels };
