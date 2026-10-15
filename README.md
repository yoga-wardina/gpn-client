# GPN Client

Desktop app (Windows-first) that watches a game executable, detects its game-server
IPs/ports from the OS socket tables, and pushes them to your GPN VPS so only game
traffic is routed through the tunnel.

## How it works

```
[Game process] --sockets--> [GPN Client watcher] --POST /api/targets--> [GPN VPS]
                                 |
                                 +--> local WireGuard tunnel (AllowedIPs = only the game IPs)
```

- **Watcher** polls `tasklist` + `netstat -nao` (Windows) or `ps` + `ss` (Linux) every 2s,
  matching watched executables by file name and collecting *established TCP* connections to
  public IPv4 hosts. UDP is not detected on Windows yet (netstat shows no UDP remote).
- **Tunnel** (Windows, needs WireGuard for Windows + an elevated app): registers a persistent
  key with the server, writes a split-tunnel config, and updates it (debounced, serialized)
  when the target set changes. Goes idle after 60s without game traffic.
- **UI** is a local dashboard at `http://localhost:7790`, bound to loopback only and protected
  against cross-site requests (Host/Origin checks).
- Requests use your logged-in user session (auto-refreshed); the shared token is only a fallback.

## Run (dev)

```powershell
bun install
bun run dev
# open http://localhost:7790
```

1. Edit `gpn.config.json` (auto-created on first run): set `gpnServerUrl` and `gpnToken`.
2. In the UI, type a game executable name (e.g. `valorant.exe`) and click **Watch**.
3. Launch the game. Detected server IPs appear in **Live Server Targets** and are
   pushed to the GPN server automatically.

## Build a Windows exe

GitHub Actions builds it on every push to `main` (artifact `GPNClient-windows`),
or locally:

```powershell
bun run build:win   # -> dist/GPNClient.exe
```

## Config (`gpn.config.json`, next to the exe; restricted to the current user)

```json
{
  "gpnServerUrl": "https://gpn.example.com",
  "gpnToken": "",
  "pollIntervalMs": 2000,
  "uiPort": 7790,
  "games": ["valorant.exe"],
  "gamePorts": [],
  "tunnelEnabled": true,
  "tunnelTeardownWhenIdle": true,
  "tunnelLiveUpdate": false
}
```

`gamePorts`: if non-empty, only these remote ports count. `tunnelLiveUpdate` (experimental)
applies target changes without restarting the tunnel service. The server URL must be
`https://` (plain `http://` only for localhost). `wgPrivateKey` and `auth` are stored here too.

## GPN server API used

- `POST /api/auth/{register,login,refresh,logout}`, `POST /api/register`,
  `POST /api/targets` (Bearer: user session, or the shared token), `GET /api/health`.
