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

providers.register(require('./codebuddy'));
providers.register(require('./traework'));

module.exports = providers;
