// GPN Client — watches a game process, detects its server IPs, pushes them to the GPN VPS.
import { spawn } from "node:child_process";
import { GameWatcher } from "./watcher.ts";
import type { Target } from "./watcher.ts";
import { GpnApi } from "./api.ts";
import { startUi } from "./ui/server.ts";
import { config, loadConfig, saveConfig } from "./config.ts";
import { startTray, cleanStaleExitFlag } from "./tray.ts";
import { TunnelManager } from "./tunnel.ts";
import { startSampling } from "./traffic.ts";
import { isPublicIpv4, sameSet } from "./net.ts";

/** How long to wait with no game connections before dropping routes/tunnel (loading screens etc.). */
const IDLE_GRACE_MS = 60_000;
/** Coalesce bursts of new connections into one update. */
const DEBOUNCE_MS = 1_500;

await loadConfig();
cleanStaleExitFlag();

const api = new GpnApi(config.gpnServerUrl, config.gpnToken);
if (config.auth) api.setSession(config.auth);
api.onSessionUpdate = (s) => saveConfig({ auth: s ?? undefined });

const tunnel = new TunnelManager(api);
await tunnel.init(); // adopt a tunnel left running by a previous run

const watcher = new GameWatcher(config.pollIntervalMs, () => config.gamePorts);

// traffic sampler for live in/out rates (single loop; follows the tunnel when it's up)
startSampling(2000, () => tunnel.state.tunnelUp);

// tunnel watchdog: force reconnect if the handshake goes stale (NAT rebinds)
const stopWatchdog = tunnel.startWatchdog();

// UI server (local web dashboard, ExitLag-style)
startUi(config.uiPort, { watcher, api, config, tunnel });

console.log(`[gpn] UI ready at http://localhost:${config.uiPort}`);
console.log(`[gpn] GPN server: ${api.serverUrl}`);

// Tray icon (Windows) — Quit writes tray.exit which triggers shutdown here.
const tray = startTray(config.uiPort);
tray.onQuitRequested(() => void shutdown("tray quit"));

let shuttingDown = false;
async function shutdown(why: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gpn] shutting down (${why})`);
  stopWatchdog();
  tray.stop();
  if (config.tunnelEnabled) await tunnel.teardown().catch(() => {}); // don't leave the VPN running headless
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Auto-open dashboard in the default browser (skip in dev with GPN_NO_OPEN=1)
if (!process.env.GPN_NO_OPEN) {
  const target = `http://localhost:${config.uiPort}`;
  const [cmd, args] =
    process.platform === "win32"
      ? (["cmd", ["/c", "start", "", target]] as const)
      : process.platform === "darwin"
        ? (["open", [target]] as const)
        : (["xdg-open", [target]] as const);
  spawn(cmd, [...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// ---- target orchestration: debounced, coalesced and strictly serialized ----
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingIps: string[] | null = null;
let applying = false;

function publicIps(targets: Target[]): string[] {
  return [...new Set(targets.map((t) => t.ip))].filter(isPublicIpv4).sort();
}

watcher.on("targetsChanged", (targets: Target[]) => {
  const ips = publicIps(targets);
  console.log(`[gpn] active game IPs: ${ips.join(", ") || "(none)"}`);

  if (ips.length === 0) {
    // game connections vanish briefly on loading screens / server transfers: wait before tearing down
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingIps = null;
    idleTimer ??= setTimeout(() => {
      idleTimer = null;
      void goIdle();
    }, IDLE_GRACE_MS);
    return;
  }

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  pendingIps = ips;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void drain();
  }, DEBOUNCE_MS);
});

async function drain() {
  if (applying) return; // the running drain loop will pick up pendingIps
  applying = true;
  try {
    while (pendingIps) {
      const ips = pendingIps;
      pendingIps = null;
      const st = tunnel.state;
      if (st.tunnelUp && sameSet(st.allowedIps, ips)) continue; // nothing new
      try {
        if (config.tunnelEnabled) {
          await tunnel.applyTargets(ips); // registers, syncs the server, updates AllowedIPs
          console.log(`[gpn] tunnel allowed-ips: ${ips.join(", ")}`);
        } else {
          await api.pushTargets(ips);
        }
      } catch (e) {
        console.error("[gpn] target update failed:", e);
      }
    }
  } finally {
    applying = false;
  }
}

async function goIdle() {
  console.log("[gpn] no game traffic");
  try {
    if (api.peerKey) await api.pushTargets([]).catch((e) => console.error("[gpn] clearing server targets failed:", e));
    if (config.tunnelEnabled && config.tunnelTeardownWhenIdle && tunnel.state.tunnelUp) {
      console.log("[gpn] tearing down tunnel");
      await tunnel.teardown();
    }
  } catch (e) {
    console.error("[gpn] idle handling failed:", e);
  }
}

watcher.on("gameStopped", (proc) => console.log(`[gpn] game stopped: ${proc.name} (pid ${proc.pid})`));

// Auto-watch from saved config
for (const exe of config.games) {
  watcher.watchExecutable(exe);
}
