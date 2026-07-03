# Build stage: install dependencies, compile the native module, and build the
# TypeScript. better-sqlite3 compiles native code, so the build tools are needed
# here but not in the final image.
FROM node:20-slim AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Recompile better-sqlite3 from source against this image's own glibc. The
# binary npm downloads is prebuilt against a newer glibc than the Debian base
# provides, so it would fail to load at runtime with a GLIBC version error.
# build-release runs node-gyp directly and does not consult the prebuild.
RUN cd node_modules/better-sqlite3 && npm run build-release

COPY . .
RUN npm run build

# Remove development dependencies while keeping the compiled better-sqlite3
# binary, so the runtime image carries only what it needs.
RUN npm prune --omit=dev

# Runtime stage: just Node, the compiled app, and production dependencies.
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The database lives here and is mounted as a volume at runtime. Make it owned
# by the non-root user the container runs as.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
CMD ["node", "dist/src/index.js"]
