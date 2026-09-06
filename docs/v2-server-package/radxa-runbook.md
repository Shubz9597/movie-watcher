# TorWatch Server Radxa ROCK 3A deployment runbook

This is the required operator experience for the finished Version 2 server
package. Commands assume a 64-bit Debian-family Radxa OS, Docker Engine with the
Compose plugin, and a release bundle containing `deploy/torwatch-server/`.

The current repository does not yet contain that implementation. An agent must
complete and validate the implementation plan before treating this runbook as a
working installer.

## 1. Hardware and network prerequisites

- Radxa ROCK 3A with 4 GB RAM and a stable supported power supply.
- 64-bit ARM operating system.
- Wired Gigabit Ethernet where possible.
- SSD or NVMe storage for PostgreSQL, Prowlarr, subtitles, and torrent cache.
- Adequate cooling for sustained networking and hashing.
- A router DHCP reservation or another stable LAN address for the board.
- Optional `/dev/net/tun` and VPN credentials for embedded-VPN mode.

Do not place the active PostgreSQL and torrent data root on microSD unless the
operator explicitly accepts the performance and wear risk.

## 2. Prepare the operating system

Install the official 64-bit Radxa OS following Radxa documentation, change all
default credentials, install security updates, set the correct timezone, and
assign a recognizable hostname such as `torwatch`.

Verify architecture:

```bash
uname -m
getconf LONG_BIT
```

Expected values are `aarch64` and `64`.

Install Docker Engine and the Docker Compose plugin using the supported Docker
instructions for the installed Debian base. Verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

The package preflight script is authoritative about minimum supported versions.

## 3. Prepare persistent storage

Mount the SSD/NVMe using the operating system's normal persistent mount process.
This runbook intentionally does not provide partitioning or formatting commands,
because those can destroy data when a device name is mistaken.

Example final mount and data root:

```text
/srv/torwatch-data
```

Verify the resolved mount before continuing:

```bash
findmnt /srv/torwatch-data
df -h /srv/torwatch-data
```

Create the package directories using the UID/GID documented by the release:

```bash
sudo install -d -m 0750 /srv/torwatch-data
sudo install -d -m 0750 /srv/torwatch-data/postgres
sudo install -d -m 0750 /srv/torwatch-data/prowlarr
sudo install -d -m 0750 /srv/torwatch-data/flaresolverr
sudo install -d -m 0750 /srv/torwatch-data/gluetun
sudo install -d -m 0750 /srv/torwatch-data/downloads
sudo install -d -m 0750 /srv/torwatch-data/subtitles
sudo install -d -m 0750 /srv/torwatch-data/logs
sudo install -d -m 0750 /srv/torwatch-data/backups
```

The implemented `preflight.sh` must report any ownership changes needed. Do not
recursively change ownership on an unverified or broader path.

## 4. Install the release bundle

Download or copy a specific TorWatch Server release bundle and verify its
published checksum before extracting it. Do not deploy from a floating branch or
unversioned Compose file.

Example destination:

```text
/opt/torwatch-server
```

Copy the example configuration:

```bash
cd /opt/torwatch-server
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at minimum:

- the exact TorWatch image version;
- `TORWATCH_DATA_DIR=/srv/torwatch-data`;
- a strong unique PostgreSQL password;
- timezone and documented PUID/PGID;
- gateway host/port;
- Prowlarr key source or bootstrap settings;
- optional OpenSubtitles credentials;
- VPN provider and credentials when using embedded-VPN mode.

Do not paste `.env` into bug reports or commit it to Git.

## 5. Run preflight

Direct mode:

```bash
./scripts/preflight.sh --mode direct
```

Embedded-VPN mode:

```bash
./scripts/preflight.sh --mode embedded-vpn
```

Resolve every failure. Do not bypass checks for placeholder passwords, wrong
architecture, missing storage mounts, port conflicts, or unavailable TUN device.

Render the effective configuration without starting it:

```bash
docker compose --env-file .env -f compose.yaml config --quiet
```

For VPN mode:

```bash
docker compose --env-file .env -f compose.yaml -f compose.vpn.yaml config --quiet
```

## 6. Start TorWatch Server

Direct mode:

```bash
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
```

Embedded-VPN mode:

```bash
docker compose --env-file .env -f compose.yaml -f compose.vpn.yaml pull
docker compose --env-file .env -f compose.yaml -f compose.vpn.yaml up -d
```

Watch sanitized service status:

```bash
docker compose --env-file .env -f compose.yaml ps
./scripts/verify.sh
```

For VPN mode, pass the same overlay flag required by the implemented script or
set its documented deployment-mode variable.

Expected results:

- all required containers are healthy;
- gateway `/healthz` succeeds;
- gateway `/readyz` succeeds or reports only a documented optional degradation;
- `/v1/version` reports `linux/arm64` and the installed release;
- only the configured gateway port is published.

## 7. Configure Prowlarr

The package must bootstrap the tested starter indexers only when Prowlarr is
empty. Existing configuration must be retained.

For advanced administration, use an SSH tunnel from the operator workstation
instead of a LAN-wide port:

```bash
ssh -L 9696:127.0.0.1:9696 <radxa-user>@<radxa-address>
```

This requires the finished bundle to offer a loopback-only maintenance path or
an equivalent documented command. Then browse locally to
`http://127.0.0.1:9696`.

