# 新建 Union-API-Proxy：多渠道聚合代理（现有实例零影响）

## 核心思路

原目录 `D:\dev\CodeBuddy-API-Proxy` **完全不碰**——不动文件、不切分支、不重启、不共用数据库。现有实例继续在 3800 为 ZCode 服务。

复制到 `D:\dev\Union-API-Proxy`，重命名品牌，并在其中建立 **provider 抽象层**，Trae CN 作为第一个新增渠道。抽象层的意义就是你要的："后续可以加其它的了"——以后新增渠道只需实现接口 + 注册 Runtime，不改转发链路。

隔离依据（已核实）：
- `core/config.js:12-13` 端口可经 `PORT`/`HOST` 覆盖
- `core/config.js:19-21` 数据目录可经 `CODEBUDDY_DATA_DIR` 覆盖，`DB_FILE`/`SESSION_FILE` 随之派生
- 项目内无单实例锁，两进程可并存（端口 + 数据目录不同即可）
- 线上 `proxy.db` 的 WAL 时间戳为 16:01，正在活跃使用——**共用同一 SQLite 会互相干扰，必须独立数据目录**

---

## 一、建副本（含依赖与构建产物）

```bash
cp -r "D:/dev/CodeBuddy-API-Proxy" "D:/dev/Union-API-Proxy"
cd "D:/dev/Union-API-Proxy"
git checkout -b feat/multi-provider
```

- **连 `node_modules/`（51M）和 `dist/` 一起复制**，副本开箱可跑，省掉 `npm install` + `npm run build`
- **连 `.git`（624K）一起复制**，保留完整历史，副本可独立演进
- 复制安全性：node 进程不锁定自身源码，且数据目录在 `~/.codebuddy-proxy`（不在项目内），复制不与运行中实例冲突
- 检查副本的 git remote：若继承了原仓库的 origin，按需改指或清除，避免误推

## 二、副本的隔离运行

新建 `start-dev.sh` / `start-dev.cmd` 固定如下变量：

```bash
cd "D:/dev/Union-API-Proxy"
PORT=3801 \
CODEBUDDY_DATA_DIR="$HOME/.union-api-proxy" \
CODEBUDDY_NO_OPEN=1 \
node server.js
```

- `PORT=3801` — 与 3800 并存（启动前确认 3801 空闲）
- `CODEBUDDY_DATA_DIR=~/.union-api-proxy` — **独立 SQLite**，绝不触碰线上库
- `CODEBUDDY_NO_OPEN=1` — 不弹浏览器，避免与线上管理页混淆
- 副本管理页 `http://127.0.0.1:3801`，线上仍是 `3800`

副本数据从空开始，只在副本里登录 Trae 账号。若需在副本一并验证 CodeBuddy 回归，则把线上 `proxy.db` + `-wal` + `-shm` 三件套拷入副本数据目录做种子，**并在副本管理页关掉 autoCheckin**，避免两个调度器对同一批账号重复签到互相撞限流。

## 三、改名与配置前缀（品牌层）

- `package.json`：`name` → `union-api-proxy`，`description` 改为多渠道聚合
- 前端 4 处：`web/src/components/Sidebar.vue`、`TopBar.vue`、`i18n/locales/zh-CN.js`、`en-US.js` 的 `CodeBuddy API Proxy` → `Union API Proxy`；`subtitle` 改为"把多渠道登录态聚合为 OpenAI 兼容接口"
- `core/config.js`：环境变量读取链改为 `UNION_* || CODEBUDDY_* || 默认值`，**仅此一处改动**，既有 `CODEBUDDY_*` 启动命令继续可用（向后兼容，不破坏你现在的用法）
- `README.md` / `AGENTS.md` 补多渠道说明
- 注意：`core/sanitize.js` 与 `core/auth.js` 里的 `CodeBuddy` 是**协议实现细节**（上游品牌词替换、CLI UA），**不是品牌文案，不要改**

## 四、Provider 抽象层（可扩展性的核心）

新增 `core/providers/`：

```
core/providers/
  index.js              # 注册表 + resolveModel()
  codebuddy/index.js    # 薄包装现有 auth/openai/models，行为零变更
  traework/
    constants.js  headers.js  payload.js
    sse.js  client.js  login.js  models.js
```

**Provider 接口（能力可选，未实现即视为不支持）**：

```js
{
  kind: 'traework',            // 渠道标识，同时是模型前缀
  label: 'Trae CN',            // 管理页显示名
  listModels(acct),            // -> [{id,name,contextWindow,maxTokens,tools,vision,reasoning}]
  refreshToken(acct),          // -> auth
  login: { start(), poll(state), cancel() },
  buildChatHeaders(acct, opts),// -> headers
  preparePayload(payload),     // 请求体改写
  chat(acct, payload, opts),   // -> { stream(res,w), aggregate() }
  checkin?(acct),              // 可选：不支持则不注册，路由/调度器探测能力
  credits?(acct),              // 可选
}
```

