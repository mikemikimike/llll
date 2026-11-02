---
title: Run a Server with Docker Compose
description: Run one L4 Server with Docker Compose behind your own reverse proxy, then update it by changing the image tag.
order: 2
---

The common Docker Compose stack runs one standalone L4 Server on a single [celld](https://celld.dev) node, with private [RustFS](https://github.com/rustfs/rustfs) storage and a Caddy gateway. Use it when you want to manage Docker yourself, or when the machine already has a reverse proxy. For a managed install with HTTPS, backups and rollback, use the [VPS installer](vps.md). For Coolify, see [Coolify](coolify.md).

## What runs

| Service | Role |
| --- | --- |
| `llll` | The Server on celld. No host port is published. |
| `rustfs` | Private S3 bucket that holds the database, Durable Object storage, KV, files and the deployment. No host port is published. |
| `rustfs-perms`, `bucket-init` | One-shot helpers that prepare the volume and create the bucket. |
| `gateway` | Caddy. Listens on `127.0.0.1:8080` by default. |

The stack uses four volumes: `rustfs-data`, `celld-data`, `caddy-data` and `caddy-config`.

> [!WARNING]
> celld has no secrets store. On start the container writes your `.env` into the deployment, which celld stores as plaintext in the RustFS bucket. Keep the RustFS volume private and never publish port 9000.

## Get the image

Pick one:

- **Published image (stable releases).** `ghcr.io/inchidev/llll:<version>`, `:<minor>` (for example `0.3`) and `:latest`, for `linux/amd64` and `linux/arm64`. Prereleases are not published as images.
- **Release archive.** Each release includes `llll-runtime-linux-amd64.tar.gz` and `SHA256SUMS`. Verify the checksum, then `docker load --input llll-runtime-linux-amd64.tar.gz`. This loads `llll:<version>` locally.

The common Compose file uses `pull_policy: never`, so pull the published image yourself before starting:

```bash
docker pull ghcr.io/inchidev/llll:latest
```

## Set up

1. Get the `self-host` folder from the release you run, for example:

   ```bash
   git clone --depth 1 --branch v<version> https://github.com/inchidev/llll.git
   cd llll/self-host
   ```

2. Create the private configuration:

   ```bash
   cp .env.example .env
   openssl rand -hex 32   # run twice: one value for AUTH_SECRET, one for SETUP_TOKEN
   ```

3. Edit `.env`:

   | Key | Value |
   | --- | --- |
   | `PUBLIC_ORIGIN` | The origin members open, for example `https://chat.example.com`. |
   | `AUTH_SECRET` | Random, at least 32 characters. Signs sessions and encrypts stored credentials. |
   | `SETUP_TOKEN` | Random, at least 32 characters. Used once to claim the Owner. |
   | `ADMIN_EMAIL` | Email of the first Owner. |
   | `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` | Keys for the private bucket. |
   | `LLLL_IMAGE` | `ghcr.io/inchidev/llll:<version>` or `llll:<version>`. |

4. Start the stack:

   ```bash
   docker compose up -d --wait
   ```

5. Open `<PUBLIC_ORIGIN>/setup`, enter `SETUP_TOKEN` and create the Owner. `<PUBLIC_ORIGIN>/setup#claim=<SETUP_TOKEN>` skips the token field. If `.env` sets `ADMIN_PASSWORD` (at least 12 characters), the first start creates the Owner instead: sign in with `ADMIN_EMAIL` and that password, then change it.

The `llll` container stays unhealthy until its database migrations have been applied. Caddy starts after that, and `/api/setup/health` returns HTTP 200. On first start, the log line `waiting for the celld node to join` is expected.

> [!IMPORTANT]
> Never change `AUTH_SECRET` after setup. It signs sessions, and credentials the Server stores (such as backup keys and provider keys) are encrypted with it.

## Reverse proxy and TLS

The gateway listens on loopback HTTP. For public use, keep it on loopback and terminate TLS in front of it. Set `PUBLIC_ORIGIN` to the public HTTPS origin and run `docker compose up -d` again.

Caddy on the host:

```text
chat.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

nginx must forward WebSocket upgrades for chat:

```text
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

`LLLL_HTTP_PORT` changes the host port. `LLLL_BIND=0.0.0.0` exposes the gateway on every interface; configure TLS before you invite anyone.

### More than one address

To serve extra hostnames, set `LLLL_ORIGINS` to a comma-separated list of origins and route all of them to the same container. Only listed origins are trusted. `PUBLIC_ORIGIN` stays the [primary address](../concepts/server-and-shell.md#addresses).

## Update

Updates are an image tag. L4 Settings does not update a Docker Server; **Server settings → Deployment → Updates** says that updates are managed outside L4 and shows when a newer stable release exists.

1. Take and verify a backup (below).
2. Pull or load the new image and set `LLLL_IMAGE` to it in `.env`.
3. Run `docker compose up -d --wait`.

On start, the container applies the new database migrations; ones already applied are skipped. Expect a short outage while the single node restarts.

Migrations only go forward. The container records the release that last migrated its data and refuses to start an older image:

```text
llll: this data was migrated by L4 0.3.4; image 0.3.3 is older. Use 0.3.4 or newer.
```

To go back, restore a backup instead.

## Back up and restore

Stop the stack, then copy both data volumes and `.env`. The names below assume the Compose project `llll`:

```bash
docker compose stop
docker run --rm -v llll_rustfs-data:/from -v "$PWD":/to alpine:3.24 \
  tar -C /from -czf /to/rustfs-data.tgz .
docker run --rm -v llll_celld-data:/from -v "$PWD":/to alpine:3.24 \
  tar -C /from -czf /to/celld-data.tgz .
docker compose start
```

- `rustfs-data` holds the database, Durable Object storage, KV, Server files and the deployment, including plaintext Worker variables.
- `celld-data` is the node's local work directory.
- `.env` holds `AUTH_SECRET` and the RustFS keys.

Store all three privately and outside the live volumes. To restore, stop the stack, extract the archives onto empty volumes with the same names, keep the same `.env` and start again.

**Server settings → Deployment → Backups** can also download an archive of the database and files, or send it to an S3 destination. That archive does not include the celld deployment, KV or live Durable Object state. See [Files and backups](../concepts/files-and-backups.md).

## Optional providers

Text chat, Tasks, files and backups work without any provider. Add these keys to `.env` to turn on more. Empty values are ignored.

| Keys | Turns on |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI, Browser Run (page reading), Email Sending and RealtimeKit calls over Cloudflare's REST API. The account ID is 32 hex characters. |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | An OpenAI-compatible model endpoint, used when the Cloudflare token is not set. Set all three. |
| `MAIL_GATEWAY_URL`, `MAIL_GATEWAY_TOKEN` or `SMTP_GATEWAY_URL`, `SMTP_GATEWAY_TOKEN` | Outbound mail through an HTTP gateway you run. The Server does not open an SMTP port. |
| `INBOUND_EMAIL_SECRET`, `POSTMARK_INBOUND_SECRET`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `SES_SNS_TOPIC_ARN` | Inbound mail through a signed webhook. Secrets must be at least 32 characters. |
| `BROWSER_CDP_URL` | A private Chromium DevTools endpoint for page reading. Do not publish its port. |

`/api/setup/health` reports which provider the Server chose. The [celld reference](https://github.com/inchidev/llll/blob/main/docs/self-host/celld.md) documents each provider, the token permissions and the inbound mail setup in detail.

Without a Cloudflare token, calls stay unavailable and the call button is disabled; text chat keeps working.

## Build from source

`compose.build.yml` adds a local source build:

```bash
docker compose -f docker-compose.yml -f compose.build.yml up -d --build --wait
```

The build needs about 8 GB of free RAM. Use it to test source changes, not to run a community Server.
