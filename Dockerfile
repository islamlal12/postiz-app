FROM node:22.23.4-bookworm-slim
ARG NEXT_PUBLIC_VERSION
ENV NEXT_PUBLIC_VERSION=$NEXT_PUBLIC_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    nginx \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

RUN addgroup --system www \
 && adduser --system --ingroup www --home /www --shell /usr/sbin/nologin www \
 && mkdir -p /www \
 && chown -R www:www /www /var/lib/nginx

RUN npm --no-update-notifier --no-fund --global install pnpm@10.6.1 pm2 \
 && npm cache clean --force

WORKDIR /app

COPY . /app
COPY var/docker/nginx.conf /etc/nginx/nginx.conf

RUN pnpm install --frozen-lockfile=false \
 && pnpm store prune

RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build \
 && pnpm store prune

CMD ["sh", "-c", "nginx && pnpm run pm2"]
