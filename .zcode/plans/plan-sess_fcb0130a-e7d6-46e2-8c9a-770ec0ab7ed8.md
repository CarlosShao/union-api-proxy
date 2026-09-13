修复 Trae CN 签到 9004 错误（claim 请求体补齐 req_source 参数）

## 根因（已通过逆向本机 Trae CN 客户端确认）

直接逆向了本机安装的官方客户端（`C:\Users\m1381\AppData\Local\Programs\Trae CN\resources\app\out\main.js`），还原出签到接口的真实请求构造：

- 官方客户端 `_requestCheckinCredits` 对 `/trae/api/v2/ug/checkin_credits/status` 和 `/trae/api/v2/ug/checkin_credits/claim` 的 POST **body 均为 `{ req_source: N }`**，不是空对象。
- `N = Rr(productService) ? 2 : 1`：`packageType` 为 SOLO 系（SOLO_CN / SOLO_I18N / SOLO_CN_ENTERPRISE）时为 2，否则为 1。本机 product.json 为 `"packageType": "TRAE_CN"`（经典版），即发送 `{"req_source":1}`。
- 其余头与代理现有 `UgHeaders` 基本一致：`Content-Type: application/json` + `Authorization: Cloud-IDE-JWT <token>` + 设备指纹头（x-device-id / x-device-brand / x-device-type / x-os-version / x-app-version，由 `_applyUgDeviceHeaders` 注入），无其他特殊头。
- 我们的代理（`core/providers/traework/client.js:293、309`）body 发的是 `{}`，上游在 claim 校验 `req_source` 时报 9004 "The submitted order parameters are incorrect"。status 接口不校验该字段所以能通过，与日志现象完全吻合。

## 改动内容

**1. `core/providers/traework/constants.js`**
- 新增常量 `CheckinReqSource: 1`（经典 Trae 版取值；注释说明 SOLO 版客户端为 2，并注明出处：逆向自官方客户端 `_requestCheckinCredits`）。

**2. `core/providers/traework/client.js`**
- `checkinStatus`（line 292-294）：`body: {}` → `body: { req_source: C.CheckinReqSource }`。
- `checkinClaim`（line 308-310）：`body: {}` → `body: { req_source: C.CheckinReqSource }`。

共 3 行改动，其余逻辑（9074 限流重试、签到后复核、调度器）不动。

## 验证

1. 启动代理后调用 `POST /api/checkin`（body 带 Trae CN 账号 accountId，或直接走自动签到触发）实测：预期不再报 9004；若当天已手动签过到，则 status 返回 checkedIn=true，走 already 分支也算验证通过（status 带 req_source 正常返回）。
2. 若想强制验证完整 claim 流程，可临时把 checkin_state 表该账号的 lastDate 清掉次日再观察自动签到日志。
3. 回归：确认额度查询 `EpEntUsage`（body 含 require_usage）不受影响；Trae 对话/模型列表功能不受影响（本次未触碰 SOLOHeaders）。