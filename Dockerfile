FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PDF_MCP_TRANSPORT=http \
    PDF_MCP_HOST=0.0.0.0 \
    PDF_MCP_PORT=3333 \
    PDF_MCP_HTTP_PATH=/mcp \
    PDF_MCP_OUTPUT_DIR=/data/output \
    PDF_MCP_ASSET_DIR=/data/assets \
    PDF_MCP_FONT_DIR=/data/fonts
RUN apt-get update && apt-get install -y --no-install-recommends qpdf ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data/output /data/assets /data/fonts \
    && chown -R node:node /app /data
WORKDIR /app
# Bundled OFL fonts (Inter, JetBrains Mono) so the image works without extra mounts.
COPY --chown=node:node assets/fonts/ /data/fonts/
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
