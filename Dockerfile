# syntax=docker/dockerfile:1

# A derived build on a customer base image is one build arg (SPEC §14):
#   docker build --build-arg BASE_IMAGE=registry.corp/node:22 .
ARG BASE_IMAGE=node:22-slim

# ---- build ----
FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM ${BASE_IMAGE} AS runtime

# Extra CA certificates (SPEC §9.1, §14): certs/ holds the public Russian Trusted Root CA for
# GigaChat; a corporate CA goes there too in a derived build, or is mounted at runtime with
# NODE_EXTRA_CA_CERTS pointing at a bundle that contains it. rejectUnauthorized: false is forbidden.
RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY certs/ /usr/local/share/ca-certificates/extra/
# The .crt files are in git (public CAs). If they are missing, GigaChat will not work,
# so say it in the build log instead of swallowing it.
RUN if ls /usr/local/share/ca-certificates/extra/*.crt >/dev/null 2>&1 && command -v update-ca-certificates >/dev/null 2>&1; then \
      update-ca-certificates && echo "CA: extra certificates installed"; \
    else \
      echo "WARNING: extra certificates not installed (no *.crt in certs/ or no update-ca-certificates)"; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
# group 0 can read everything: OpenShift runs the image under an arbitrary uid with gid 0.
# The journal directory exists owned by 1000:0, so a fresh named volume mounted there inherits it
RUN mkdir -p /var/lib/theloop/journal \
  && chown -R 1000:0 /var/lib/theloop && chmod -R g=u /var/lib/theloop \
  && chgrp -R 0 /app && chmod -R g=u /app

ENV NODE_ENV=production
# Non-root; nothing is written outside LOG_DIR, so a read-only root filesystem works (SPEC §14)
USER 1000
# Many platforms read the port from EXPOSE (SPEC §14)
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
