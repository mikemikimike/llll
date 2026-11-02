---
title: Run a Server on Coolify
description: Deploy one L4 Server in Coolify from the published image, claim the Owner, add addresses and update by redeploying or pinning a version.
order: 3
---

The Coolify template runs one standalone L4 Server: L4 on a single celld node with private RustFS storage. Coolify's proxy owns the domain and TLS. The template uses the published `ghcr.io/inchidev/llll` image. It is public, so Coolify pulls it without a registry login and nothing is built on your machine.

It is not a published Coolify catalog entry yet. Copy the Compose file below.

## Install

1. In Coolify, choose **New Resource → Docker Compose** and paste the [Compose file](#compose-file).
2. Set the domain of the `llll` service, on port `8080`, and `ADMIN_EMAIL` (the first Owner's email). The deployment fails without `ADMIN_EMAIL`. Leave `LLLL_VERSION` unset to run `latest`.
3. Deploy. The first start takes a few minutes while the database migrations are applied.
4. Wait until `https://<your-domain>/api/setup/health` answers with HTTP 200.
5. Sign in with `ADMIN_EMAIL` and the password Coolify generated: `SERVICE_PASSWORD_ADMIN` in the service's environment variables. Then change the password in your account settings.

The first start creates the Owner from these values. Later changes to `SERVICE_PASSWORD_ADMIN` have no effect. To choose the password yourself, set `SERVICE_PASSWORD_ADMIN` (at least 12 characters) before the first deploy.

If the Server does not come up, read the logs of the `llll` container in Coolify; see also [Troubleshooting](../reference/troubleshooting.md).

Coolify generates these values for the template:

| Variable | Used as |
| --- | --- |
| `SERVICE_URL_LLLL_8080`, `SERVICE_FQDN_LLLL_8080` | The Server's public origin (`PUBLIC_ORIGIN`). |
| `SERVICE_PASSWORD_64_AUTHSECRET` | `AUTH_SECRET`. Signs sessions and encrypts stored credentials. |
| `SERVICE_PASSWORD_ADMIN` | `ADMIN_PASSWORD`. The first Owner's initial password. |
| `SERVICE_PASSWORD_64_SETUPTOKEN` | `SETUP_TOKEN`. Only used if the Owner is claimed on `/setup` instead. |
| `SERVICE_USER_RUSTFS`, `SERVICE_PASSWORD_64_RUSTFS` | Keys for the private storage bucket. |

> [!IMPORTANT]
> Keep these values private and never regenerate them. A new `AUTH_SECRET` signs out everyone and makes stored credentials unreadable.

`APP_NAME` sets the initial name (default `L4`). You can rename the Server later in Settings.

## Compose file

This is [`self-host/coolify/docker-compose.yaml`](https://github.com/inchidev/llll/blob/main/self-host/coolify/docker-compose.yaml) as of this release. Use **Copy** and paste it into Coolify unchanged.

```yaml
# documentation: https://github.com/inchidev/llll/blob/main/self-host/coolify/README.md
# slogan: Self-hosted team chat on a single VPS.
# category: collaboration
# tags: chat,team,celld,rustfs,self-host,llll
# logo: svgs/llll.png
# port: 8080

services:
  rustfs-perms:
    image: alpine:3.24
    user: "0:0"
    restart: "no"
    volumes:
      - rustfs-data:/data
    command:
      - sh
      - -c
      - chown -R 10001:10001 /data

  rustfs:
    image: rustfs/rustfs:1.0.4
    restart: always
    depends_on:
      rustfs-perms:
        condition: service_completed_successfully
    environment:
      - RUSTFS_VOLUMES=/data
      - RUSTFS_ADDRESS=0.0.0.0:9000
      - RUSTFS_CONSOLE_ENABLE=false
      - RUSTFS_ACCESS_KEY=$SERVICE_USER_RUSTFS
      - RUSTFS_SECRET_KEY=$SERVICE_PASSWORD_64_RUSTFS
      - RUSTFS_OBS_LOGGER_LEVEL=error
    volumes:
      - rustfs-data:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9000/health"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  bucket-init:
    image: amazon/aws-cli:2.39.2
    restart: "no"
    depends_on:
      rustfs:
        condition: service_healthy
    environment:
      - AWS_ACCESS_KEY_ID=$SERVICE_USER_RUSTFS
      - AWS_SECRET_ACCESS_KEY=$SERVICE_PASSWORD_64_RUSTFS
      - AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}
      - AWS_EC2_METADATA_DISABLED=true
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -eu
        aws configure set default.s3.addressing_style path
        i=0
        while [ "$$i" -lt 30 ]; do
          if aws s3api head-bucket --bucket cells --endpoint-url http://rustfs:9000 >/dev/null 2>&1; then
            exit 0
          fi
          if aws s3api create-bucket --bucket cells --endpoint-url http://rustfs:9000 --region us-east-1; then
            exit 0
          fi
          i=$$((i + 1))
          sleep 2
        done
        echo "could not create s3://cells" >&2
        exit 1

  # Updates are this image tag: latest follows stable releases, or pin a
  # version such as 0.3.4 and change it to update. Never set an older one.
  llll:
    image: ghcr.io/inchidev/llll:${LLLL_VERSION:-latest}
    # A celld node that loses its lease exits; Docker starts it again.
    restart: always
    stop_grace_period: 50s
    depends_on:
      bucket-init:
        condition: service_completed_successfully
      rustfs:
        condition: service_healthy
    environment:
      - SERVICE_URL_LLLL_8080
      - SERVICE_FQDN_LLLL_8080
      - PUBLIC_ORIGIN=$SERVICE_URL_LLLL_8080
      - LLLL_ORIGINS=${LLLL_ORIGINS:-}
      - AUTH_SECRET=$SERVICE_PASSWORD_64_AUTHSECRET
      - SETUP_TOKEN=$SERVICE_PASSWORD_64_SETUPTOKEN
      - ADMIN_EMAIL=${ADMIN_EMAIL:?}
      # Coolify generates the first Owner's password; the first start creates the Owner.
      - ADMIN_PASSWORD=$SERVICE_PASSWORD_ADMIN
      - APP_NAME=${APP_NAME:-L4}
      - AWS_ACCESS_KEY_ID=$SERVICE_USER_RUSTFS
      - AWS_SECRET_ACCESS_KEY=$SERVICE_PASSWORD_64_RUSTFS
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - AWS_EC2_METADATA_DISABLED=true
      - S3_ENDPOINT=http://rustfs:9000
      - CELLD_BUCKET=s3://cells
      - CELLD_WATCH=/var/lib/llll/celld
      - CELLD_DURABILITY=bucket
      - CELLD_READY_FLEET_GATE_MS=0
      - CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-}
      - CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-}
      - AI_BASE_URL=${AI_BASE_URL:-}
      - AI_API_KEY=${AI_API_KEY:-}
      - AI_MODEL=${AI_MODEL:-}
      - MAIL_GATEWAY_URL=${MAIL_GATEWAY_URL:-}
      - MAIL_GATEWAY_TOKEN=${MAIL_GATEWAY_TOKEN:-}
      - SMTP_GATEWAY_URL=${SMTP_GATEWAY_URL:-}
      - SMTP_GATEWAY_TOKEN=${SMTP_GATEWAY_TOKEN:-}
      - LLLL_EMAIL_DOMAINS=${LLLL_EMAIL_DOMAINS:-[]}
      - MAIL_APP_HOSTNAME=${MAIL_APP_HOSTNAME:-}
      - MAIL_DEFAULT_LOCAL_PART=${MAIL_DEFAULT_LOCAL_PART:-}
      - INBOUND_EMAIL_SECRET=${INBOUND_EMAIL_SECRET:-}
      - BROWSER_CDP_URL=${BROWSER_CDP_URL:-}
    volumes:
      - celld-data:/var/lib/llll/celld
    healthcheck:
      test: ["CMD", "/usr/local/bin/llll-healthcheck"]
      interval: 15s
      timeout: 5s
      retries: 12
      start_period: 240s

volumes:
  rustfs-data:
  celld-data:
```

## More addresses

To serve more domains, add them in Coolify and list every origin in `LLLL_ORIGINS`, comma-separated. The Server trusts only listed origins. RustFS has no public port.

## Updates

The image is built for `linux/amd64` and `linux/arm64`. Only stable releases are published as images, with three tags: the exact version (for example `0.3.5`), its minor line (`0.3`) and `latest`.

Updates are controlled in Coolify, not in L4:

- **Follow stable releases.** Leave `LLLL_VERSION` unset to use `latest`. Redeploy the service to pull the newest stable release.
- **Pin a version.** Set `LLLL_VERSION` to an exact version. Change it and redeploy to update.

On start, the new version applies its database migrations and skips ones already applied. Migrations only go forward: an older image refuses to start on data a newer one has migrated. If that happens, set a version at least as new as the one in the error.

In L4, **Server settings → Deployment → Updates** shows "Updates are managed outside L4" and tells you when a newer stable release exists.

![Server settings → Deployment → Updates on a Docker Server, showing the "Updates are managed outside L4" notice and a newer release link](screenshot:self-host-docker-updates "Docker and Coolify Servers update outside L4")

## Backups

Backups are optional but recommended before an update.

- **Server settings → Deployment → Backups** downloads the database and files, or sends them to an S3 destination.
- For a full copy, stop the service and archive the `rustfs-data` and `celld-data` volumes. A copy taken while the service runs may be inconsistent.

Keep backups outside these volumes. See [Files and backups](../concepts/files-and-backups.md).

## Optional providers

Cloudflare, AI and mail credentials are optional. The template accepts `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `MAIL_GATEWAY_URL`, `MAIL_GATEWAY_TOKEN`, `SMTP_GATEWAY_URL`, `SMTP_GATEWAY_TOKEN`, `LLLL_EMAIL_DOMAINS`, `MAIL_APP_HOSTNAME`, `MAIL_DEFAULT_LOCAL_PART`, `INBOUND_EMAIL_SECRET` and `BROWSER_CDP_URL`. See [Optional providers](docker.md#optional-providers) for what each one does.
