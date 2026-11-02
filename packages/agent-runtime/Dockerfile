FROM node:26.13.0-bookworm-slim AS build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global --ignore-scripts pnpm@10.30.3
WORKDIR /src
COPY --chmod=0644 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=0644 packages/agent-runtime/package.json packages/agent-runtime/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --filter @llll/agent-runtime --frozen-lockfile --ignore-scripts
COPY --chmod=0644 packages/agent-runtime/src packages/agent-runtime/src
# The modern deploy path derives a dedicated frozen lockfile. Legacy deploy
# re-resolves dependencies and can silently change the runtime between builds.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --config.inject-workspace-packages=true --filter @llll/agent-runtime deploy --prod /out

FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV LLLL_AGENT_DATA=/data PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
