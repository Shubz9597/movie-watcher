# TorWatch Server Fedora deployment runbook (AMD64)

Operator procedure for installing the tested release on a Fedora Linux
homeserver (AMD64) without building source on the server. The ARM64/Radxa
equivalent is `radxa-runbook.md`; the steps are the same except where noted.

## 1. Prerequisites

- Fedora (Workstation or Server) on AMD64, a stable LAN address (router DHCP
  reservation recommended), and a trusted home network.
- **This package is for a trusted LAN or private overlay only.** Do not
  forward the gateway port to the public internet; application
  authentication is a later milestone.
- Docker Engine with Compose and Buildx. Fedora's Moby packages are the
  shortest path when `moby-engine` is already installed:

  ```bash
  sudo dnf -y install moby-engine docker-compose docker-buildx
  sudo systemctl enable --now docker
  docker version && docker compose version && docker buildx version
  ```

  For a new Docker CE installation instead:

  ```bash
  sudo dnf -y install dnf-plugins-core
  sudo dnf-3 config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  docker version && docker compose version
  docker run --rm hello-world
  ```

  Compose must be >= 2.24 for the shared database or VPN overlay. The
  preflight script enforces this.

- On a laptop target: disable automatic suspend on AC, and keep the storage
  device awake as your normal power policy dictates.

## 2. Prepare persistent storage

Pick a durable filesystem (SSD/NVMe/eMMC — not removable flash) and create
the data root, e.g. `/srv/torwatch-data`:

```bash
sudo mkdir -p /srv/torwatch-data
for d in postgres prowlarr flaresolverr downloads subtitles logs backups; do
  sudo mkdir -p /srv/torwatch-data/$d
done
```

Ownership model (documented UIDs):

- The application image runs as uid/gid 1000 (`PUID`/`PGID` default 1000).
  Give it the directories it writes:
  ```bash
  sudo chown -R 1000:1000 /srv/torwatch-data/downloads \
        /srv/torwatch-data/subtitles /srv/torwatch-data/logs \
        /srv/torwatch-data/prowlarr /srv/torwatch-data/flaresolverr
  ```
- In bundled database mode, PostgreSQL uses its own internal uid; leave
  `postgres/` owned by root and let the image initialize it on first start.
- In shared database mode, PostgreSQL uses the Docker named volume
  `homelab-postgres-data`; the `postgres/` directory under this data root is
  unused.

## 3. SELinux (Fedora enforcing)

Fedora ships SELinux enforcing. Bind mounts must be labeled for container
access:

1. Edit `.env` and uncomment `SELINUX_MOUNT_OPTS=,z` (Compose appends the
   `z` shared-label option to every bind mount). `preflight.sh` fails with
   this exact instruction when it detects enforcing without the option.
2. Alternatively (or if relabeling is undesirable), label the data tree
   manually instead and leave the option unset:
   ```bash
   sudo semanage fcontext -a -t container_file_t "/srv/torwatch-data(/.*)?"
   sudo restorecon -R /srv/torwatch-data
   ```
   (`policycoreutils-python-utils` provides `semanage`.)
3. Verify enforcing status with `getenforce`. On Windows Docker Desktop /
   WSL2 test machines leave the option unset.

## 4. Firewall

Docker inserts its own iptables rules that bypass firewalld for published
ports, so:

- Expect the gateway port (`GATEWAY_PORT`, default 8080) to be reachable
  from the LAN once published — verify from a second device rather than
  trusting firewall status output.
- Prowlarr's admin port is published on 127.0.0.1 only and is not
  LAN-reachable; use the SSH tunnel below.
- To restrict by source subnet, manage it at your router, or use
  `firewalld` policies for the host's other services. Do not add
  `0.0.0.0:9696` or other internal ports anywhere.

## 5. Install the release bundle

### Source checkout on the server

When the Git checkout is already at `/srv/movie-watcher`, do not extract a
second nested release directory. Update and build from that checkout:

```bash
cd /srv/movie-watcher
git status
git pull --ff-only
./deploy/torwatch-server/scripts/build-images.sh 2.0.0-rc.1
```

The working tree is a normal writable Git checkout. Runtime data belongs
outside Git, such as `/mnt/workspace/app-data/movie-watcher`; containers are
updated by rebuilding or pulling an immutable image and recreating them.

For one PostgreSQL service shared by several homelab applications, initialize
it once before starting Movie Watcher:

