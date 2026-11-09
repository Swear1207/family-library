FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node ebook-files.mjs ./ebook-files.mjs
COPY --chown=node:node catalog.mjs file-types.mjs ./
COPY --chown=node:node catalog-store.mjs metadata-queue.mjs metadata-worker.mjs metadata-extractor.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
