'use strict';

/**
 * 渠道注册引导。
 *
 * 单独成文件是为了避开循环依赖：providers/index.js 只提供注册表能力，
 * 不 require 具体渠道实现；具体渠道在此集中注册，供 core/index.js 启动时加载一次。
 *
 * 新增渠道只需在此加一行 register(require('./<kind>')).
 */

const providers = require('./index');

const codebuddy = require('./codebuddy');
const traework = require('./traework');
const openaiCustom = require('./openai-custom');

providers.register(codebuddy);
providers.register(traework);
providers.register(openaiCustom);

/**
 * 自定义 OpenAI 兼容 endpoint 的前缀解析：
 * 用户配的 model_prefix（默认 oc）或 endpoint id 都视作合法前缀，归属 openai-custom 渠道。
 * 这样管理页增删 endpoint / 改前缀后无需重启即可生效。
 */
const store = require('../store');
providers.setCustomPrefixResolver((prefix) => {
  const list = store.listCustomApis();
  const p = String(prefix).toLowerCase();
  if (list.some((e) => e.enabled && (e.modelPrefix === p || e.id === p))) return 'openai-custom';
  return null;
});

module.exports = providers;
