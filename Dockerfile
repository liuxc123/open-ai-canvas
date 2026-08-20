# syntax=docker/dockerfile:1.7

# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
ARG VITE_TLDRAW_LICENSE_KEY
ENV VITE_TLDRAW_LICENSE_KEY=${VITE_TLDRAW_LICENSE_KEY}
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：nginx 托管静态前端，并在 Compose 中把 /api 转发到后端服务。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
# nginx 官方镜像会在启动时对 /etc/nginx/templates/*.template 做 envsubst 渲染
COPY nginx.conf /etc/nginx/templates/default.conf.template

# 端口默认值：容器未注入环境变量时生效，compose 中由 .env 覆盖
ENV CANVAS_WEB_PORT=3000
ENV CANVAS_BACKEND_PORT=8080

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${CANVAS_WEB_PORT}/ >/dev/null || exit 1
