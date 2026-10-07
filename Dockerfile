# syntax=docker/dockerfile:1

# ---- build stage: syntax-check every JS file ----------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Run as the image's unprivileged "node" user.
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/src ./src

USER node
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node src/healthcheck.js || exit 1

CMD ["node", "src/server.js"]
