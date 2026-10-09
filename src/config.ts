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
}

export const DEFAULT_CONFIG: Config = {
  gpnServerUrl: "http://localhost:9090",
  gpnToken: "",
  pollIntervalMs: 2000,
  uiPort: 7790,
  games: [],
  gamePorts: [],
};

const CONFIG_PATH = join(import.meta.dir, "..", "gpn.config.json");

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

export const config = DEFAULT_CONFIG;

export function saveConfig(partial: Partial<Config>) {
  Object.assign(DEFAULT_CONFIG, partial);
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
}
