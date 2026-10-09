// GPN Client — watches a game process, detects its server IPs, pushes them to the GPN VPS.
import { GameWatcher } from "./watcher.ts";
import { GpnApi } from "./api.ts";
import type { Target } from "./watcher.ts";
import { startUi } from "./ui/server.ts";
import { config, loadConfig } from "./config.ts";
import { startTray, cleanStaleExitFlag } from "./tray.ts";

await loadConfig();
cleanStaleExitFlag();

const api = new GpnApi(config.gpnServerUrl, config.gpnToken);
const watcher = new GameWatcher(config.pollIntervalMs);

// UI server (local web dashboard, ExitLag-style)
startUi(config.uiPort, {
  watcher,
  api,
  config,
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
});

watcher.on("gameStarted", (proc) => console.log(`[gpn] game started: ${proc.name} (pid ${proc.pid})`));
watcher.on("gameStopped", (proc) => console.log(`[gpn] game stopped: ${proc.name} (pid ${proc.pid})`));

// Auto-watch from saved config
for (const exe of config.games) {
  watcher.watchExecutable(exe);
}
