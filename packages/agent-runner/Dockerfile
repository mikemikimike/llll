FROM docker:29.9.2-cli AS docker
FROM node:26.13.0-bookworm-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/runner
COPY --chmod=0644 src ./src
EXPOSE 8081
CMD ["node", "src/server.mjs"]
