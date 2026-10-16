# The players' feedback board (/feedback). Build context: this directory. One Node process, node:sqlite, no npm packages.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
# Inside the container it listens on all interfaces; publish it on host loopback only (127.0.0.1:3150:3150), because
# X-Real-IP / X-Ark-Session are trusted as set by nginx.
ENV NODE_ENV=production FEEDBACK_HOST=0.0.0.0 FEEDBACK_PORT=3150 FEEDBACK_DB=/data/feedback.sqlite UV_THREADPOOL_SIZE=2
WORKDIR /app
COPY server.mjs store.mjs policy.mjs ./
COPY public/ ./public/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3150
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3150/feedback/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
