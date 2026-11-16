# Thin image of the agent sidecar (PLANO-AGENTES S7.1, §0.3.8): the same tarball as the npm package,
# installed globally. Build context = this directory with `tayet-agent.tgz` from `npm pack` (the
# release workflow and the local probe both make it). The credential comes only from the environment
# (TAYET_AGENT_TOKEN); no port is published by default.
# Base: node:22-bookworm-slim, pinned to the digest of infra/deploy/compose.yaml.
FROM node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

ENV NODE_ENV=production
COPY tayet-agent.tgz /tmp/tayet-agent.tgz
RUN npm install -g /tmp/tayet-agent.tgz \
  && rm /tmp/tayet-agent.tgz \
  && npm cache clean --force \
  && mkdir /data \
  && chown node:node /data

USER node
VOLUME /data
ENTRYPOINT ["tayet-agent","--store","/data","--listen","0.0.0.0:7878"]
