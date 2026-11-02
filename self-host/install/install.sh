#!/usr/bin/env bash
# Release template. Build with scripts/build-vps-release.mjs; never publish this file.
# Definitions alone have no side effects. main is called only on the final line.

fail() { printf 'llll: %s\n' "$*" >&2; exit 1; }
say() { printf 'llll: %s\n' "$*"; }
docker() { command docker --host unix:///var/run/docker.sock "$@"; }
compose() {
  # Shell env has priority over --env-file in Compose. Keep operator login-shell
  # variables and remote Docker contexts from silently changing a managed Server.
  env -i PATH="$PATH" docker --host unix:///var/run/docker.sock compose --project-name "$project" --project-directory "$dir" --env-file "$dir/.env" -f "$dir/llll-compose.yml" -f "$dir/compose.vps.yml" "$@"
}
compose_up() {
  say 'Waiting for Server containers. This can take several minutes.'
  local pid status=0 elapsed=0 pause=${LLLL_COMPOSE_POLL:-15}
  [[ $pause =~ ^[0-9]+$ ]] || pause=15
  compose up -d --wait --wait-timeout 600 >/dev/null &
  pid=$!
  # Poll every second. A finished Compose must not wait out the whole progress interval.
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [[ $pause -gt 0 && $((elapsed % pause)) -eq 0 ]] && kill -0 "$pid" 2>/dev/null; then
      say 'Still waiting for Server containers.'
    fi
  done
  wait "$pid" || status=$?
  return "$status"
}
cleanup() {
  local code=$?
  trap - EXIT
  if [[ $restart_needed == true ]]; then compose start >/dev/null || say 'Could not restart; run llll start.' >&2; fi
  [[ -z $stage ]] || rm -rf -- "$stage"
  exit "$code"
}
get_env() {
  # Generated values are single-quoted dotenv strings, never shell-sourced.
  local value
  value=$(sed -n "s/^$1=//p" "$dir/.env")
  [[ $value != *$'\n'* ]] || fail "Duplicate $1 in .env"
  value=${value#\'}; value=${value%\'}
  printf '%s' "$value"
}
put_env() {
  local key=$1 value=$2 target=$3
  [[ $value != *"'"* && $value != *$'\n'* && $value != *$'\r'* && $value != *'\'* ]] || fail "Unsupported characters in $key"
  printf "%s='%s'\n" "$key" "$value" >> "$target"
}
replace_env() {
  local key=$1 value=$2 file=$3 tmp
  tmp=$(mktemp "$stage/env.XXXXXXXX")
  sed "/^$key=/d" "$file" > "$tmp"
  put_env "$key" "$value" "$tmp"
  install -m 600 "$tmp" "$file"
  rm -f -- "$tmp"
}
need() { command -v "$1" >/dev/null || fail "Install prerequisite $1 first (apt install ca-certificates curl jq openssl util-linux)."; }
uuid4() {
  # The one UUID this Server keeps forever: the Worker name, its resources and
  # server_identity all share it.
  local value
  value=$(cat /proc/sys/kernel/random/uuid 2>/dev/null) || fail 'This kernel does not provide a random UUID source.'
  [[ $value =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail 'Invalid UUID source.'
  printf '%s' "$value"
}
version_newer() {
  # SemVer identifiers: numeric identifiers compare numerically (as strings of
  # arbitrary length), precede text identifiers, and a final release sorts last.
  jq -en --arg next "$1" --arg old "$2" '
    def key:
      capture("^(?<a>0|[1-9][0-9]*)\\.(?<b>0|[1-9][0-9]*)\\.(?<c>0|[1-9][0-9]*)(?:-(?<pre>[0-9A-Za-z.-]+))?$") |
      [.a, .b, .c] as $core |
      ($core | map([length, .])) +
      [if .pre == null then [1] else [0, (.pre | split(".") | map(
        if test("^[0-9]+$") then if test("^0[0-9]") then error("leading zero") else [0, length, .] end
        elif length == 0 then error("empty identifier") else [1, .] end))] end];
    ($next | key) > ($old | key)' >/dev/null
}
fetch() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 20 --max-time 900 --retry 3 "$1" -o "$2"; }
check_hash() { [[ $(sha256sum "$2" | cut -d' ' -f1) == "$1" ]] || fail "Checksum mismatch: $(basename "$2"); no installation files or data were changed."; }
manifest_hash() {
  local name=$1 hash
  hash=$(jq -er --arg name "$name" '.files[$name].sha256 | select(test("^[a-f0-9]{64}$"))' "$stage/llll-release.json") || fail "Release does not include $name"
  [[ $(awk -v n="$name" '$2==n {print $1}' "$stage/SHA256SUMS") == "$hash" ]] || fail "Manifest and SHA256SUMS disagree: $name"
  printf '%s' "$hash"
}
sum_hash() {
  local hash
  hash=$(awk -v n="$1" '$2==n {print $1}' "$stage/SHA256SUMS")
  [[ $hash =~ ^[a-f0-9]{64}$ ]] || fail "Missing or duplicate checksum: $1"
  printf '%s' "$hash"
}
release_metadata() {
  local version=$1
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'Use a release version, for example 1.0.0 or 0.2.0-alpha.7.'
  base="https://github.com/inchidev/llll/releases/download/v$version"
  fetch "$base/llll-release.json" "$stage/llll-release.json"
  fetch "$base/SHA256SUMS" "$stage/SHA256SUMS"
  local hash
  hash=$(sum_hash llll-release.json)
  check_hash "$hash" "$stage/llll-release.json"
}
validate_metadata() {
  jq -e --arg version "$1" '.schemaVersion == 3 and .version == $version and (.releasePr > 0) and (.commit | test("^[a-f0-9]{40}$"))' "$stage/llll-release.json" >/dev/null || fail 'Invalid release provenance'
}
verified_payload() {
  release_metadata "$pinned_version"
  local expected name hash
  expected=$(sum_hash llll-runtime-linux-amd64.tar.gz)
  [[ $expected == "$runtime_sha" ]] || fail 'Runtime checksum differs from installer pin'
  fetch "$base/llll-runtime-linux-amd64.tar.gz" "$stage/llll-runtime-linux-amd64.tar.gz"
  check_hash "$runtime_sha" "$stage/llll-runtime-linux-amd64.tar.gz"
  while read -r hash name; do
    [[ $(sum_hash "$name") == "$hash" ]] || fail "Installer pin differs: $name"
    fetch "$base/$name" "$stage/$name"
    check_hash "$hash" "$stage/$name"
  done <<< "$asset_pins"
  # Verify our CLI too, before installing it. Do not trust a mutable script URL.
  hash=$(sum_hash llll)
  fetch "$base/llll" "$stage/llll"
  check_hash "$hash" "$stage/llll"
  [[ $(sha256sum "$stage/llll" | cut -d' ' -f1) == $(sum_hash install.sh) ]] || fail 'CLI and installer must be identical'
}
validate_payload_metadata() {
  validate_metadata "$pinned_version"
  [[ $(jq -r .commit "$stage/llll-release.json") == "$pinned_commit" ]] || fail 'Release commit differs from installer pin'
  local hash name
  while read -r hash name; do [[ $(manifest_hash "$name") == "$hash" ]] || fail "Manifest differs from installer pin: $name"; done <<< "$asset_pins"
  [[ $(manifest_hash llll-runtime-linux-amd64.tar.gz) == "$runtime_sha" ]] || fail 'Manifest runtime mismatch'
  check_hash "$(manifest_hash llll)" "$stage/llll"
}
preflight() {
  [[ $EUID == 0 ]] || fail 'Run as root (sudo bash install.sh).'
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'VPS releases currently support Linux amd64 only; ARM64 local development is separate.'
  # OS metadata is supplied by the distribution, never by a release download.
  . /etc/os-release
  case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;; *) fail 'Supported VPS systems: Debian 12/13 and Ubuntu 22.04/24.04.' ;; esac
  os=$ID; codename=$VERSION_CODENAME
  for tool in curl sha256sum flock tar awk sed df; do need "$tool"; done
  [[ $(awk '/MemTotal:/ {print $2}' /proc/meminfo) -ge 1900000 ]] || fail 'At least 2 GiB RAM is required.'
  [[ $(df -Pk /var/tmp | awk 'END {print $4}') -ge 5242880 ]] || fail 'At least 5 GiB free disk space is required.'
  [[ ! -x /snap/bin/docker ]] || fail 'Snap Docker is unsupported; install Docker Engine from its official apt repository.'
  [[ ${LLLL_AUTOUPDATE:-false} == false && -z ${LLLL_BACKUP_SCHEDULE:-} ]] || fail 'Scheduled updates/backups are not supported yet; use explicit llll upgrade and llll backup.'
}
ensure_prerequisites() {
  if ! command -v jq >/dev/null || ! command -v openssl >/dev/null || ! command -v ss >/dev/null; then
    apt-get update
    apt-get install -y ca-certificates jq openssl iproute2
  fi
}
ensure_docker() {
  if ! command -v docker >/dev/null; then
    [[ ${LLLL_SKIP_DOCKER_INSTALL:-false} != true ]] || fail 'Docker is missing and LLLL_SKIP_DOCKER_INSTALL=true.'
    # Do not uninstall or replace an existing container runtime on the operator's host.
    if dpkg-query -W -f='${Status}\n' docker.io podman-docker containerd runc 2>/dev/null | grep -q 'install ok installed'; then fail 'Existing container runtime detected; install Docker Engine manually before retrying.'; fi
    apt-get update
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    fetch "https://download.docker.com/linux/$os/gpg" "$stage/docker.asc"
    install -m 0644 "$stage/docker.asc" /etc/apt/keyrings/docker.asc
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$os" "$codename" > /etc/apt/sources.list.d/llll-docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
  fi
  local major compose_version
  major=$(docker version --format '{{.Server.Version}}' | cut -d. -f1)
  [[ $major =~ ^[0-9]+$ && $major -ge 24 ]] || fail 'Docker Engine >= 24 must be running on the local system socket.'
  compose_version=$(docker compose version --short); compose_version=${compose_version#v}
  [[ $(printf '%s\n' 2.24.4 "$compose_version" | sort -V | head -1) == 2.24.4 ]] || fail 'Docker Compose >= 2.24.4 is required.'
}
validate_dir() {
  [[ $dir =~ ^/[a-zA-Z0-9_./-]+$ && $dir != / && $dir != *'..'* && ! -L $dir ]] || fail 'LLLL_DIR must be a dedicated absolute directory, without spaces or symlinks.'
  [[ $(realpath -m "$dir") == "$dir" ]] || fail 'LLLL_DIR must be canonical (no symlink parents or trailing slash).'
}
lock_installation() {
  local key lock_dir
  key=$(printf '%s' "$dir" | sha256sum | cut -c1-16)
  lock_dir=${LLLL_LOCK_DIR:-/run/lock}
  mkdir -p "$lock_dir" || fail 'Cannot create the installer lock directory. Create /run/lock (mode 1777) and retry.'
  chmod 1777 "$lock_dir" 2>/dev/null || true
  exec 9>"$lock_dir/llll-$key.lock" || fail 'Cannot open the installer lock. Create /run/lock (mode 1777) and retry.'
  flock -n 9 || fail 'Another installer/CLI operation is running for this directory.'
}
load_installation() {
  [[ -f $dir/.env && -f $dir/.llll-managed ]] || fail "No managed installation in $dir"
  project=$(get_env LLLL_PROJECT)
  [[ $project =~ ^llll-vps-[a-f0-9]{12}$ ]] || fail 'Invalid managed Compose project'
  [[ $(cat "$dir/.llll-managed") == "$project" ]] || fail 'Installation ownership marker mismatch'
  version=$(get_env LLLL_VERSION)
}
check_owned_volumes() {
  local key name owner
  for key in rustfs-data celld-data caddy-data caddy-config; do
    name="${project}_$key"
    if docker volume inspect "$name" >/dev/null 2>&1; then
      owner=$(docker volume inspect "$name" --format '{{index .Labels "com.docker.compose.project"}}')
      [[ $owner == "$project" ]] || fail "Refusing foreign volume $name"
    fi
  done
}
configure_new() {
  local domain=${LLLL_DOMAIN:-} admin=${LLLL_ADMIN_EMAIL:-} no_tls=${LLLL_NO_TLS:-false} scheme=https origin address
  [[ $admin =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || fail 'Set LLLL_ADMIN_EMAIL for the first owner.'
  [[ $domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $domain == *.* && $domain != *..* ]] || fail 'Set LLLL_DOMAIN to a DNS name pointing to this VPS (no scheme or path).'
  [[ $no_tls == true || $no_tls == false ]] || fail 'LLLL_NO_TLS must be true or false'
  local http_port=${LLLL_HTTP_PORT:-80} https_port=${LLLL_HTTPS_PORT:-443} port
  [[ ${LLLL_ACME_EMAIL:-$admin} =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || fail 'Invalid LLLL_ACME_EMAIL'
  [[ ${LLLL_BACKUP_KEEP:-7} =~ ^[1-9][0-9]*$ ]] || fail 'LLLL_BACKUP_KEEP must be >= 1'
  for port in "$http_port" "$https_port"; do [[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || fail 'Invalid gateway port'; done
  [[ $http_port != "$https_port" ]] || fail 'HTTP and HTTPS ports must differ'
  if [[ $no_tls == true ]]; then scheme=http; address=http://:80; port=$http_port; else address=$domain; port=$https_port; fi
  origin="$scheme://$domain"
  if [[ $scheme == http && $port != 80 || $scheme == https && $port != 443 ]]; then origin="$origin:$port"; fi
  project="llll-vps-$(printf '%s' "$dir" | sha256sum | cut -c1-12)"
  # Stage env before creating any installation files. It is not executed as shell.
  : > "$stage/.env"
  local key
  for key in AUTH_SECRET SETUP_TOKEN RUSTFS_SECRET_KEY; do put_env "$key" "$(openssl rand -hex 32)" "$stage/.env"; done
  put_env RUSTFS_ACCESS_KEY "llll-$(openssl rand -hex 12)" "$stage/.env"
  put_env LLLL_PROJECT "$project" "$stage/.env"
  put_env LLLL_VERSION "$pinned_version" "$stage/.env"
  put_env LLLL_IMAGE "llll:$pinned_version" "$stage/.env"
  put_env SERVER_ID "$(uuid4)" "$stage/.env"
  put_env PUBLIC_ORIGIN "$origin" "$stage/.env"
  put_env LLLL_ORIGINS "$origin" "$stage/.env"
  put_env LLLL_SITE_ADDRESS "$address" "$stage/.env"
  local bind=0.0.0.0
  if [[ $no_tls == true && $domain == 127.0.0.1 ]]; then bind=127.0.0.1; fi
  put_env LLLL_BIND "$bind" "$stage/.env"
  put_env LLLL_HTTP_PORT "$http_port" "$stage/.env"
  put_env LLLL_HTTPS_PORT "$https_port" "$stage/.env"
  put_env LLLL_ACME_EMAIL "${LLLL_ACME_EMAIL:-$admin}" "$stage/.env"
  put_env ADMIN_EMAIL "$admin" "$stage/.env"
  if [[ -n ${LLLL_ADMIN_PASSWORD:-} ]]; then
    (( ${#LLLL_ADMIN_PASSWORD} >= 12 )) || fail 'LLLL_ADMIN_PASSWORD must be at least 12 characters'
    put_env ADMIN_PASSWORD "$LLLL_ADMIN_PASSWORD" "$stage/.env"
  fi
  put_env RUSTFS_BUCKET cells "$stage/.env"
  put_env AWS_REGION us-east-1 "$stage/.env"
  put_env LLLL_CHANNEL "$channel" "$stage/.env"
  put_env LLLL_BACKUP_KEEP "${LLLL_BACKUP_KEEP:-7}" "$stage/.env"
}
apply_files() {
  local file
  for file in llll-compose.yml compose.vps.yml Caddyfile Caddyfile.vps llll-release.json; do install -m 600 "$stage/$file" "$dir/$file"; done
  # Replace only version/image, retaining all secrets and operator additions byte for byte.
  if [[ -f $dir/.env ]]; then
    sed '/^LLLL_VERSION=/d; /^LLLL_IMAGE=/d' "$dir/.env" > "$stage/next.env"
    put_env LLLL_VERSION "$pinned_version" "$stage/next.env"
    put_env LLLL_IMAGE "llll:$pinned_version" "$stage/next.env"
    install -m 600 "$stage/next.env" "$dir/.env"
  else install -m 600 "$stage/.env" "$dir/.env"; fi
  printf '%s\n' "$project" > "$dir/.llll-managed"
  install -m 700 "$stage/llll" "$dir/llll"
}
check_origin() {
  local origin=$1 version=$2
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$origin/.well-known/llll" -o "$stage/health.json" 2>/dev/null && jq -e --arg version "$version" --arg origin "$origin" '.product == "llll" and .kind == "server" and .version == $version and (.id | test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")) and ((.origin == $origin) or (((.aliases // []) | index($origin)) != null))' "$stage/health.json" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
health() {
  local origin
  origin=$(get_env PUBLIC_ORIGIN)
  check_origin "$origin" "${1:-$pinned_version}" || fail "Gateway discovery failed at $origin. Check DNS/firewall/certificates; inspect with: LLLL_DIR=$dir $dir/llll logs"
}
domain_origins() {
  local primary item
  primary=$(get_env PUBLIC_ORIGIN)
  [[ -n $primary ]] || fail 'PUBLIC_ORIGIN is missing from .env'
  local -a values=() result=("$primary")
  if [[ -n $(get_env LLLL_ORIGINS) ]]; then
    IFS=',' read -r -a values <<< "$(get_env LLLL_ORIGINS)"
  fi
  for item in "${values[@]}"; do
    item=${item//[[:space:]]/}
    [[ -z $item || $item == "$primary" ]] && continue
    printf '%s\n' "${result[@]}" | grep -Fxq -- "$item" && continue
    result+=("$item")
  done
  printf '%s\n' "${result[@]}"
}
domain_validate_host() {
  local host=$1
  [[ $host =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $host == *.* && $host != *..* ]] || fail 'Enter a hostname such as chat.example.com (no scheme or path).'
  [[ ${host,,} != *localhost* ]] || fail 'localhost is not a public Server address.'
}
domain_origin() {
  local host=$1 primary scheme authority port='' origin
  primary=$(get_env PUBLIC_ORIGIN)
  scheme=${primary%%://*}
  authority=${primary#*://}
  if [[ $authority == *:* ]]; then port=${authority##*:}; fi
  [[ $scheme == http || $scheme == https ]] || fail 'PUBLIC_ORIGIN must be an http or https origin.'
  origin="$scheme://$host"
  if [[ -n $port && ( ( $scheme == http && $port != 80 ) || ( $scheme == https && $port != 443 ) ) ]]; then origin="$origin:$port"; fi
  printf '%s' "$origin"
}
domain_health() {
  local origin
  for origin in "$@"; do
    if ! check_origin "$origin" "$version"; then
      say "Address $origin did not pass health checks." >&2
      return 1
    fi
  done
}
domain_apply() {
  local -a origins=("$@") hosts=() seen=()
  local primary origin host scheme value
  primary=$(get_env PUBLIC_ORIGIN)
  scheme=${primary%%://*}
  [[ " ${origins[*]} " == *" $primary "* ]] || origins=("$primary" "${origins[@]}")
  for origin in "${origins[@]}"; do
    [[ $origin == "$scheme://"* ]] || { say "Every address must use $scheme." >&2; return 1; }
    [[ " ${seen[*]} " == *" $origin "* ]] && continue
    seen+=("$origin")
    host=${origin#*://}; host=${host%%:*}
    hosts+=("$host")
  done
  value=$(IFS=,; printf '%s' "${seen[*]}")
  replace_env LLLL_ORIGINS "$value" "$dir/.env" || return 1
  if [[ $scheme == http ]]; then
    replace_env LLLL_SITE_ADDRESS 'http://:80' "$dir/.env" || return 1
  else
    value=$(IFS=,; printf '%s' "${hosts[*]}")
    replace_env LLLL_SITE_ADDRESS "$value" "$dir/.env" || return 1
  fi
  compose_up || return 1
  domain_health "${seen[@]}"
}
domain_change() {
  local next_primary=$1 previous
  shift
  previous=$(mktemp "$stage/env.XXXXXXXX")
  cp -p "$dir/.env" "$previous"
  if [[ -n $next_primary ]]; then replace_env PUBLIC_ORIGIN "$next_primary" "$dir/.env"; fi
  if ! domain_apply "$@"; then
    install -m 600 "$previous" "$dir/.env"
    compose_up || true
    rm -f -- "$previous"
    fail 'The address change did not pass its checks; the previous configuration was restored.'
  fi
  rm -f -- "$previous"
}
domain_add() {
  local host=${1:-} origin item
  [[ -n $host ]] || fail 'Usage: llll domain add <hostname>'
  domain_validate_host "$host"
  host=${host,,}
  origin=$(domain_origin "$host")
  local -a origins=()
  mapfile -t origins < <(domain_origins)
  for item in "${origins[@]}"; do
    [[ $item == "$origin" ]] && { say "Already connected: $origin"; return; }
  done
  origins+=("$origin")
  say "Point DNS for $host at this VPS; checking every address after the change."
  domain_change '' "${origins[@]}"
  say "Added $origin. Keep DNS pointed here so certificates keep renewing."
}
domain_remove() {
  local host=${1:-} origin primary item
  [[ -n $host ]] || fail 'Usage: llll domain remove <hostname>'
  domain_validate_host "$host"
  host=${host,,}
  origin=$(domain_origin "$host")
  primary=$(get_env PUBLIC_ORIGIN)
  [[ $origin != "$primary" ]] || fail 'Choose another primary before removing this address.'
  local -a origins=() next=()
  mapfile -t origins < <(domain_origins)
  for item in "${origins[@]}"; do
    [[ $item == "$origin" ]] || next+=("$item")
  done
  [[ ${#next[@]} -lt ${#origins[@]} ]] || fail "Not connected: $origin"
  domain_change '' "${next[@]}"
  say "Removed $origin"
}
domain_primary() {
  local host=${1:-} origin primary item found=false
  [[ -n $host ]] || fail 'Usage: llll domain primary <hostname>'
  domain_validate_host "$host"
  host=${host,,}
  origin=$(domain_origin "$host")
  primary=$(get_env PUBLIC_ORIGIN)
  [[ $origin == "$primary" ]] && { say "$origin is already primary."; return; }
  local -a origins=() next=("$origin")
  mapfile -t origins < <(domain_origins)
  for item in "${origins[@]}"; do
    if [[ $item == "$origin" ]]; then found=true; else next+=("$item"); fi
  done
  [[ $found == true ]] || fail "Connect the address first: llll domain add $host"
  domain_change "$origin" "${next[@]}"
  say "Primary address: $origin"
}
domain_list() {
  local origin primary
  primary=$(get_env PUBLIC_ORIGIN)
  while IFS= read -r origin; do
    if [[ $origin == "$primary" ]]; then printf 'primary  %s\n' "$origin"; else printf 'alias    %s\n' "$origin"; fi
  done < <(domain_origins)
}
domain_command() {
  local action=${1:-list}
  case "$action" in
    list) domain_list ;;
    add) [[ $# == 2 ]] || fail 'Usage: llll domain add <hostname>'; domain_add "$2" ;;
    remove) [[ $# == 2 ]] || fail 'Usage: llll domain remove <hostname>'; domain_remove "$2" ;;
    primary) [[ $# == 2 ]] || fail 'Usage: llll domain primary <hostname>'; domain_primary "$2" ;;
    *) fail 'Usage: llll domain list|add <hostname>|remove <hostname>|primary <hostname>' ;;
  esac
}
print_result() {
  say "Server $pinned_version: $(get_env PUBLIC_ORIGIN)"
  if jq -e '.ready == false' "$stage/health.json" >/dev/null; then
    # No installer log or setup.url file. Explicit operator terminal output only.
    printf 'Claim owner: %s/setup#claim=%s\n' "$(get_env PUBLIC_ORIGIN)" "$(get_env SETUP_TOKEN)"
  elif [[ -n $(get_env ADMIN_PASSWORD) ]]; then
    say "Sign in as $(get_env ADMIN_EMAIL) with LLLL_ADMIN_PASSWORD."
  fi
  say 'Keep an encrypted off-host copy of .env and backups. Operations: llll status | logs | backup | upgrade | restore | domain | uninstall'
}
backup_stack() {
  check_owned_volumes
  local key file work archive
  local keep
  keep=$(get_env LLLL_BACKUP_KEEP); keep=${keep:-7}
  [[ $keep =~ ^[0-9]+$ && $keep -ge 1 ]] || fail 'LLLL_BACKUP_KEEP must be >= 1'
  docker image inspect alpine:3.24 >/dev/null 2>&1 || docker pull alpine:3.24 >/dev/null
  mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
  work=$(mktemp -d "$backup_dir/.partial-XXXXXXXX")
  archive="$backup_dir/llll-backup-$project-$(date -u +%Y%m%dT%H%M%S)-$(openssl rand -hex 4).tar.gz"
  restart_needed=true
  compose stop >/dev/null
  for file in .env .llll-managed llll-compose.yml compose.vps.yml Caddyfile Caddyfile.vps llll-release.json llll; do cp -p "$dir/$file" "$work/$file"; done
  for key in rustfs-data celld-data caddy-data caddy-config; do
    docker run --rm --network none --read-only --mount "type=volume,src=${project}_$key,dst=/source,readonly" alpine:3.24 tar -C /source -cf - . > "$work/$key.tar"
  done
  (cd "$work"; sha256sum .env .llll-managed llll-compose.yml compose.vps.yml Caddyfile Caddyfile.vps llll-release.json llll ./*.tar > SHA256SUMS; tar -czf "$archive.partial" .)
  chmod 600 "$archive.partial"
  mv "$archive.partial" "$archive"
  rm -rf -- "$work"
  compose_up
  restart_needed=false
  backup_result=$archive
  say "Backup: $archive"
  # Rotation is explicit, restricted to this installation's separate backup directory.
  mapfile -t old_backups < <(find "$backup_dir" -maxdepth 1 -type f -name "llll-backup-$project-*.tar.gz" | sort -r | tail -n "+$((keep + 1))")
  if [[ ${#old_backups[@]} -gt 0 ]]; then rm -- "${old_backups[@]}"; fi
}
unpack_backup() {
  local archive=$1 entry
  [[ -f $archive ]] || fail 'Backup file not found'
  mkdir "$stage/restore"
  # Outer backup contains only these regular files, no directories/links/paths.
  while IFS= read -r entry; do
    case "$entry" in ./|./.env|./.llll-managed|./llll-compose.yml|./compose.vps.yml|./Caddyfile|./Caddyfile.vps|./llll-release.json|./llll|./SHA256SUMS|./rustfs-data.tar|./celld-data.tar|./caddy-data.tar|./caddy-config.tar) ;; *) fail "Unsafe backup member: $entry" ;; esac
  done < <(tar -tzf "$archive")
  [[ -z $(tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d"') ]] || fail 'Backup contains links or special files'
  tar -xzf "$archive" --no-same-owner -C "$stage/restore"
  (cd "$stage/restore"; sha256sum --check --status SHA256SUMS) || fail 'Backup checksum verification failed'
  for entry in .env .llll-managed llll-compose.yml compose.vps.yml Caddyfile Caddyfile.vps llll-release.json llll rustfs-data.tar celld-data.tar caddy-data.tar caddy-config.tar; do [[ -f $stage/restore/$entry ]] || fail "Incomplete backup: $entry"; done
}
restore_volumes() {
  local key
  check_owned_volumes
  for key in rustfs-data celld-data caddy-data caddy-config; do
    if ! docker volume inspect "${project}_$key" >/dev/null 2>&1; then docker volume create --label "com.docker.compose.project=$project" --label "com.docker.compose.volume=$key" "${project}_$key" >/dev/null; fi
    docker run --rm --network none --read-only --mount "type=volume,src=${project}_$key,dst=/data" alpine:3.24 sh -c 'test -z "$(ls -A /data)"' || fail "Restore requires empty volume ${project}_$key"
  done
  for key in rustfs-data celld-data caddy-data caddy-config; do
    docker run --rm -i --network none --read-only --mount "type=volume,src=${project}_$key,dst=/data" alpine:3.24 tar -C /data -xf - < "$stage/restore/$key.tar"
  done
}
restore_files() {
  local file
  for file in .env .llll-managed llll-compose.yml compose.vps.yml Caddyfile Caddyfile.vps llll-release.json llll; do install -m 600 "$stage/restore/$file" "$dir/$file"; done
  chmod 700 "$dir/llll"
}
rollback() {
  say 'Upgrade failed; restoring the previous image, configuration and all data.' >&2
  unpack_backup "$backup_result"
  # Use the backed-up Compose even when the failed release has invalid config.
  restore_files
  compose down --remove-orphans >/dev/null
  check_owned_volumes
  local key
  for key in rustfs-data celld-data caddy-data caddy-config; do docker volume rm "${project}_$key" >/dev/null; done
  load_installation
  restore_volumes
  compose_up
  health "$version"
  say "Recovered $version. Backup retained at $backup_result" >&2
}
install_server() {
  preflight
  validate_dir
  lock_installation
  if [[ -e $dir/.llll-managed ]]; then
    load_installation
    [[ $version == "$pinned_version" ]] || fail 'An existing Server has another version; use llll upgrade <version>.'
    ensure_docker
    check_owned_volumes
    compose_up
    health
    install -m 700 "$dir/llll" /usr/local/bin/llll
    print_result
    factory_rerun_notice
    return
  fi
  [[ ! -e $dir || ( -d $dir && -z $(ls -A "$dir") ) ]] || fail 'LLLL_DIR exists and is not an empty directory or a managed installation.'
  [[ $pinned_version != *-* || $channel == prerelease ]] || fail 'This is a prerelease. Review it and explicitly set LLLL_CHANNEL=prerelease.'
  say "Verifying release $pinned_version before installation."
  verified_payload
  ensure_prerequisites
  validate_payload_metadata
  configure_new
  local port
  for port in "$(sed -n "s/^LLLL_HTTP_PORT='\(.*\)'/\1/p" "$stage/.env")" "$(sed -n "s/^LLLL_HTTPS_PORT='\(.*\)'/\1/p" "$stage/.env")"; do
    [[ -z $(ss -H -ltnu "sport = :$port") ]] || fail "Port $port is occupied; free it before installing."
  done
  ensure_docker
  local key
  for key in rustfs-data celld-data caddy-data caddy-config; do
    if docker volume inspect "${project}_$key" >/dev/null 2>&1; then fail 'Live volumes already exist without this installation configuration; restore the original .env or a backup.'; fi
  done
  docker load -i "$stage/llll-runtime-linux-amd64.tar.gz" >/dev/null
  [[ $(docker image inspect "llll:$pinned_version" --format '{{.Os}}/{{.Architecture}}') == linux/amd64 ]] || fail 'Runtime image architecture mismatch'
  install -m 700 -d "$dir"
  apply_files
  install -m 700 "$dir/llll" /usr/local/bin/llll
  say 'Starting standalone Server and checking its public origin.'
  compose_up
  health
  print_result
  enable_optional_factory
}
upgrade_server() {
  local requested=${1:-} current=$version
  [[ -z $requested || $requested =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'Invalid version'
  if [[ -z $requested ]]; then
    [[ $channel == stable ]] || fail 'Prerelease upgrades require an explicit version: llll upgrade <version>.'
    if ! fetch https://api.github.com/repos/inchidev/llll/releases/latest "$stage/latest.json"; then fail 'No stable release available; select a published version with its explicit channel.'; fi
    requested=$(jq -er 'select(.draft == false and .prerelease == false) | .tag_name' "$stage/latest.json") || fail 'No stable release exists; select a prerelease explicitly.'
    requested=${requested#v}
  fi
  [[ $requested != *-* || $channel == prerelease ]] || fail 'Set LLLL_CHANNEL=prerelease to select a prerelease.'
  [[ $requested != "$current" ]] || { say "Already on $current"; return; }
  version_newer "$requested" "$current" || fail 'Downgrades or invalid versions are refused; restore a complete backup instead.'
  release_metadata "$requested"
  validate_metadata "$requested"
  local hash
  hash=$(manifest_hash install.sh)
  fetch "$base/install.sh" "$stage/next-install.sh"
  check_hash "$hash" "$stage/next-install.sh"
  # Hand over to the verified new release implementation, retaining the lock FD.
  LLLL_DIR="$dir" LLLL_CHANNEL="$channel" bash "$stage/next-install.sh" apply-upgrade
}
apply_upgrade() {
  [[ -e /proc/$$/fd/9 ]] || lock_installation
  [[ -f $dir/.env ]] || fail 'No existing installation'
  load_installation
  [[ $version != "$pinned_version" ]] || fail 'Already installed'
  # The installed CLI checks SemVer and downloads this pinned script. Recheck here.
  version_newer "$pinned_version" "$version" || fail 'Downgrades are refused'
  verified_payload
  validate_payload_metadata
  ensure_docker
  docker load -i "$stage/llll-runtime-linux-amd64.tar.gz" >/dev/null
  [[ $(docker image inspect "llll:$pinned_version" --format '{{.Os}}/{{.Architecture}}') == linux/amd64 ]] || fail 'Runtime image architecture mismatch'
  # Fetch the helper before stopping the Server; backup/rollback work offline.
  docker image inspect alpine:3.24 >/dev/null 2>&1 || docker pull alpine:3.24 >/dev/null
  backup_stack
  local result
  set +e
  (trap - EXIT; set -e; apply_files; compose_up; health)
  result=$?
  set -e
  if [[ $result != 0 ]]; then rollback; fail 'Upgrade did not succeed; previous Server restored.'; fi
  install -m 700 "$dir/llll" /usr/local/bin/llll
  say "Upgraded $version -> $pinned_version; backup: $backup_result"
}
restore_server() {
  preflight
  validate_dir
  lock_installation
  [[ ! -e $dir ]] || fail 'Restore into a new LLLL_DIR on a fresh host; the target directory must not exist.'
  unpack_backup "$1"
  ensure_prerequisites
  # Download/verify/load the backup's pinned version before any data is restored.
  local restore_version hash
  restore_version=$(jq -er .version "$stage/restore/llll-release.json")
  release_metadata "$restore_version"
  validate_metadata "$restore_version"
  hash=$(manifest_hash llll-runtime-linux-amd64.tar.gz)
  fetch "$base/llll-runtime-linux-amd64.tar.gz" "$stage/llll-runtime-linux-amd64.tar.gz"
  check_hash "$hash" "$stage/llll-runtime-linux-amd64.tar.gz"
  ensure_docker
  docker load -i "$stage/llll-runtime-linux-amd64.tar.gz" >/dev/null
  [[ $(docker image inspect "llll:$restore_version" --format '{{.Os}}/{{.Architecture}}') == linux/amd64 ]] || fail 'Runtime image architecture mismatch'
  install -m 700 -d "$dir"
  restore_files
  load_installation
  restore_volumes
  compose_up
  health "$version"
  install -m 700 "$dir/llll" /usr/local/bin/llll
  say "Restored Server $version: $(get_env PUBLIC_ORIGIN). Preserve its DNS/origin and encryption secrets."
}
uninstall_server() {
  local purge=false backup=true confirmed=false option key
  for option in "$@"; do case "$option" in --purge) purge=true ;; --no-backup) backup=false ;; --yes) confirmed=true ;; *) fail "Unknown option: $option" ;; esac; done
  if [[ $confirmed != true ]]; then
    printf 'Stop %s%s? Type its project name to confirm: ' "$project" "$([[ $purge == true ]] && printf ' and permanently delete its live volumes')" > /dev/tty
    read -r option < /dev/tty
    [[ $option == "$project" ]] || fail 'Cancelled'
  fi
  check_owned_volumes
  if [[ $backup == true ]]; then backup_stack; fi
  if [[ -f /etc/systemd/system/$(factory_service).service ]] && systemd_available; then systemctl disable --now "$(factory_service)"; fi
  compose down --remove-orphans >/dev/null
  if [[ $purge == true ]]; then
    for key in rustfs-data celld-data caddy-data caddy-config; do docker volume rm "${project}_$key" >/dev/null; done
  fi
  # Keep .env and the CLI for recovery. Never remove Docker, shared images or backups.
  say "Stopped $project. Live volumes purged: $purge. Configuration: $dir. Backups: $backup_dir"
}
factory_service() { printf 'llll-factory-%s' "$project"; }
systemd_available() { [[ -d ${LLLL_SYSTEMD_DIR:-/run/systemd/system} ]]; }
require_factory_systemd() {
  systemd_available || fail 'Factory status, logs, restart, disable and backup need systemd as PID 1 (/run/systemd/system). On a host without systemd, start the released node by hand. See the Software Factory docs. Source disks stay on disk.'
}
workspace_image_accepted() {
  local loaded=$1 pin
  [[ $loaded =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  while IFS= read -r pin; do
    [[ -n $pin && $loaded == "$pin" ]] && return 0
  done < <(jq -r '[.image, .configDigest, .indexDigest] | .[] | select(. != null and . != "")' "$stage/llll-factory.json")
  return 1
}
factory_rerun_notice() {
  if [[ ${LLLL_FACTORY:-false} == true && ! -f $dir/factory/factory.env ]]; then
    say 'LLLL_FACTORY=true was set, but this installation has no Factory executor yet. Enable it with: sudo llll factory enable --trust-shared-kernel'
  fi
}
enable_optional_factory() {
  [[ ${LLLL_FACTORY:-false} == true ]] || return 0
  version=$pinned_version
  # A failed optional step must not exit the Server install or run the EXIT trap that deletes the download stage.
  if ! (trap - EXIT; factory_command enable); then
    say 'Server installed. Optional Factory did not start. Retry with: sudo llll factory enable --trust-shared-kernel'
    say 'A host without systemd can use: sudo llll factory enable --trust-shared-kernel --no-systemd'
  fi
}
factory_command() {
  local action=${1:-status} unit image architecture hash asset expected
  unit=$(factory_service)
  case "$action" in
    enable)
      local trust=false no_systemd=false option tool tag loaded
      for option in "${@:2}"; do
        case "$option" in
          --trust-shared-kernel) trust=true ;;
          --no-systemd) no_systemd=true ;;
          *) fail "Unknown option: $option" ;;
        esac
      done
      [[ $trust == true || ${LLLL_SHARED_KERNEL_TRUSTED:-} == 1 ]] || fail 'Docker shares the host kernel. Run llll factory enable --trust-shared-kernel only for trusted code/users.'
      [[ ${LLLL_FACTORY_NO_SYSTEMD:-} == 1 ]] && no_systemd=true
      for tool in fallocate mkfs.ext4 mount umount findmnt losetup tar; do need "$tool"; done
      if [[ $no_systemd != true ]]; then need systemctl; fi
      [[ $(uname -m) == x86_64 ]] || fail 'The released Compute Node supports Linux amd64.'
      [[ $(df --output=avail -B1 "$dir" | tail -1 | tr -d ' ') -ge 18253611008 ]] || fail 'Compute Node needs 17 GiB free disk capacity for a 10 GiB Task workspace, its image and reserve for the Server.'
      [[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -ge 2097152 ]] || fail 'Factory needs 2 GiB available RAM, including reserve for the Server.'
      release_metadata "$version"
      validate_metadata "$version"
      say 'Downloading the verified Factory image and Compute Node.'
      for asset in llll-factory.json llll-compute-node-linux-amd64.tgz llll-workspace-linux-amd64.tar.gz; do
        hash=$(manifest_hash "$asset")
        fetch "$base/$asset" "$stage/$asset"
        check_hash "$hash" "$stage/$asset"
      done
      jq -e --arg version "$version" '.schemaVersion==1 and .version==$version and (.image | test("^sha256:[a-f0-9]{64}$"))' "$stage/llll-factory.json" >/dev/null || fail 'Invalid Factory release identity'
      for asset in llll-compute-node-linux-amd64.tgz llll-workspace-linux-amd64.tar.gz; do
        expected=$(jq -er --arg name "$asset" '.files[$name].sha256' "$stage/llll-factory.json")
        check_hash "$expected" "$stage/$asset"
      done
      # Extraction is restricted to regular files below fixed node/src paths.
      tar -tzf "$stage/llll-compute-node-linux-amd64.tgz" | while IFS= read -r asset; do
        case "$asset" in node|LICENSE.node|src/|src/*.mjs) [[ $asset != *..* ]] || exit 1 ;; *) exit 1 ;; esac
      done || fail 'Unsafe Compute Node archive'
      tar -tvzf "$stage/llll-compute-node-linux-amd64.tgz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' || fail 'Unsafe Compute Node archive links'
      if [[ -f $dir/factory/factory.env ]]; then
        expected=$(sed -n 's/^LLLL_WORKSPACE_IMAGE=//p' "$dir/factory/factory.env")
        workspace_image_accepted "$expected" || fail 'The released image changed. Existing executor and source remain pinned. Export source, disable/revoke this Node in Server settings, and pair a replacement for new Tasks before changing images.'
      fi
      if [[ $no_systemd != true ]] && ! systemd_available; then
        fail 'Factory needs systemd as PID 1 (/run/systemd/system) before it writes executor files. The Server install can continue without Factory. For a manual executor: llll factory enable --trust-shared-kernel --no-systemd'
      fi
      if [[ $no_systemd != true ]]; then systemctl stop "$unit" 2>/dev/null || true; fi
      install -m 700 -d "$dir/factory" "$dir/factory/releases/$version" "$dir/factory/state"
      tar -xzf "$stage/llll-compute-node-linux-amd64.tgz" --no-same-owner -C "$dir/factory/releases/$version"
      chmod 700 "$dir/factory/releases/$version/node"
      say 'Loading the workspace image. This can take several minutes.'
      docker load -i "$stage/llll-workspace-linux-amd64.tar.gz" >/dev/null
      tag="llll-workspace:$version"
      loaded=$(docker image inspect "$tag" --format '{{.Id}}' 2>/dev/null) || fail "Workspace image $tag was not loaded."
      workspace_image_accepted "$loaded" || fail "Loaded workspace image $loaded does not match a published Factory digest. Classic and containerd stores report different ids; the release lists image, configDigest and indexDigest."
      image=$loaded
      architecture=$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')
      [[ $architecture == linux/amd64 ]] || fail 'Workspace image architecture mismatch'
      # Probe the actual hard-quota filesystem before installing or pairing the service.
      "$dir/factory/releases/$version/node" --input-type=module - "$dir/factory/releases/$version/src/disk-store.mjs" "$dir/factory/state/probe-disks" <<'PROBE'
import { pathToFileURL } from 'node:url';
const { LoopDiskStore } = await import(pathToFileURL(process.argv[2]));
const store = new LoopDiskStore(process.argv[3], { bytes: 33554432, maxDisks: 1 });
await store.initialize(); const id = crypto.randomUUID();
try { await store.ensure(id, true) } finally { await store.remove(id) }
PROBE
      cat > "$stage/factory.env" <<CONFIG
LLLL_SERVER_ORIGIN=$(get_env PUBLIC_ORIGIN)
LLLL_NODE_STATE=$dir/factory/state
LLLL_WORKSPACE_IMAGE=$image
LLLL_SHARED_KERNEL_TRUSTED=1
CONFIG
      install -m 600 "$stage/factory.env" "$dir/factory/factory.env"
      if [[ $no_systemd == true ]]; then
        say 'Local Factory files are ready without systemd. Claim the Server Owner, then start the executor with the environment file above:'
        say "$dir/factory/releases/$version/node $dir/factory/releases/$version/src/pair-local.mjs $dir/.env"
        say "$dir/factory/releases/$version/node $dir/factory/releases/$version/src/daemon.mjs"
        say "Keep LLLL_SERVER_ORIGIN, LLLL_NODE_STATE, LLLL_WORKSPACE_IMAGE and LLLL_SHARED_KERNEL_TRUSTED from $dir/factory/factory.env."
      else
      cat > "$stage/$unit.service" <<UNIT
[Unit]
Description=L4 trusted local Compute Node ($project)
After=docker.service network-online.target
Requires=docker.service
StartLimitIntervalSec=0
[Service]
Type=simple
User=root
UMask=0077
EnvironmentFile=$dir/factory/factory.env
ExecStartPre=$dir/factory/releases/$version/node $dir/factory/releases/$version/src/pair-local.mjs $dir/.env
ExecStart=$dir/factory/releases/$version/node $dir/factory/releases/$version/src/daemon.mjs
Restart=on-failure
RestartSec=10
TimeoutStopSec=180
CPUQuota=100%
MemoryMax=256M
[Install]
WantedBy=multi-user.target
UNIT
      install -m 644 "$stage/$unit.service" "/etc/systemd/system/$unit.service"
      systemctl daemon-reload
      systemctl enable --now "$unit"
      say 'Local Factory installed. Claim the Server Owner first if needed; pairing then happens automatically. Open Settings → Repositories to select this executor. Existing remote providers are preserved.'
      fi
      ;;
    status) require_factory_systemd; systemctl --no-pager status "$unit" ;;
    logs) require_factory_systemd; journalctl -u "$unit" -n 100 --no-pager || fail 'Could not read Factory logs. systemd journal is unavailable.' ;;
    restart) require_factory_systemd; systemctl restart "$unit" ;;
    disable) require_factory_systemd; systemctl disable --now "$unit"; say 'Local executor stopped. All source disks and recovery receipts retained.' ;;
    backup)
      require_factory_systemd
      [[ -d $dir/factory/state ]] || fail 'No local Factory state exists.'
      systemctl stop "$unit"
      sync
      mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
      asset="$backup_dir/factory-$project-$(date -u +%Y%m%dT%H%M%S).tar.gz"
      # Loop-mounted directories are excluded; their complete backing disks are retained.
      tar --one-file-system -czf "$asset.partial" -C "$dir" factory
      mv "$asset.partial" "$asset"; chmod 600 "$asset"
      say "Factory source disks and private receipts exported to $asset. Executor remains stopped; use llll factory restart to continue."
      ;;
    remove)
      [[ ${2:-} == --keep-source ]] || fail 'Use llll factory remove --keep-source. Delete source only through explicitly reviewed workspace release actions.'
      if systemd_available; then
        systemctl disable --now "$unit" 2>/dev/null || true
        rm -f -- "/etc/systemd/system/$unit.service"
        systemctl daemon-reload || fail 'Could not reload systemd after removing the Factory service.'
      else
        rm -f -- "/etc/systemd/system/$unit.service"
        say 'systemd is not running. No service was stopped. Stop any manual node process yourself.'
      fi
      say "Service removed. Source, binaries, private receipts and backups retained in $dir/factory and $backup_dir."
      ;;
    *) fail 'Usage: llll factory enable --trust-shared-kernel [--no-systemd]|status|logs|restart|disable|backup|remove --keep-source' ;;
  esac
}

main() {
  set -Eeuo pipefail
  umask 077
  pinned_version='@@VERSION@@' pinned_commit='@@COMMIT@@' runtime_sha='@@RUNTIME_SHA256@@'
  asset_pins='@@ASSET_PINS@@'
  # State outlives main so EXIT can restart a stack if backup was interrupted.
  dir=${LLLL_DIR:-/opt/llll} project='' version='' os='' codename='' base='' stage='' restart_needed=false backup_result=''
  channel=${LLLL_CHANNEL:-stable} backup_dir=${LLLL_BACKUP_DIR:-} command=${1:-}
  local option
  [[ $channel == stable || $channel == prerelease ]] || fail 'LLLL_CHANNEL must be stable or prerelease'
  [[ $pinned_version =~ ^[0-9] ]] || fail 'Source template is not executable; use install.sh from a published release.'
  [[ $EUID == 0 ]] || fail 'Run as root.'
  validate_dir
  if [[ -z $backup_dir ]]; then backup_dir="/var/backups/llll/$(printf '%s' "$dir" | sha256sum | cut -c1-12)"; fi
  [[ $backup_dir =~ ^/[a-zA-Z0-9_./-]+$ && $(realpath -m "$backup_dir") == "$backup_dir" && $backup_dir != "$dir" && $backup_dir != "$dir/"* ]] || fail 'Backups must be a canonical directory outside the installation directory.'
  stage=$(mktemp -d /var/tmp/llll-install.XXXXXXXX)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [[ -z $command ]]; then
    if [[ $(basename "$0") == llll ]]; then command=status; else command=install; fi
  else shift; fi
  case "$command" in
    install) install_server ;;
    apply-upgrade) apply_upgrade ;;
    restore) [[ $# == 1 ]] || fail 'Usage: LLLL_DIR=/opt/llll llll restore <backup>'; restore_server "$1" ;;
    *)
      for option in docker jq curl flock; do need "$option"; done
      load_installation
      case "$command" in status|logs) ;; *) lock_installation ;; esac
      case "$command" in
        status) compose ps; say "Version $version; $(get_env PUBLIC_ORIGIN)" ;;
        logs) compose logs --tail 100 --follow ;;
        start) compose_up; health "$version" ;;
        stop) compose stop ;;
        backup) backup_stack ;;
        upgrade) upgrade_server "${1:-}" ;;
        domain) domain_command "$@" ;;
        compute|factory) factory_command "$@" ;;
        uninstall) uninstall_server "$@" ;;
        *) fail 'Usage: llll status|logs|start|stop|backup|restore <file>|upgrade [version]|domain list|add <hostname>|remove <hostname>|primary <hostname>|uninstall [--purge] [--yes] [--no-backup]' ;;
      esac
      ;;
  esac
}
main "$@"