```bash
cd /srv/movie-watcher/deploy/homelab-postgres
cp .env.example .env
chmod 600 .env
vi .env
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Then configure Movie Watcher:

```bash
cd /srv/movie-watcher/deploy/torwatch-server
cp .env.example .env
chmod 600 .env
vi .env
```

Set `TORWATCH_DATA_DIR=/mnt/workspace/app-data/movie-watcher`,
`TORWATCH_DB_MODE=shared`, `TORWATCH_MODE=direct`, and
`TZ=Asia/Kolkata`. `POSTGRES_PASSWORD` must exactly match
`MOVIE_WATCHER_POSTGRES_PASSWORD` in the shared database environment. Use an
alphanumeric password because it is embedded in a PostgreSQL connection URL.
On SELinux-enforcing Fedora, set `SELINUX_MOUNT_OPTS=,z`.

Continue with section 6. The operator scripts read `TORWATCH_DB_MODE` and
automatically include the shared database overlay.

### Prebuilt release bundle

Copy the tested release bundle (e.g. `torwatch-server-2.0.0-rc.1-bundle.tar.gz`,
checksum published with the release) to the server and verify the checksum:

```bash
sha256sum torwatch-server-2.0.0-rc.1-bundle.tar.gz
sudo mkdir -p /opt/torwatch-server
sudo tar -xzf torwatch-server-2.0.0-rc.1-bundle.tar.gz -C /opt --strip-components 1
# (or: install git and check out the tag — no build required on the server)
cd /opt/torwatch-server
```

Load the tested application image (no registry required):

```bash
docker load -i torwatch-server-2.0.0-rc.1-image-linux-amd64.tar
docker image inspect torwatch-server:2.0.0-rc.1 --format '{{.Id}}'
```

Configure the operator environment:

```bash
cp .env.example .env
chmod 600 .env
vi .env   # TORWATCH_DATA_DIR, TORWATCH_IMAGE, POSTGRES_PASSWORD, ports,
          # SELINUX_MOUNT_OPTS on enforcing hosts, optional API keys
```

## 6. Preflight, start, verify

```bash
./scripts/preflight.sh --mode direct
docker compose --env-file .env -f compose.yaml -f compose.shared-db.yaml up -d
./scripts/verify.sh
```

Omit `-f compose.shared-db.yaml` when using the bundled database. The
preflight, verify, backup, restore, and update scripts select the correct
files from `TORWATCH_DB_MODE`.

Expected: `PREFLIGHT OK`, all containers healthy, gateway `/healthz`
byte-exact, `/readyz` ok, `/v1/version` reports `2.0.0-rc.1`,
`revision 1f56e0b` (or the released revision) and `arch: amd64`. First boot
includes Prowlarr bootstrap: `docker compose --env-file .env -f compose.yaml
logs vod | grep bootstrap` shows the resolved key source and per-indexer
results. Individual starter-indexer failures are non-fatal (recorded, e.g.
upstream connectivity); complete the set via the admin UI if wanted.

Byte-range and SSE pass-through checks need a stream URL; use the fixture
stack from the package (`tests/`) or a real playback session:

```bash
TORWATCH_VERIFY_STREAM_URL=http://127.0.0.1:8080/fixtures/movie.bin \
TORWATCH_VERIFY_SSE_URL="http://127.0.0.1:8080/buffer/info?magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A0123456789abcdef0123456789abcdef01234567&sse=1" \
  ./scripts/verify.sh
```

From a second LAN device confirm the gateway answers and ports 5432, 9696,
8191, 4001 do NOT.

## 7. Prowlarr administration (SSH tunnel)

```bash
ssh -L 9696:127.0.0.1:9696 <user>@<torwatch-host>
# then browse http://127.0.0.1:9696 on your workstation; close when done
```

## 8. Operations, backup, update, rollback

```bash
./scripts/backup.sh "$TORWATCH_DATA_DIR/backups"       # scheduled via a systemd timer recommended
./scripts/restore.sh <backup-dir-or-timestamp> --yes  # emergency only
./scripts/update.sh <repo:new-tag>                    # pre-backup + verify + auto-rollback
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --tail 200 vod
```

Copy backups to a second physical device; a backup on the same SSD is not
device-failure protection. Prove a restore on a disposable data root
periodically (never point a test restore at the live deployment).

## 9. Reboot recovery

After a controlled reboot:

```bash
findmnt /srv/torwatch-data || sudo mount /srv/torwatch-data   # mount first, always
cd /srv/movie-watcher/deploy/torwatch-server
docker compose --env-file .env -f compose.yaml -f compose.shared-db.yaml up -d
./scripts/verify.sh
```

`restart: unless-stopped` + Docker enabled brings the stack up automatically
on boot; verify progress, picks, Prowlarr config, subtitles, and partial
downloads are intact. If the data filesystem failed to mount, DO NOT let the
stack start against an empty root — correct the mount first (this is why the
absolute `TORWATCH_DATA_DIR` plus per-directory checks exist).

## 10. Troubleshooting

Collect only: release version/digests, Fedora/kernel version,
`docker compose ps`, gateway health/readiness/version responses, sanitized
`/srv/torwatch-data/logs/backend.log` tail, free space (`df -h`), and exact
reproduction steps. Never share `.env`, Prowlarr config XML, provider
tokens, database dumps, or magnet URLs.
