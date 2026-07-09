# Vault console for Ignite (BYOI / image deployment mode).
#
# Static host + same-origin /api proxy to the public backend (server.mjs),
# answering GET /healthz for the readiness probe. No build step, no npm install.
#
# Deploy (own FQDN, anonymous):
#   dodil ignite app deploy ask-your-notes-ui --code ./web --dockerfile-path Dockerfile \
#     --allow-unauthenticated --tier small \
#     --env BACKEND_URL=https://ask-your-notes-<org>.ignite.dodil.cloud/
FROM node:22-alpine
WORKDIR /app
COPY . /app
# Ignite runs pods non-root with a read-only root FS; write only under $HOME.
# The UID must be NUMERIC: Kubernetes' runAsNonRoot can't verify a named user
# (`node`) is non-root and fails with CreateContainerConfigError. `node` = UID 1000.
ENV HOME=/tmp/ignite
USER 1000
# Bind $PORT (Ignite default 80; non-root :80 is permitted on the dev clusters).
CMD ["node", "server.mjs"]
