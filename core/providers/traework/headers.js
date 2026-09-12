'use strict';

/**
 * Trae CN 上游请求头构造。
 *
 * 三套头各司其职，不可混用：
 *   SOLOHeaders   对话 / 模型列表（Authorization: Cloud-IDE-JWT，带 X-Ide-* 设备指纹）
 *   UgHeaders     签到 / 额度（额外要求设备指纹头，缺任一上游以 9074 拒绝）
 *   OAuthHeaders  刷新 token / 换 AuthCode（无鉴权，仅标识客户端）
 */

const C = require('./constants');

const clientUA = 'Trae/' + C.IdeVersion;

/** 账号里存的是 accessToken，Trae 侧称 Cloud-IDE-JWT */
function jwtOf(auth) {
  return (auth && auth.accessToken) || '';
}

/** 对话 / 模型列表请求头 */
function SOLOHeaders(auth, { stream = false } = {}) {
  const at = jwtOf(auth);
  const h = {
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'User-Agent': clientUA,
    'Authorization': 'Cloud-IDE-JWT ' + at,
    'X-Cloudide-Token': at,
    'X-Ide-Token': at,
    'X-App-Id': C.AppID,
    'X-App-Version': 'default',
    'X-Ide-Version': C.IdeVersion,
    'X-Ide-Version-Code': C.IdeVersionCode,
    'X-App-Version-Code': C.IdeVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': C.OSVersion,
    'X-Device-Brand': C.DeviceBrand,
    'Request-Traffic-Type': 'prod',
  };
  const uid = auth && auth.account && auth.account.uid;
  if (uid) h['X-Uid'] = uid;
  if (auth && auth.machineId) h['X-Machine-Id'] = auth.machineId;
  if (auth && auth.deviceId) h['X-Device-Id'] = auth.deviceId;
  return h;
}

/**
 * 签到 / 额度请求头。
 * 设备指纹头缺任一（尤其 x-device-id）上游会以 9074 限流拒绝。
 */
function UgHeaders(auth) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': clientUA,
    'Authorization': 'Cloud-IDE-JWT ' + jwtOf(auth),
    'X-User-Region': 'CN',
    'x-device-brand': C.DeviceBrand,
    'x-device-type': 'windows',
    'x-os-version': C.OSVersion,
    'x-app-version': C.IdeVersion,
  };
  if (auth && auth.deviceId) h['x-device-id'] = auth.deviceId;
  return h;
}

/** 刷新 / 换 AuthCode 请求头 */
function OAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': clientUA,
  };
}

module.exports = { SOLOHeaders, UgHeaders, OAuthHeaders, clientUA };
