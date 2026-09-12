# Union API Proxy 使用说明

> 面向使用者的上手指南。架构与协议细节见 [README.md](README.md)。

Union API Proxy 把**腾讯 CodeBuddy** 与**字节 Trae CN** 两个渠道的登录态聚合为一个 OpenAI 兼容接口。你只需把工具的 `base_url` 指向本代理，用模型名前缀选择渠道，无需关心各家的协议差异。

```
Cursor / ZCode / Codex CLI / OpenAI SDK / 任意 OpenAI 兼容客户端
                    │  base_url = http://127.0.0.1:3800/v1
                    ▼
          ┌─────────────────────┐
          │   Union API Proxy   │  ← 模型名前缀路由：cc/xxx、tc/xxx
          └──────┬───────┬──────┘
                 │       │
        cc/*（腾讯）  tc/*（字节）
                 ▼       ▼
        CodeBuddy 上游   Trae CN 上游
```

## 1. 安装与启动

需要 **Node ≥ 22.5**（内置 SQLite，无需配置数据库）。

```bash
npm install
npm run build     # 构建管理页（dist/）
npm start         # 启动，默认 http://127.0.0.1:3800
```

- 启动后自动打开管理页；不想自动打开：`CODEBUDDY_NO_OPEN=1 npm start`
- 换端口/地址：`PORT=8080 HOST=0.0.0.0 npm start`（开放监听请先看文末安全提示）
- 隔离测试实例：`PORT=3801 CODEBUDDY_DATA_DIR=~/.union-api-proxy-dev npm start`

## 2. 添加账号（必须）

1. 打开管理页 `http://127.0.0.1:3800/home`
2. 进入「账号管理」，在对应渠道的 tab 里点「添加账号」
   - **CodeBuddy（cc）**：官方 OAuth，浏览器里登录即可
   - **Trae CN（tc）**：PKCE OAuth，同样浏览器登录；不占用官方客户端的 18080 端口
3. 可添加多个账号形成账号池，代理会自动轮询选择；Token 过期自动刷新

账号池支持「固定单账号」与「轮询」两种池模式；每渠道的账号池相互隔离。

## 3. 配置客户端

### 3.1 API 密钥

管理页「API 密钥」页可创建多个密钥（校验开关默认开启）。客户端请求需带：

```bash
Authorization: Bearer <你的密钥>
```

### 3.2 模型名与渠道路由

`/v1/models` 返回的模型 id **一律带渠道短前缀**：

| 前缀 | 渠道 | 示例 |
|---|---|---|
| `cc/` | CodeBuddy（腾讯） | `cc/glm-5.2`、`cc/deepseek-v4-flash` |
| `tc/` | Trae CN（字节） | `tc/glm-5.3-flash`、`tc/kimi-k3` |
| 无前缀 | 归默认渠道（cc），兼容旧配置 | `glm-5.2` |

兼容写法：旧前缀 `codebuddy/`、`workbuddy/`、`traework/`、`tw/` 均继续可用，大小写不敏感。

> 模型列表优先从各渠道上游动态拉取（1 小时缓存），随账号权益自动变化；拉取失败回退内置静态表。

### 3.3 OpenAI 兼容端点

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 对话（流式 + 非流式；非流式由代理聚合） |
| `GET /v1/models` | 模型列表（只含已登录渠道） |
| `POST /v1/responses` | Responses API（接 Codex CLI） |
| `POST /v1/completions`、`/v1/embeddings` | 仅 CodeBuddy 渠道支持 |

**快速验证：**

```bash
KEY=<你的密钥>

# 模型列表
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3800/v1/models

# 流式对话（Trae 的 GLM-5.3-Flash）
curl -N http://127.0.0.1:3800/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"tc/glm-5.3-flash","stream":true,"messages":[{"role":"user","content":"你好"}]}'

# 非流式对话（CodeBuddy）
curl http://127.0.0.1:3800/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"cc/glm-5.2","messages":[{"role":"user","content":"你好"}]}'
```

### 3.4 接入常见客户端

- **Cursor / Continue / 其他 OpenAI 兼容工具**：`base_url` 填 `http://127.0.0.1:3800/v1`，API Key 填你的密钥，模型选 `/v1/models` 里的带前缀 id。
- **ZCode CLI**：设置里新增 `openai-compatible` 类型 provider，`baseURL` 必须以 `/v1` 结尾。注意 CodeBuddy 渠道有竞品词拦截，代理已内置净化；若遇 11128 见 README「接 ZCode CLI」一节。
- **Codex CLI**：走 Responses API，配置见 README「接 Codex CLI」。

## 4. 日常使用

- **管理页**：`/home` 总览与用量图表、`/accounts` 账号与签到、`/models` 模型管理（可自定义模型）、`/usage` 用量明细（可导出 CSV）、`/logs` 日志、`/settings` 系统配置。
- **每日自动签到**（默认开启）：按北京时间每天 05:00–09:00 随机时间执行，错过会补签；Trae CN 签到的是积分，账号卡片可见余额与今日消耗。
- **用量统计**：每次请求记录模型、账号、密钥、token（含缓存命中）、耗时，可在管理页按维度筛选。

## 5. 常见问题

| 现象 | 说明与处理 |
|---|---|
| `model [xxx] service info not found`（11102） | 模型名拼写或**前缀写错**（如少字母 `raework/`），被路由到错误渠道。检查 `/v1/models` 里确切的 id |
| Trae 报 `code=4001 param is invalid` | 所选模型不在该渠道当前下发的对话表里（新模型常滞后）。换其他模型，待上游放开后自动可用 |
| CodeBuddy 报 11128 | 竞品词拦截，代理已内置净化；若仍出现，按 README 的 DEBUG 方法定位后加规则 |
| 首次请求 `/v1/models` 模型偏少 | 动态列表是后台拉取的（首次返回静态兜底），几秒后再请求即完整 |
| 管理页打不开/未构建 | 先 `npm run build`；已构建但仍提示则重启服务 |
| 忘记管理页密码 | 见 README「忘记密码」 |

## 6. 数据与配置

- 数据目录：`~/.union-api-proxy`（`UNION_DATA_DIR` 或旧名 `CODEBUDDY_DATA_DIR` 覆盖）
  - `proxy.db`：SQLite（账号、日志、用量、配置、密钥等）
  - `session.json`：旧版登录态文件（现登录态主要存 DB）
- 常用环境变量：`PORT`、`HOST`、`UNION_DATA_DIR`、`CODEBUDDY_NO_OPEN`、`CODEBUDDY_API_KEY`、`CODEBUDDY_ADMIN_PASSWORD`；完整列表见 README。

## 7. 安全提示

- 默认只监听 `127.0.0.1`。**不要**把未鉴权的实例直接暴露公网；如需远程使用，建议开启管理页鉴权 + API 密钥 + 反向代理 TLS。
- 公网部署时设 `CODEBUDDY_TRUST_PROXY=true` 才信任反向代理的 `X-Forwarded-For`（限流防伪造）。