**模型解析**（`resolveModel`）：
```
'glm-5.2'           -> { provider:'codebuddy', model:'glm-5.2' }   # 无前缀=默认，向后兼容
'workbuddy/glm-5.2' -> { provider:'codebuddy', model:'glm-5.2' }
'traework/glm-5.2'  -> { provider:'traework', model:'glm-5.2' }
```

关键设计点：**能力探测而非强制实现**——Qoder 无签到就直接不注册 `checkin`，路由和调度器用 `typeof p.checkin === 'function'` 判断。新增渠道因此只需"实现接口 + 在 `index.js` 注册一行"，不改转发链路。这正是 wild-work `provider.Upstream` 接口的思路，但改成可选能力以适应 Node 的鸭子类型。

## 五、Trae CN 协议实现（移植自 `D:\dev\wild-work\internal\traework\`）

| 文件 | 来源 | 内容 |
|---|---|---|
| `constants.js` | `constants.go` | 5 域名、8 端点、`ClientID`/`AppID`/`IdeVersion=0.1.52`/`IdeVersionCode=20260811`/`DeviceBrand`/`OSVersion`/`PluginVersion=2.3.73734`/`Function=solo_work_lite` |
| `headers.js` | `headers.go` | `SOLOHeaders`（`Authorization: Cloud-IDE-JWT`、`X-Cloudide-Token`、`X-Ide-Token`、`X-Uid`、`X-App-Id`、`X-Ide-Version(-Code/-Type)`、`X-Device-Type/Brand`、`X-OS-Version`、`Request-Traffic-Type: prod`、`X-Machine-Id`、`x-device-id`）；`UgHeaders`（签到/额度必需的指纹头，缺任一返回 9074）；`OAuthHeaders` |
| `payload.js` | `payload.go` | 强制 `stream:true`、`function`、`model`/`config_name` 双写、`developer→system`、`assistant.tool_calls.function`→`function_call`（丢弃 name 为空项）、content 字符串→`[{type:text,text}]`、`tool_choice` 归一化（none 时同时删 `tools`/`functions`）、tools.parameters 序列化为 JSON 字符串 |
| `sse.js` | `solosse.go` | **核心**：SOLO `event:`/`data:` 事件流解析（跨行累积）→ OpenAI。流式：`output.response`→`delta.content`、`reasoning_content`→`delta.reasoning_content`、tool_calls 按 index 合并（`function_call`→`function`，删 `namespace`/`partial_arguments`）、`token_usage` 挂末尾 chunk、`done`→`finish_reason`+`[DONE]`、`error`→错误 chunk。非流式：聚合为 `chat.completion` |
| `client.js` | `client.go` | `RefreshToken`（`ExchangeToken`，`ClientSecret:"-"`，refreshToken 轮转持久化，`TokenExpireAt>1e12` 按毫秒归一）、`ChatStream`、`FetchModels`（`get_detail_param`，按 `config_name` 去重、过滤 `is_custom_model`/`custom_model_` 前缀）、`GetUserInfo`、签到三件套（含 9074 重试）、`UserEntUsage`/`UserResourceDetail`、`Classify`（1005→硬额度、401→会话失效、429→软限流） |
| `login.js` | `login_trae/login.go` + `authcode.go` | PKCE（S256）+ `127.0.0.1:0` **随机端口**回调（不占官方 18080）+ 四级凭证回退（`refreshToken`→`userJwt.RefreshToken`→`userJwt.Token`→`authCodeInfo.AuthCode`）+ `ExchangeAuthCode`（AuthCode+CodeVerifier+ECDSA P256 设备公钥，候选 origin 依次尝试） |
| `models.js` | 静态表 | 兜底模型（`glm-5.2`/`glm-5.3`/`glm-5-turbo`/`kimi-k2.6`/`kimi-k2.7-code`/`minimax-m3`/`qwen3-coder`/`Doubao-Seed-2.1-Pro`/`DeepSeek-V4-Pro/Flash` 等） |

## 六、三处既有适配的处理（关键，不可丢）

| 适配 | 处理方式 |
|---|---|
| `sanitize.js` 11128 词表净化 | **仅 codebuddy 分支调用**。11128 是腾讯的拦截机制；Trae 是字节的体系，规则未知，**不盲目套用**。为 Trae 留净化钩子，拿真实账号实测后再决定是否加专属规则 |
| `util.js` 空字段剥离（防 1 秒思考碎片） | **对所有渠道生效**。这是 AI SDK 层面的通用问题，Trae 侧同样需要。Trae 分支输出的 chunk 也走 `normalizeSseBlock` 再下发 |
| `auth.js` CLI 身份头（`X-Ide-Type: CLI` 等） | **仅 codebuddy 注入**。Trae 用它自己的指纹头，两者互不混用 |

## 七、数据层

