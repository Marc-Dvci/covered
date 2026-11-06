# Covered on Node, for running anywhere. The deployed service runs the same routes on Cloudflare.
#   docker build -t covered . && docker run --rm -p 127.0.0.1:8787:8787 covered      the demo: no keys, deterministic PayPal stand-in, recorded model answers
#   docker build --target app -t covered-app . && docker run --env-file .env ...      your own PayPal sandbox and Gemini keys
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY shared ./shared
COPY eval ./eval
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8787 COVERED_DB_FILE=var/covered.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY shared ./shared
COPY data ./data
COPY --from=build /app/dist ./dist
RUN mkdir -p var && chown -R node:node var
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]

FROM runtime AS app

# last stage, so a plain `docker build` gives the demo
FROM runtime AS demo
ENV PAYPAL_CLIENT_ID= PAYPAL_CLIENT_SECRET= GEMINI_API_KEY=
