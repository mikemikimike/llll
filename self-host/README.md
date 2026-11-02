# Self-host with Docker

The common Compose runs L4 on a single [celld](https://celld.dev) node, with private [RustFS](https://github.com/rustfs/rustfs) storage and a Caddy gateway. For convenient local development from the repository root, use `pnpm dev:stack`; see [local development](../docs/local-development.md). The [VPS installer](../docs/vps-installer.md) reuses this stack with a small public-HTTPS override; it first ships in `0.2.0-alpha.7`. The same deployment without Docker is [Self-host on celld](../docs/self-host/celld.md).

celld 0.6.3 has no secrets store. On startup the container writes `self-host/.env` into a gitignored `wrangler.celld.local.json` and `celld deploy` stores that `vars` object in the bucket as plaintext. Keep the RustFS volume private. Do not publish port 9000.

The image build sets `NODE_OPTIONS=--max-old-space-size=6144`. Building needs a machine with about 8 GB of free RAM. A published image skips that build on the VPS.

## Quickstart

From this directory:

```bash
cp .env.example .env
openssl rand -hex 32   # use one value for AUTH_SECRET and another for SETUP_TOKEN
# edit .env: PUBLIC_ORIGIN, AUTH_SECRET, ADMIN_EMAIL, SETUP_TOKEN, RustFS keys
# Local source build:
docker compose -f docker-compose.yml -f compose.build.yml up -d --build --wait
# Or set LLLL_IMAGE=llll:<version> in .env after loading a verified release:
# docker compose up -d --wait
```

Caddy listens on `127.0.0.1:8080` (`LLLL_HTTP_PORT` changes the host port). Neither celld nor RustFS publishes a host port. The app container stays unhealthy until `celld d1 migrations apply` finishes; Caddy starts after that, and `http://127.0.0.1:8080/api/setup/health` returns HTTP 200. On celld the app does not create tables itself. A request that applied the bundled schema would leave those tables out of `d1_migrations`, and the next apply would stop on `table already exists`.

Then open `/setup`, enter `SETUP_TOKEN` and create the owner. `PUBLIC_ORIGIN` must be the origin you use in the browser. To serve additional hostnames, set `LLLL_ORIGINS` to a comma-separated list of origins and route all of them to the same container; the VPS installer manages this and the Caddy addresses together with `llll domain`.

`AUTH_SECRET` and `SETUP_TOKEN` must each be at least 32 characters. The tracked `wrangler.celld.json` keeps the placeholder `invalid` on purpose. The container replaces it at startup and does not commit the result.

A celld node that misses its own lease renews by fencing itself and exiting. Compose sets `restart: always`, so Docker starts the container again. The entrypoint waits 15 seconds on that restart (`CELLD_RESTART_DELAY`) so the old lease can expire before the new process binds the node. `rustfs-perms` and `bucket-init` are one-shot and use `restart: "no"`.

RustFS is not published to the host. One Docker volume holds the fleet bucket.

## Reverse proxy and TLS

The included gateway defaults to local HTTP. For public use, leave it bound to loopback and terminate TLS in front of it. Set `PUBLIC_ORIGIN` to the public HTTPS origin, then recreate:

```bash
docker compose up -d
```

Caddy on the host:

```caddy
chat.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

nginx must forward WebSocket upgrades for chat:

```nginx
server {
  server_name chat.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

To expose the gateway on every interface instead of loopback, set `LLLL_BIND=0.0.0.0` in `.env`. Configure public TLS before inviting anyone. The [managed VPS flow](../docs/vps-installer.md) adds `compose.vps.yml` and `Caddyfile.vps` for container-managed public TLS.

## Upgrade

Take and verify a private backup first. Each release includes `llll-runtime-linux-amd64.tar.gz` and `SHA256SUMS`. Verify the checksum, then run `docker load --input llll-runtime-linux-amd64.tar.gz`. It loads `llll:<version>` locally. Set `LLLL_IMAGE=llll:<version>` in `.env`, then run `docker compose up -d --wait`. The common Compose has no build block and uses `pull_policy: never`. The published image is currently `linux/amd64`; local source/development builds use the Docker host's native architecture.

Stable releases are also published as `ghcr.io/inchidev/llll:<version>` for `linux/amd64` and `linux/arm64`; `docker pull` it and set `LLLL_IMAGE` to that name instead of loading the archive.

The new container deploys that image and runs `celld d1 migrations apply <database_name>` again. Migrations only go forward: the container refuses to start an image older than the release that last migrated its data. Recorded migrations are skipped. Expect a short outage while the single node restarts. Managed VPS installations use `llll backup`, `llll upgrade` and `llll restore`; see the [installer operations](../docs/vps-installer.md#operations). The raw Compose commands here remain manual. For local source verification only, use the `compose.build.yml` override with `--build`.

Do not change `AUTH_SECRET` during an upgrade. It signs sessions, and backup credentials stored by the app are encrypted with it.

## Backup

Stop the stack, then copy both volumes and `.env`:

The names below assume the raw Compose project `llll`. The local launcher prints its per-worktree project name in `pnpm stack -- status`; use that prefix for its volumes instead. Keep backup archives outside these live volumes and preserve them when removing a Server.

```bash
docker compose stop
docker run --rm -v llll_rustfs-data:/from -v "$PWD":/to alpine:3.24 \
  tar -C /from -czf /to/rustfs-data.tgz .
docker run --rm -v llll_celld-data:/from -v "$PWD":/to alpine:3.24 \
  tar -C /from -czf /to/celld-data.tgz .
docker compose start
```

`rustfs-data` is the fleet bucket: D1, Durable Object storage, KV, server files, and the deployment, including plaintext Worker variables. `celld-data` is the node's local work directory. `.env` holds `AUTH_SECRET` and the RustFS keys. Store all three as private data.

Restore by stopping the stack, extracting those archives back onto empty volumes with the same names, and starting again. Keep the same `.env`.

Server Settings → Backups can also download a TAR of D1 SQL and R2 objects. That archive does not include the celld deployment, KV, or live Durable Object state. To load its SQL into this node while the stack is up, copy `restore.sql` into the L4 container and run:

```bash
docker compose exec llll \
  celld d1 execute llll /opt/llll/wrangler.celld.local.json \
  --file /path/inside/container/restore.sql \
  --bucket s3://cells
```

The database argument is the `database_name` (`llll` unless you set `DATABASE_NAME`). Concatenate the archive's `database/*.sql` files in order before importing. See [Manual server backups](../docs/deployment.md#manual-server-backups).

## Troubleshooting

- **`bucket-init` fails with "could not reach or create"** while RustFS is healthy: the host drops traffic between containers, typically legacy iptables with `-P FORWARD DROP`. Allow the Compose bridge, for example `iptables -I DOCKER-USER -i br-<id> -j ACCEPT`, and make the rule persistent.
- **Hosts without systemd** (containers, some minimal images): start `dockerd` yourself and arrange for it to start after a reboot; Compose's `restart: unless-stopped` only applies once Docker is running.
- **"waiting for the celld node to join"** on first start is expected: migrations apply as soon as the node registers.

## Coolify

[self-host/coolify](coolify/README.md) runs the published `ghcr.io/inchidev/llll` image. It uses Coolify's `SERVICE_FQDN_*` and `SERVICE_PASSWORD_*` variables, and Coolify's proxy owns the domain and TLS. Updates are an image tag: redeploy `latest` or set a newer `LLLL_VERSION`. Set `ADMIN_EMAIL` before the first deploy.

## Optional integrations

Empty values in `.env` are omitted from the generated Wrangler file.

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` call Workers AI, Browser Run, Email Sending, and RealtimeKit over REST. The account id is 32 hex characters. The token must be at least 32 characters. Without them, the owner can still connect calls in Settings → Live with a Realtime Admin token.
- `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` are the OpenAI-compatible fallback when that token is not set.
- `MAIL_GATEWAY_URL` / `MAIL_GATEWAY_TOKEN` or `SMTP_GATEWAY_URL` / `SMTP_GATEWAY_TOKEN` send outbound mail. The process does not open an SMTP port.
- `INBOUND_EMAIL_SECRET`, `POSTMARK_INBOUND_SECRET`, `MAILGUN_WEBHOOK_SIGNING_KEY`, and `SES_SNS_TOPIC_ARN` enable inbound webhooks. Secrets must be at least 32 characters.
- `BROWSER_CDP_URL` is a private Chromium DevTools URL.

Inbound routes, mailbox vars, and the feature matrix are in [Self-host on celld](../docs/self-host/celld.md).
