# GPN Client

Desktop app (Windows-first) that watches a game executable, detects its game-server
IPs/ports from the OS socket tables, and pushes them to your GPN VPS so only game
traffic is routed through the tunnel.

## How it works

```
[Game process] --sockets--> [GPN Client watcher] --POST /api/targets--> [GPN VPS]
                                                                    (nftables/WireGuard routes only those IPs)
```

- **Watcher** polls `tasklist` + `netstat -nao` (Windows) or `ps` + `ss` (Linux) every 2s,
  matching PIDs of watched executables, and extracts remote IPs.
- **UI** is a local dashboard at `http://localhost:7790` (dark, ExitLag-style):
  add/remove watched games, live target feed, server settings.
- **API client** pushes new target sets to your GPN server with a Bearer token.

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

## Config (`gpn.config.json`)

```json
{
  "gpnServerUrl": "https://gpn.example.com",
  "gpnToken": "shared-secret",
  "pollIntervalMs": 2000,
  "uiPort": 7790,
  "games": ["valorant.exe"],
  "gamePorts": []
}
```

## GPN server API expected

- `POST /api/targets` — body `{ "targets": [{ "ip", "port", "proto", "firstSeen", "lastSeen" }], "ts" }`,
  header `Authorization: Bearer <token>`.
- `GET /api/health` — for the "Test connection" button.
