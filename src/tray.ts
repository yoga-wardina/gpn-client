/**
 * Windows tray host — spawns a PowerShell NotifyIcon process that shows a tray
 * icon while the Bun server runs. The tray's Quit action writes tray.exit,
 * which we poll to shut down cleanly. No-ops on non-Windows.
 *
 * The tray script and icon are embedded in the (compiled) exe and extracted to a temp dir at
 * start, because a compiled exe's own import.meta.dir is a virtual path PowerShell can't read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./config.ts";

import TRAY_PS1 from "../assets/tray.ps1" with { type: "text" };
import TRAY_ICO from "../assets/gpn.ico" with { type: "file" };

const EXIT_FLAG = join(APP_DIR, "tray.exit");

export function startTray(port: number): { onQuitRequested: (cb: () => void) => void; stop: () => void } {
  let quitCb: (() => void) | null = null;
  const noop = { onQuitRequested: () => {}, stop: () => {} };
  if (process.platform !== "win32") return noop;

  rmSync(EXIT_FLAG, { force: true });

  const dir = join(tmpdir(), "gpn-client");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tray.ps1");
  const icon = join(dir, "gpn.ico");
  try {
    writeFileSync(script, TRAY_PS1);
    writeFileSync(icon, readFileSync(TRAY_ICO));
  } catch (e) {
    console.error("[tray] could not extract tray assets — tray disabled:", e);
    return noop;
  }

  const child: ChildProcess = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Port", String(port), "-StateDir", APP_DIR, "-IconPath", icon],
    { windowsHide: true, stdio: "ignore" }
  );
  child.on("error", (e) => console.error("[tray] failed to start:", e));

  const poll = setInterval(() => {
    if (existsSync(EXIT_FLAG)) {
      clearInterval(poll);
      rmSync(EXIT_FLAG, { force: true });
      quitCb?.();
    }
    if (child.exitCode !== null) clearInterval(poll);
  }, 500);

  return {
    onQuitRequested(cb: () => void) {
      quitCb = cb;
    },
    stop() {
      clearInterval(poll);
      child.kill();
    },
  };
}

/** Ensure tray.exit is cleaned on start in case of stale state. */
export function cleanStaleExitFlag() {
  if (process.platform === "win32") rmSync(EXIT_FLAG, { force: true });
}
