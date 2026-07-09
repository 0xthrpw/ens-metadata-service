# Node runtime image (the Workers deploy path is unaffected; see README).
# The bundle is self-contained except html-rewriter-wasm, which loads its
# .wasm sibling from disk at runtime and is copied over from the build stage.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY --from=build /app/node_modules/html-rewriter-wasm ./node_modules/html-rewriter-wasm
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
