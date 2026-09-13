'use strict';

/**
 * Trae CN（字节跳动 TRAE 国内版）SOLO 免费通道上游协议常量。
 *
 * 来源：逆向自官方客户端（Trae CN shell 3.3.99，product.json 中 trae-api-cn.mchost.guru）
 * 与开源实现 traework2api / wild-work 的实测常量，两处交叉验证一致。
 *
 * ⚠️ 指纹与模型表强相关（2026-09-12 实测）：上游按 X-Ide-Version(-Code) 下发不同的
 * 对话场景表。旧指纹（0.1.52/20260811）的表含 glm-5.3 / glm-5.3-flash（solo_agent 场景）；
 * 新客户端指纹（3.3.74/20260630）的表反而没有它们，升级指纹会直接导致这些模型 4001。
 * 改动指纹前必须实测模型表差异。
 */

module.exports = {
  // —— 域名 ——
  AgentHost: 'https://trae-api-cn.mchost.guru',  // 对话 / 模型列表
  UgHost: 'https://api.trae.cn',                 // 签到 / 额度
  OAuthHost: 'https://api.trae.com.cn',          // 换 token / 用户信息
  ConsoleHost: 'https://www.trae.cn',            // 登录页
  WorkHost: 'https://work.trae.cn',              // Web 端（模型定价）

  // —— 客户端身份（服务端按此识别客户端类型并下发模型配置表）——
  ClientID: 'en1oxy7wnw8j9n',
  AppID: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  IdeVersion: '0.1.52',
  IdeVersionCode: '20260811',
  DeviceBrand: '20Y5A002XX',      // 机型指纹（可替换为真实机型，无需精确匹配）
  OSVersion: 'Windows 10 Pro',
  PluginVersion: '2.3.73734',     // 登录 URL 用
  Function: 'solo_work_lite',     // 免费通道标识（chat 默认值，可被模型映射覆盖）

  // —— 端点 ——
  EpChat: '/api/agent/v3/llm_utils_chat',
  EpModelsBatch: '/api/ide/v1/batch_get_detail_param', // 模型场景表（客户端选择器数据源之一）
  EpExchange: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  EpAuthCodeExchange: '/trae/api/v3/oauth/ExchangeToken', // PKCE 新流程
  EpUserInfo: '/cloudide/api/v3/trae/GetUserInfo',
  EpCheckinStatus: '/trae/api/v2/ug/checkin_credits/status',
  EpCheckinClaim: '/trae/api/v2/ug/checkin_credits/claim',
  // 签到接口 body 携带字段（逆向官方客户端 _requestCheckinCredits：POST body 为 { req_source }；
  // SOLO 系 packageType 取 2，经典 TRAE_CN 取 1）。实测 9004 的根因是缺失 x-device-id 请求头，
  // body 是否携带不影响结果；带上只为与官方客户端完全一致。
  CheckinReqSource: 1,
  EpEntUsage: '/trae/api/v2/pay/web_user_ent_usage',
  EpModelsPricing: '/api/remote/v1/models', // 模型定价表（含 batch 场景表尚未放行的新模型）

  // —— 模型列表取数范围 ——
  // 批量场景表查询的 function 全集（照抄客户端 ai-agent 的真实请求）。
  ModelFunctions: [
    'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder', 'builder_v3', 'builder',
    'chat', 'inline_chat', 'git_ai', 'custom_agent_generation', 'utils', 'code_reviewer',
    'code_review_summary', 'solo_agent', 'solo_agent_remote', 'solo_work_remote',
    'solo_agent_lite', 'solo_work_lite', 'solo_design_lite', 'solo_design_remote',
    'multimodal', 'system_diagnosis',
  ],
  // 定价表查询的 function（= 本代理可对话的场景；chatFunction 映射不会超出此范围）。
  PricingFunctions: 'solo_agent,solo_agent_lite,solo_work_lite',
  // chat function 映射优先级：免费 lite 通道优先，避免误用计费场景。
  ChatFunctionPriority: ['solo_work_lite', 'solo_agent_lite', 'solo_agent'],

  DefaultConfigName: 'glm-5.2',
};
