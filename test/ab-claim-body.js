'use strict';
/**
 * 决定性 A/B 实验：claim 接口 2×2 组合
 *   body: {} vs { req_source: 1 }
 *   headers: 无 x-device-id vs x-device-id=<客户端真实 did>
 * 已签到日上游对 claim 返回 9004 语义无法区分参数错误，
 * 因此先跑 status 验证头组合可用，再观察 claim 业务码差异。
 */
const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const path = require('path');
const { requestJson } = require('../core/util');
const C = require('../core/providers/traework/constants');
const { UgHeaders } = require('../core/providers/traework/headers');

const DEVICE_ID = '2552445442988634';

const db = new DatabaseSync(path.join(os.homedir(), '.union-api-proxy', 'proxy.db'), { readOnly: true });
const acct = JSON.parse(db.prepare("SELECT auth FROM accounts WHERE id='acct_8d5ce99c00e678382f9706c4'").get().auth);
db.close();

function headersWith(withDid) {
  const h = UgHeaders(acct);
  if (withDid) h['x-device-id'] = DEVICE_ID;
  return h;
}

async function post(ep, body, did, tag) {
  const r = await requestJson(C.UgHost + ep, {
    method: 'POST', headers: headersWith(did), body, timeoutMs: 30000,
  });
  console.log(`[${tag}] HTTP ${r.status} ->`, r.body.slice(0, 240));
  return r.json;
}

(async () => {
  console.log('== status 四组对照 ==');
  await post(C.EpCheckinStatus, {}, false, 'status empty-body no-did');
  await post(C.EpCheckinStatus, {}, true, 'status empty-body DID');
  await post(C.EpCheckinStatus, { req_source: 1 }, false, 'status rs1 no-did');
  await post(C.EpCheckinStatus, { req_source: 1 }, true, 'status rs1 DID');

  console.log('== claim 2×2 ==');
  await post(C.EpCheckinClaim, {}, false, 'claim empty no-did');
  await post(C.EpCheckinClaim, {}, true, 'claim empty DID');
  await post(C.EpCheckinClaim, { req_source: 1 }, false, 'claim rs1 no-did');
  await post(C.EpCheckinClaim, { req_source: 1 }, true, 'claim rs1 DID');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
