# Official 9router image + Litestream, so the SQLite DB survives container sleeps/restarts.
# Cloudflare Container disks are ephemeral; Litestream replicates the DB to R2 and restores it on boot.
# Container instances must be linux/amd64 (Cloudflare requirement).
ARG NINE_ROUTER_VERSION=0.5.112

FROM litestream/litestream:0.3.13 AS litestream

FROM decolua/9router:${NINE_ROUTER_VERSION}
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY start.sh /start.sh
# The base image's /entrypoint.sh chowns the data dirs and drops to the "node" user.
# start.sh runs first (as root), restores the DB, then hands off to /entrypoint.sh via Litestream.
RUN chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
CMD ["node", "custom-server.js"]
