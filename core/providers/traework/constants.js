'use strict';

/**
 * Trae CN（字节跳动 TRAE 国内版）SOLO 免费通道上游协议常量。
 *
 * 来源：逆向自官方客户端（Trae CN 3.3.99，product.json 中 trae-api-cn.mchost.guru）
 * 与开源实现 traework2api / wild-work 的实测常量，两处交叉验证一致。
 * 上游改版时改这里即可（尤其 IdeVersion / IdeVersionCode 需与客户端版本对齐）。
 */

module.exports = {
  // —— 域名 ——
  AgentHost: 'https://trae-api-cn.mchost.guru',  // 对话 / 模型列表
  UgHost: 'https://api.trae.cn',                 // 签到 / 额度
  OAuthHost: 'https://api.trae.com.cn',          // 换 token / 用户信息
  ConsoleHost: 'https://www.trae.cn',            // 登录页
  WorkHost: 'https://work.trae.cn',              // Web 端（模型定价）

  // —— 客户端身份（服务端按此识别客户端类型）——
  ClientID: 'en1oxy7wnw8j9n',
  AppID: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  IdeVersion: '0.1.52',
  IdeVersionCode: '20260811',
  DeviceBrand: '20Y5A002XX',      // 机型指纹（可替换为真实机型，无需精确匹配）
  OSVersion: 'Windows 10 Pro',
  PluginVersion: '2.3.73734',     // 登录 URL 用
  Function: 'solo_work_lite',     // 免费通道标识

  // —— 端点 ——
  EpChat: '/api/agent/v3/llm_utils_chat',
  EpModels: '/api/ide/v1/get_detail_param',
  EpExchange: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  EpAuthCodeExchange: '/trae/api/v3/oauth/ExchangeToken', // PKCE 新流程
  EpUserInfo: '/cloudide/api/v3/trae/GetUserInfo',
  EpCheckinStatus: '/trae/api/v2/ug/checkin_credits/status',
  EpCheckinClaim: '/trae/api/v2/ug/checkin_credits/claim',
  EpEntUsage: '/trae/api/v2/pay/web_user_ent_usage',
  EpModelsPricing: '/api/remote/v1/models',

  DefaultConfigName: 'glm-5.2',
};
