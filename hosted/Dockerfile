# Image du service hébergé Personas (phase 4). Contexte de construction : la racine du dépôt.
#   docker build -f hosted/Dockerfile -t personas-hosted .
# Le front est compilé dans l'image (web/dist) ; l'API et le front sont servis sur le port 8081.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
COPY src ./src
RUN npx vite build --config web/vite.config.ts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PERSONAS_MODE=hosted \
    PORT=8081 \
    HOST=0.0.0.0 \
    HOSTED_DATA_ROOT=/data \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
# Le service tourne par tsx (comme le Hub). better-sqlite3 : binaires précompilés (prebuilds/), sans compilateur.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY packs ./packs
COPY modules ./modules
COPY pricing ./pricing
COPY calibration/payment-v3.json ./calibration/payment-v3.json
COPY docs/modules.md ./docs/modules.md
COPY examples/meal-planner.json ./examples/meal-planner.json
COPY examples/sg/recipe-app.yaml ./examples/sg/recipe-app.yaml
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/api/meta').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/hosted/server.ts"]
