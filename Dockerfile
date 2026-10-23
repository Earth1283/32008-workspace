FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9000 \
    DB_PATH=/app/data/008.db

WORKDIR /app

# No npm install: the server has no runtime dependencies.
COPY package.json ./
COPY server ./server
COPY public ./public

# The database lives here. Mount a volume on it so data survives new containers.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data

USER node
EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
