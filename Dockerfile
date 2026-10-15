# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runtime

# Russian Trusted Root CA certificates for GigaChat (SPEC §9.1, §14).
# The .crt files live in certs/ (see certs/README.md). Without them TLS to GigaChat
# fails; rejectUnauthorized: false is forbidden.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY certs/ /usr/local/share/ca-certificates/extra/
# The .crt files are in git (public CAs). If they are missing, GigaChat will not work,
# so say it in the build log instead of swallowing it.
RUN if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1; then \
      update-ca-certificates && echo "CA: extra certificates installed"; \
    else \
      echo "WARNING: no *.crt in certs/ — GigaChat will not work (see certs/README.md)"; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
# Many platforms read the port from EXPOSE (SPEC §14)
EXPOSE 8080
CMD ["node", "dist/index.js"]
