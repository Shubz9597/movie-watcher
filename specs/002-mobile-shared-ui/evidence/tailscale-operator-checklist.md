# Private Tailscale staging path — operator checklist

Status on the staging machine (2026-09-11): **Tailscale is NOT installed.** `tailscale` is not on PATH; `C:\Program Files\Tailscale\` and `%LOCALAPPDATA%\Tailscale\` do not exist. The staging Serve code paths are written and syntax-reviewed but were NOT exercised end-to-end (no CLI on the machine). Everything below must be done by the operator; do not tick anything from a simulation.

## Preconditions (operator)

1. Install Tailscale (Windows client) and log in (`tailscale up` / GUI login). Verify: `tailscale status` shows `BackendState: Running` and a MagicDNS name for this node.
2. Enable MagicDNS in the tailnet admin console (the harness derives the HTTPS origin from `Self.DNSName`).
3. The phone (iPhone under test) joins the SAME tailnet. **Funnel must stay off** — nothing in this repo ever invokes it; verify afterwards with `tailscale funnel status` (expect: no funnels).
4. No firewall changes are required or permitted: Tailscale Serve is an outbound-only userspace proxy and the staging stack keeps binding 127.0.0.1 only.

## Steps

1. From `deploy\desktop-staging`: `powershell -ExecutionPolicy Bypass -File staging.ps1 Stop` if a stack is running (data is preserved), then:

   ```powershell
   powershell -ExecutionPolicy Bypass -File staging.ps1 Start -ValidationStub
   ```

   (No `-NoTailscale`.) The harness will verify the installed `tailscale serve` syntax (`--bg`, `--http`), derive `https://<node>.<tailnet>.ts.net`, create two PRIVATE Serve mappings (frontend `--http=443`, backend `--http=8443` → 127.0.0.1:4174/4001), and rebuild the browser bundle with the exact tailnet backend origin baked into CSP. If Serve port 443 is taken, set `TAILNET_FRONTEND_SERVE_PORT`/`TAILNET_BACKEND_SERVE_PORT` in `.env` first.

2. `staging.ps1 Status` — confirm the Serve mappings appear and both local origins are healthy.
3. On the phone (same tailnet, Safari): open `https://<node>.<tailnet>.ts.net/browser.html`.
   - Expected: Home renders; Library toggle writes work (cross-origin PUT preflight against the tailnet backend origin — the CORS allowlist is built from the tailnet frontend origin at Start).
4. Run `staging.ps1 Verify` (18 checks) and `staging.ps1 VerifyAfterRestart` (13 checks) — they run against the recorded origins, so on a passing Start they validate the tailnet path end-to-end, including the two-browser-context cross-client sync.
5. Optional: repeat step 3 with the iPhone on cellular (tailnet still routes over WireGuard) — this is the closest-to-production private path that exists before a Radxa deployment.

## First-use risks (unpredictable without the CLI)

- `tailscale serve --bg --http=<port>` syntax differences on the installed version (harness hard-fails with the help excerpt if `--bg`/`--http` are missing → upgrade Tailscale to 1.50+).
- ACLs: if the tailnet policy blocks node-local Serve, `serve` exits non-zero — check `tailscale serve status`.
- Certificates: first HTTPS request per name triggers a provision delay; retry after a few seconds.

## Evidence rules

- REDACT the actual tailnet hostname/IP in any committed evidence (use `https://<node>.<tailnet>.ts.net` placeholders).
- Record which checks passed and whether the provider was the deterministic stub.
- Never record Serve tokens, funnel status, or MagicDNS full names in tracked files.
