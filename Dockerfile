# HustVA API (crawler, embedding pipeline, chat). The embedding model runs in services/embedding.
FROM node:22-slim AS build
WORKDIR /app
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    CRAWL_DATA_DIR=/data/crawler \
    EMBEDDING_DATA_DIR=/data/embedding \
    TOOL_DATA_DIR=/data/tools
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/crawler /data/embedding /data/tools && chown -R node:node /data
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
