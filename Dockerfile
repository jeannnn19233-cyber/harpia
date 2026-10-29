# Imagem do Harpia para Coolify (ou qualquer Docker).

# 1) Compila a interface web.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY web web
RUN npm run build

# 2) Imagem final: só o servidor e a interface já compilada.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HARPIA_HOST=0.0.0.0 \
    HARPIA_PORT=7420 \
    HARPIA_DATA_DIR=/data \
    HARPIA_WEB_DIR=/app/web/dist

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force

COPY shared shared
COPY server/src server/src
COPY --from=web /app/web/dist web/dist

# Pasta de dados: monte um volume persistente aqui no Coolify.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7420/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
