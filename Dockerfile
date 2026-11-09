FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && node -e "const {createCanvas}=require('@napi-rs/canvas');if(!createCanvas(2,2).toBuffer('image/png').length)process.exit(1)" \
    && npm cache clean --force
COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node ebook-files.mjs ./ebook-files.mjs
COPY --chown=node:node catalog.mjs file-types.mjs ./
COPY --chown=node:node catalog-store.mjs metadata-queue.mjs metadata-worker.mjs metadata-extractor.mjs ./
COPY --chown=node:node member-store.mjs cover-service.mjs cover-worker.mjs cover-renderer.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
