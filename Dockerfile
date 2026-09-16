# syntax=docker/dockerfile:1

# ---- 构建阶段：安装全部依赖并构建前端 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 复制清单先装依赖（利用层缓存）
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install

# 复制源码并构建前端（产物输出到根 dist/）
COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV UNION_NO_OPEN=true
# 默认监听地址：容器内 0.0.0.0 才能从宿主机访问
ENV HOST=0.0.0.0
ENV PORT=3800
# 数据目录（账号、自定义 API、日志等）落在可挂载卷。
# 注意：config.js 的 env() 只认 UNION_DATA_DIR / CODEBUDDY_DATA_DIR，裸 DATA_DIR 无效。
ENV UNION_DATA_DIR=/data

COPY --from=build /app /app

# 仅保留运行所需：依赖已装好；前端产物在 dist/
EXPOSE 3800

# 数据卷：持久化登录态、自定义 API 配置、数据库
VOLUME ["/data"]

CMD ["node", "server.js"]
