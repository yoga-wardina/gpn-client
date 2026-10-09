import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Base URL of the GPN VPS API, e.g. https://gpn.example.com */
  gpnServerUrl: string;
  /** Shared auth token for the GPN API */
  gpnToken: string;
  /** Polling interval for connection detection (ms) */
  pollIntervalMs: number;
  /** Local UI port */
  uiPort: number;
  /** List of game executables to auto-watch (name or full path, case-insensitive substring match) */
  games: string[];
  /** Ports considered "game traffic" (empty = all) */
  gamePorts: number[];
  /** Enable local WireGuard tunnel management (requires WireGuard for Windows + admin) */
  tunnelEnabled: boolean;
  /** Tear down the tunnel automatically when no game traffic */
  tunnelTeardownWhenIdle: boolean;
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
};

// In a compiled exe, import.meta.dir points into the virtual FS (B:\~BUN\...).
// Use the exe's real directory so config lives next to GPNClient.exe.
import { dirname } from "node:path";
import { argv0 } from "node:process";

const EXE_DIR = argv0 && existsSync(argv0) ? dirname(argv0) : process.cwd();

export const CONFIG_PATH = join(EXE_DIR, "gpn.config.json");
export const META_PATH = join(EXE_DIR, "meta.json");

export function loadConfig(): Promise<void> {
  return new Promise((resolve) => {
    if (existsSync(CONFIG_PATH)) {
      try {
        const loaded = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        Object.assign(DEFAULT_CONFIG, loaded);
        console.log(`[gpn] config loaded from ${CONFIG_PATH}`);
      } catch (e) {
        console.error("[gpn] failed to parse config, using defaults:", e);
      }
    } else {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log(`[gpn] wrote default config to ${CONFIG_PATH} — edit it before use`);
    }
    resolve();
  });
}

/** arbitrary persisted values stored inside gpn.config.json (e.g. wg key) */
export function loadPersistedValue(key: string): string | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return typeof c[key] === "string" ? c[key] : null;
  } catch {
    return null;
  }
}

export function savePersistedValue(key: string, value: string) {
  try {
    let c: Record<string, unknown> = {};
    if (existsSync(CONFIG_PATH)) c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    c[key] = value;
    writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
  } catch (e) {
    console.error("[gpn] persist failed:", e);
  }
}

export const config = DEFAULT_CONFIG;

export function saveConfig(partial: Partial<Config>) {
  Object.assign(DEFAULT_CONFIG, partial);
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
}
