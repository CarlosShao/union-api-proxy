修复 ZCode 调用时代理流式响应中残留的"多次思考 ~1s 停顿"问题。

## 根因
流式转发本身是字节级透传（core/util.js:95-166 pipeSseToClient，无缓冲/定时器），问题在于事件循环被剩余的同步 SQLite 操作阻塞，导致上游小粒度 reasoning delta 到达 ZCode 的时间被拉开，被 UI 切成多个"思考·持续了几秒"块。上个提交 a836bec 只是把同步写延迟了 500ms，没有减量、也没移出主线程，停顿反而转移到了流中途。

## 修复项
1. **markUsed/pickAccount 不再触发全量池持久化**（core/session.js + core/store.js，核心）
   - 新增 store.touchAccount(id, lastUsedAt, useCount) 单行 UPDATE；markUsed 改用它，删除 deferPersist 调用
   - pickAccount 的 cursor 变更只留内存，不再持久化
   - persistPool 仅保留给结构性变更（增删账号、改池配置）
   - store.insertAccount 去掉写后读回（store.js:972 附近 getAccountRow）
2. **verifyClientKey 内存化**（core/store.js + core/auth.js）
   - api_keys 启动加载进内存缓存，管理页增删改时失效；校验在内存做常数时间比较
   - last_used_at/use_count 进缓冲区，500ms 批量 UPDATE
   - rateLimitCheck 首次成功不 INSERT；rateLimitReset 仅在记录存在时 DELETE
3. **prune 移出 flushLogs 热路径**（core/store.js:87-91）：改为每 10 分钟低频定时 + 关闭时执行
4. **token 刷新误判兜底**（core/session.js:353-359）：expiresAt 缺失时用 lastRefreshTime 判断新鲜度，避免每请求刷新往返
5. **上游连接复用**（core/util.js + core/responses.js）：共享 https.Agent({keepAlive:true, maxSockets:8, keepAliveMsecs:30000})
6. **修复 logger.js:24 回归**：typeof payload !== 'object' → === 'object'
7. **观测**：CODEBUDDY_DEBUG 下在 pipeSseToClient 记录 >500ms 的 chunk 间隙日志，用于修复前后对比验证
8. 低优先级（本次不做）：签到/积分调度器同步查询降频

## 验证
- node --check 语法校验全部改动文件
- 重启服务后用 ZCode 跑一段带工具调用的对话，开 CODEBUDDY_DEBUG 观察 chunk 间隙日志：修复前应有多处 >500ms 间隙，修复后基本消失