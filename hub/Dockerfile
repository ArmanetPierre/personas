# Image du Hub Personas (AGPL-3.0). Contexte de construction : la racine du dépôt (monorepo :
# le Hub importe le moteur depuis src/ pour valider les modules et calculer Q).
#   docker build -f hub/Dockerfile -t personas-hub .
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
# Dépendances de développement comprises : le Hub tourne par tsx, comme le tableau de bord local.
# --ignore-scripts : l'image n'a ni Python ni compilateur, et npm lancerait `node-gyp rebuild` pour
# better-sqlite3 (binding.gyp sans script d'installation). Ses binaires précompilés (prebuilds/) et
# ceux d'esbuild (paquets optionnels par plateforme) suffisent ; le Hub n'utilise pas SQLite.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY packs ./packs
COPY hub ./hub
# Jetons de la direction artistique, partagés avec le tableau de bord (pages publiques du Hub)
COPY web/src/tokens.css ./web/src/tokens.css

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "hub/src/server.ts"]
