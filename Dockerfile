# syntax=docker/dockerfile:1

# ---- build stage --------------------------------------------------------
# Compiles TypeScript to plain JS. Nothing here ever touches a real
# Firestore/Postgres credential -- only source code and dev tooling.
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY core ./core
RUN npm run build

# ---- runtime stage --------------------------------------------------------
# Lean image: only production dependencies + compiled JS. No tsx, no
# typescript, no @types/*, no test files. Runs as a non-root user.
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && addgroup --system centauri && adduser --system --ingroup centauri centauri

COPY --from=build /app/dist ./dist

USER centauri

# Secrets are NEVER read from a file baked into this image (see
# CENTAURI-DEV.md section 8 / product doc section 11): CENTAURI_POSTGRES_URL
# and the Firestore service account are supplied at `docker run` time only,
# e.g.:
#
#   docker run --rm -it \
#     -e CENTAURI_POSTGRES_URL="postgres://user:pass@host:5432/db" \
#     -v "$(pwd)/centauri.config.json:/app/centauri.config.json:ro" \
#     -v "$(pwd)/service-account.json:/app/service-account.json:ro" \
#     -v "$(pwd)/.centauri:/app/.centauri" \
#     centauri/migrate migrate --apply
#
# This image never accepts an ARG or ENV for either secret at build time --
# there is deliberately no such build argument to pass.
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["--help"]