- `accounts` 表加 `provider TEXT NOT NULL DEFAULT 'codebuddy'`，沿用现有 `PRAGMA table_info` + `ALTER TABLE` 范式（`store.js:273-291`）；旧库自动补齐，现有账号默认为 codebuddy
- `models` 表加 `provider` 列，同上
- `insertAccount` / `updateAccountRow` / `accountRowToObject` / `listAccountRows` 透传 provider
- **账号池配置按渠道隔离**：`getAccountPool(provider)` / `setAccountPool(provider, cfg)`。原单行配置迁移为 codebuddy 的配置，Trae 用独立默认值——避免一个全局 `pinnedId` 在两渠道间语义错乱
- `pickAccountForRequest(explicitKey, keyAccountId, provider)` 按 provider 过滤候选，两渠道账号互不串用
- Trae 凭证字段（`machineId`/`deviceId`/`apiHost`）存入既有 `auth` JSON，**无需改表结构**
- `checkin_state` / `credit_snapshots` 加 `provider` 列
- **模型前缀存储策略**：DB 内只存**裸模型 id + provider 列**，`traework/` 前缀在 `/v1/models` 输出时拼接。原因：`store.js:513` 的 `validateModelInput` 正则 `/^[A-Za-z0-9._:-]+$/` 不允许 `/`，这样既不用改校验逻辑，也避免两家同名 `glm-5.2` 冲突

## 八、转发链路

- `core/openai.js` / `core/responses.js`：先 `resolveModel(payload.model)`，再分发到 provider 的 `preparePayload` / `buildChatHeaders` / `chat`；codebuddy 分支保持原有逻辑不变
- `core/util.js`：`pipeSseToClient` 接受 provider 的流转换器；Trae 用其 `sse.js` 转换后再经 `normalizeSseBlock` 下发，并复用现有 keep-alive agent、usage 提取、CORS
- `core/models.js`：`allModels` / `modelsResponse` 输出 `traework/<id>`，`owned_by` 按 provider 取

## 九、管理页 UI

- `AccountsView.vue`：渠道筛选 tab（CodeBuddy / Trae CN）、两个添加入口、账号卡片显示 provider 徽标 + Trae 积分 + 签到状态
- `ModelsView.vue`：按 provider 分组（两家同名 `glm-5.2` 必须分组展示）；自定义模型表单加 provider 选择
- `OverviewView.vue` / `UsageView.vue`：账号数与用量按 provider 维度拆分
- `api/index.js`：新增 `loginStart(channel)` / `loginStatus(state)` / `loginCancel(state)`
- `routes.js`：新增 `/api/accounts/login/start`（带 channel 参数）、`/api/accounts/login/cancel`
- `i18n`：两语言文件补 Trae 文案

## 十、调度与计费

- `checkin.js` / `credits.js`：改为按 provider 分发；Trae 走 `UgHeaders` 的签到/额度接口
- `checkinScheduler.js`：沿用随机窗口调度，遍历各渠道中**注册了 `checkin` 能力**的账号

## 十一、验收

1. **隔离性**：副本启动后原实例仍正常服务 ZCode（3800 不断）；副本增删账号，线上库无变化；原目录 `git status` 干净、仍在 `main`
2. `npm test`（语法检查）+ `npx vite build` 通过
3. **CodeBuddy 回归**：流式分块、`reasoning_content`、工具调用、无前缀模型解析、11128 净化、CLI 身份头逐项与改造前一致
4. **Trae 打通**：管理页「+ Trae CN」完成浏览器 OAuth 登录 → 账号入池标记 `traework`；`curl` 分别请求 `traework/glm-5.2` 与 `glm-5.2`，验证流式/非流式/思考链/工具调用
5. **ZCode 实跑**：两个 provider 各跑一轮带工具的会话，确认无「1 秒思考碎片」、无 11128
6. **实测 Trae 内容过滤**：观察 Trae 是否对竞品词/提示词有拦截；若有，再为 Trae 单独定规则
7. **扩展性验证**：确认新增第三个渠道（如 Qoder）只需"加 `core/providers/<kind>/` + 注册一行"，不改转发链路

## 已知风险

- **Trae 内容过滤未知**：11128 是 CodeBuddy 的机制，Trae 未必相同，留钩子待实测
- **上游协议漂移**：`llm_utils_chat` 带 `v3`、`IdeVersion` 需与客户端版本对齐；常量集中存放便于更新
- **SOLO 免费通道限制**：wild-work README 记载「TraeWork 通用积分不能用」「DeepSeek V4 Flash 响应慢」，额度和稳定性需真实账号实测后再决定投入深度
- **refreshToken 不可自动导入**：Trae CN 客户端 `state.vscdb` 无明文 refreshToken（已核实），只能走浏览器 OAuth

## 后续合并

副本是带独立 git 历史的仓库。开发验证完成后，在原目录 `git remote add union <副本路径>` → `git fetch union` → `git cherry-pick`，把 `feat/multi-provider` 的提交带回 `main`。时机由你定，不影响原实例持续可用。