Close the tunnel after administration. Never add `0.0.0.0:9696:9696` to the
released manifest.

## 8. Verify from another LAN device

From a second machine, open the configured gateway address and check:

```bash
curl --fail http://<torwatch-address>:<gateway-port>/healthz
curl --fail http://<torwatch-address>:<gateway-port>/readyz
curl --fail http://<torwatch-address>:<gateway-port>/v1/version
```

Use the finished package's `verify.sh` or documented controlled fixture to test
byte ranges. Never paste a private magnet into a shared shell history or report.

Confirm that attempts to connect to ports 5432, 9696, 8191, 8888, and 4001 from
the LAN fail. The exact gateway port is the only intended exception.

## 9. Firewall and access boundary

Permit the gateway only from the trusted home subnet or private overlay. Docker
port publishing can interact with host firewall rules, so verify reachability
from a second device rather than relying only on a local firewall status command.

The initial package is not approved for an unauthenticated public IP. When it is
placed on a cloud host, put the gateway behind a private WireGuard/Tailscale-like
overlay or equivalent access-controlled network. Do not expose it publicly until
the later application authentication and opaque stream-session milestone is
implemented and reviewed.

## 10. Normal operations

Status and safe logs:

```bash
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --tail 200 torwatch-api
./scripts/verify.sh
```

Stop without deleting data:

```bash
docker compose --env-file .env -f compose.yaml stop
```

Start again:

```bash
docker compose --env-file .env -f compose.yaml start
```

Use the VPN overlay consistently when the deployment was created in VPN mode.
Do not alternate commands that omit the overlay.

## 11. Backup

Run:

```bash
./scripts/backup.sh
```

The completed backup must contain a manifest, PostgreSQL dump, Prowlarr and
application configuration, version/digest metadata, and checksums. Torrent media
is excluded by default because it is large and reproducible; use the documented
opt-in only if preserving partial/full payloads is required.

Copy backups to another physical device. A backup stored only on the same SSD is
not protection from device failure.

Periodically prove restoration using a disposable data root.

## 12. Update

Read release notes, especially database migration and rollback notes. Then:

```bash
./scripts/update.sh --version <exact-version>
```

The script must create a backup, pull exact images, record digests, start the new
version, wait for readiness, and run verification. It must never silently update
dependency images through floating tags.

## 13. Rollback

If the release declares binary rollback compatible, run the exact rollback
command printed by `update.sh`, selecting the previous semantic version and its
recorded dependency digests.

If a migration is not backward compatible:

1. stop gateway and application writers;
2. restore the pre-update backup with `restore.sh`;
3. select the previous exact bundle and image versions;
4. start and run `verify.sh`;
5. preserve failed-version logs after redaction for diagnosis.

Never downgrade only the application binary against an incompatible newer
database schema.

## 14. Recovery checks after reboot or power loss

After a controlled reboot:

```bash
findmnt /srv/torwatch-data
docker compose --env-file /opt/torwatch-server/.env \
  -f /opt/torwatch-server/compose.yaml ps
/opt/torwatch-server/scripts/verify.sh
```

Verify progress, picks, Prowlarr configuration, subtitles, and partial downloads
remain present. If the data filesystem is not mounted, do not start the stack
against an empty directory on the root filesystem; correct the mount first.

## 15. Troubleshooting information to retain

When reporting a package problem, collect only:

- release version and image digests;
- Radxa OS/kernel, Docker/Compose versions, and architecture;
- deployment mode;
- `docker compose ps` output;
- gateway health/readiness/version responses;
- sanitized `backend.log` and relevant `errors.log` entries;
- filesystem free-space and mount information;
- exact reproduction steps.

Review every file before sharing it. Do not share `.env`, Prowlarr config XML,
VPN configuration, provider tokens, database dumps, or magnet-bearing URLs.

