import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export interface Config {
  /** Base URL of the GPN VPS API, e.g. https://gpn.example.com */
  gpnServerUrl: string;
  /** Shared machine token for the GPN API (headless fallback when not logged in) */
  gpnToken: string;
  /** Polling interval for connection detection (ms) */
  pollIntervalMs: number;
  /** Local UI port */
  uiPort: number;
  /** List of game executables to auto-watch (name or full path; matched on the file name) */
  games: string[];
  /** If non-empty, only remote ports in this list count as game traffic */
  gamePorts: number[];
  /** Enable local WireGuard tunnel management (requires WireGuard for Windows + admin) */
  tunnelEnabled: boolean;
  /** Tear down the tunnel automatically after a period with no game traffic */
  tunnelTeardownWhenIdle: boolean;
  /** Experimental: apply target changes with `wg set` + routes instead of reinstalling the
   *  tunnel service (no connection blip). Falls back to reinstalling if anything fails. */
  tunnelLiveUpdate: boolean;
  /** Client WireGuard private key (persisted so restarts keep the same peer identity) */
  wgPrivateKey?: string;
  /** Logged-in user session (set by /api/auth flows) */
  auth?: {
    username: string;
    role: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  gpnServerUrl: "http://localhost:9090",
  gpnToken: "",
  pollIntervalMs: 2000,
  uiPort: 7790,
  games: [],
  gamePorts: [],
  tunnelEnabled: true,
  tunnelTeardownWhenIdle: true,
  tunnelLiveUpdate: false,
};

// In a compiled exe, import.meta.dir points into the virtual FS (B:\~BUN\... or /$bunfs).
// Use the exe's real directory so config lives next to GPNClient.exe; in dev (`bun run`)
// use the working directory (NOT dirname(argv0), which would be bun's own install dir).
const COMPILED = import.meta.dir.includes("~BUN") || import.meta.dir.includes("$bunfs");
export const APP_DIR = COMPILED ? dirname(process.execPath) : process.cwd();

export const CONFIG_PATH = join(APP_DIR, "gpn.config.json");
export const META_PATH = join(APP_DIR, "meta.json");

/** The config holds tokens and the WG private key: limit it to the current user (best effort). */
export function restrictFile(path: string, principals: string[]) {
  try {
    if (process.platform === "win32") {
      spawnSync("icacls", [path, "/inheritance:r", "/grant:r", ...principals.map((p) => `${p}:F`)], {
        windowsHide: true,
        timeout: 10_000,
      });
    } else {
      chmodSync(path, 0o600);
    }
  } catch {}
}

function currentUser(): string {
  const user = process.env.USERNAME ?? "";
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
}

function writeConfigFile() {
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), { mode: 0o600 });
}

export function loadConfig(): Promise<void> {
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
      console.log(`[gpn] config loaded from ${CONFIG_PATH}`);
    } catch (e) {
      console.error("[gpn] failed to parse config, using defaults:", e);
    }
  } else {
    writeConfigFile();
    console.log(`[gpn] wrote default config to ${CONFIG_PATH} — edit it before use`);
  }
  // Written in place from here on, so the restricted ACL set now sticks.
  restrictFile(CONFIG_PATH, [currentUser(), "*S-1-5-18"].filter(Boolean));
  return Promise.resolve();
}

export const config = DEFAULT_CONFIG;

/** Merge `partial` into the live config and persist the WHOLE config (nothing can be dropped). */
export function saveConfig(partial: Partial<Config>) {
  Object.assign(DEFAULT_CONFIG, partial);
  try {
    writeConfigFile();
  } catch (e) {
    console.error("[gpn] config save failed:", e);
  }
}
