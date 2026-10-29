# Imagem do Harpia para Coolify (ou qualquer Docker).

# 1) Compila a interface web.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY shared shared
COPY web web
RUN npm run build

# 2) Dependências do servidor. O node-pty é compilado aqui, por isso as ferramentas de build.
FROM node:24-bookworm-slim AS server-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

# 3) Imagem final.
FROM node:24-bookworm-slim
# tmux mantém as sessões dos agentes vivas; os demais são ferramentas que os agentes usam.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates tini tmux procps less ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

# Agentes de IA. Para atualizar, mude a versão e faça um novo deploy.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.312 @openai/codex@0.165.0 \
  && npm cache clean --force

WORKDIR /app
ENV NODE_ENV=production \
    HARPIA_HOST=0.0.0.0 \
    HARPIA_PORT=7420 \
    HARPIA_DATA_DIR=/data \
    HARPIA_WEB_DIR=/app/web/dist

COPY --from=server-deps /app/node_modules node_modules
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY shared shared
COPY server/src server/src
COPY --from=web /app/web/dist web/dist

# O servidor roda como root dentro do container para criar um usuário Linux por pessoa.
# Os agentes nunca rodam como root: cada um roda com o usuário de quem o abriu.
RUN mkdir -p /data

EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7420/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
