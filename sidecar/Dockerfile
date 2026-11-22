# Thin image of the agent sidecar (PLANO-AGENTES S7.1, §0.3.8): the same tarball as the npm package,
# installed globally. Build context = this directory with `tayet-agent.tgz` from `npm pack` (the
# release workflow and the local probe both make it). The credential comes only from the environment
# (TAYET_AGENT_TOKEN); no port is published by default.
# Base: node:22-bookworm-slim, pinned to the digest of infra/deploy/compose.yaml.
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

ENV NODE_ENV=production
COPY tayet-agent.tgz /tmp/tayet-agent.tgz
# The agent never calls npm, npx or corepack at runtime: once the tarball is installed, the package
# managers leave the image, so the npm bundled in the base is not shipped (nor scanned) with the agent.
RUN npm install -g /tmp/tayet-agent.tgz \
  && rm /tmp/tayet-agent.tgz \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm \
  && mkdir /data \
  && chown node:node /data

USER node
VOLUME /data
ENTRYPOINT ["tayet-agent","--store","/data","--listen","0.0.0.0:7878"]
