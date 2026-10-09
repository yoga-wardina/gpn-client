// GPN Client — watches a game process, detects its server IPs, pushes them to the GPN VPS.
import { GameWatcher } from "./watcher.ts";
import { GpnApi } from "./api.ts";
import type { Target } from "./watcher.ts";
import { startUi } from "./ui/server.ts";
import { config, loadConfig } from "./config.ts";
import { startTray, cleanStaleExitFlag } from "./tray.ts";
import { TunnelManager } from "./tunnel.ts";

await loadConfig();
cleanStaleExitFlag();

const tunnel = new TunnelManager();

const api = new GpnApi(config.gpnServerUrl, config.gpnToken);
const watcher = new GameWatcher(config.pollIntervalMs);

// UI server (local web dashboard, ExitLag-style)
startUi(config.uiPort, {
  watcher,
  api,
  config,
  tunnel,
});

console.log(`[gpn] UI ready at http://localhost:${config.uiPort}`);
console.log(`[gpn] GPN server: ${config.gpnServerUrl}`);

// Tray icon (Windows) — Quit writes tray.exit which triggers shutdown here.
const tray = startTray(config.uiPort);
tray.onQuitRequested(() => {
  console.log("[gpn] quit requested from tray");
  process.exit(0);
});

// Auto-open dashboard in the default browser (skip in dev with GPN_NO_OPEN=1)
if (!process.env.GPN_NO_OPEN) {
  const open =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", `http://localhost:${config.uiPort}`]] as const
      : process.platform === "darwin"
        ? ["open", [`http://localhost:${config.uiPort}`]] as const
        : ["xdg-open", [`http://localhost:${config.uiPort}`]] as const;
  import("node:child_process").then(({ spawn }) => {
    spawn(open[0], [...open[1]], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  });
}

watcher.on("targetsChanged", async (targets: Target[]) => {
  console.log(`[gpn] active game IPs: ${targets.map((t) => t.ip).join(", ")}`);
  try {
    await api.pushTargets(targets);
  } catch (e) {
    console.error("[gpn] push failed:", e);
  }
  // Update the local WireGuard tunnel with the new target set
  if (config.tunnelEnabled && targets.length > 0) {
    try {
      await tunnel.applyTargets(config.gpnServerUrl, config.gpnToken, targets);
      console.log(`[gpn] tunnel allowed-ips: ${targets.map((t) => t.ip).join(", ")}`);
    } catch (e) {
      console.error("[gpn] tunnel update failed:", e);
    }
  }
});

watcher.on("gameStopped", (proc) => console.log(`[gpn] game stopped: ${proc.name} (pid ${proc.pid})`));

// When no more game targets, optionally tear down the tunnel (direct connection)
watcher.on("targetsChanged", async (targets: Target[]) => {
  if (config.tunnelEnabled && config.tunnelTeardownWhenIdle && targets.length === 0 && tunnel.state.tunnelUp) {
    console.log("[gpn] no game traffic — tearing down tunnel");
    await tunnel.teardown();
  }
});

// Auto-watch from saved config
for (const exe of config.games) {
  watcher.watchExecutable(exe);
}
