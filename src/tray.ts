/**
 * Windows tray host — spawns a PowerShell NotifyIcon process that shows a tray
 * icon while the Bun server runs. The tray's Quit action writes tray.exit,
 * which we poll to shut down cleanly. No-ops on non-Windows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "..");

export function startTray(port: number): { onQuitRequested: (cb: () => void) => void } {
  let quitCb: (() => void) | null = null;
  if (process.platform !== "win32") return { onQuitRequested: () => {} };

  const exitFlag = join(APP_DIR, "tray.exit");
  rmSync(exitFlag, { force: true });

  // compile-time embedded tray script is not available; read from assets dir.
  // Bun --compile embeds imported files only if imported; so write it from an
  // embedded string via Bun.embeddedFiles when available, else require assets dir.
  const trayScript = join(APP_DIR, "assets", "tray.ps1");
  if (!existsSync(trayScript)) {
    console.error("[tray] assets/tray.ps1 missing — tray disabled");
    return { onQuitRequested: () => {} };
  }

  const child: ChildProcess = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", trayScript, "-Port", String(port), "-StateDir", APP_DIR],
    { windowsHide: true, stdio: "ignore" }
  );
  child.on("error", (e) => console.error("[tray] failed to start:", e));

  const poll = setInterval(() => {
    if (existsSync(exitFlag)) {
      clearInterval(poll);
      rmSync(exitFlag, { force: true });
      quitCb?.();
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      clearInterval(poll);
    }
  }, 500);

  return {
    onQuitRequested(cb: () => void) {
      quitCb = cb;
    },
  };
}

/** Ensure tray.exit is cleaned on start in case of stale state. */
export function cleanStaleExitFlag() {
  if (process.platform === "win32") rmSync(join(APP_DIR, "tray.exit"), { force: true });
}
