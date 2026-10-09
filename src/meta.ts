/**
 * Game metadata — derives display name + icon directly from the executable.
 * Windows: PowerShell reads VersionInfo (FileDescription/ProductName) and
 * extracts the associated icon as PNG base64. No native deps, works on any
 * Windows box. Falls back to the exe filename when version info is missing.
 * Results are cached in memory + on disk (meta.json next to the config).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "./proc.ts";

export interface GameMeta {
  /** best-effort display name */
  name: string;
  /** publisher, if available */
  company?: string;
  /** PNG data URL of the exe icon, if extractable */
  icon?: string;
  /** where the name came from */
  source: "versioninfo" | "filename";
}

import { META_PATH as CACHE_PATH } from "./config.ts";
const cache = new Map<string, GameMeta>();

if (existsSync(CACHE_PATH)) {
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(CACHE_PATH, "utf8")))) {
      cache.set(k, v as GameMeta);
    }
  } catch {}
}

function persist() {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch (e) {
    console.error("[meta] cache write failed:", e);
  }
}

/** Identifier key for a watched entry (basename, case-insensitive). */
export function metaKey(exe: string): string {
  return basename(exe).toLowerCase();
}

export function getCachedMeta(exe: string): GameMeta | undefined {
  return cache.get(metaKey(exe));
}

/**
 * Resolve metadata for an executable. `exe` may be a full path (Windows) or a
 * bare process name like "AION2.exe" — a bare name with no directory can only
 * give filename-based metadata, so the UI should pass full paths when it can.
 */
export async function resolveMeta(exe: string): Promise<GameMeta> {
  const key = metaKey(exe);
  const hit = cache.get(key);
  if (hit) return hit;

  let meta: GameMeta;
  if (process.platform === "win32") {
    meta = await resolveWindows(exe);
  } else {
    meta = { name: stripExe(basename(exe)), source: "filename" };
  }
  cache.set(key, meta);
  persist();
  return meta;
}

async function resolveWindows(exe: string): Promise<GameMeta> {
  const fallback: GameMeta = { name: stripExe(basename(exe)), source: "filename" };
  // only try shell lookups if we have a real path with a directory
  if (!exe.includes("\\") && !exe.includes("/")) return fallback;

  try {
    // Version info: FileDescription is what games usually set (e.g. "AION2 Game Client")
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `$f = Get-Item -LiteralPath '${exe.replace(/'/g, "''")}'`,
      `$v = $f.VersionInfo`,
      `$i = $null`,
      `try {`,
      `  Add-Type -AssemblyName System.Drawing`,
      `  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($f.FullName)`,
      `  if ($ico) {`,
      `    $ms = New-Object System.IO.MemoryStream`,
      `    $ico.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)`,
      `    $i = [Convert]::ToBase64String($ms.ToArray())`,
      `  }`,
      `} catch {}`,
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8`,
      `@{ name = @($v.FileDescription, $v.ProductName, $f.Name) | Where-Object { $_ } | Select-Object -First 1;`,
      `   company = $v.CompanyName; icon = $i } | ConvertTo-Json -Compress`,
    ].join("; ");
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 15_000);
    const trimmed = out.trim();
    if (!trimmed) return fallback;
    const obj = JSON.parse(trimmed.startsWith("{") ? trimmed : `{${trimmed}}`);
    const name = typeof obj.name === "string" && obj.name ? obj.name : fallback.name;
    const meta: GameMeta = {
      name,
      company: typeof obj.company === "string" && obj.company ? obj.company : undefined,
      icon: typeof obj.icon === "string" && obj.icon ? `data:image/png;base64,${obj.icon}` : undefined,
      source: name !== fallback.name ? "versioninfo" : "filename",
    };
    return meta;
  } catch (e) {
    console.error("[meta] windows resolve failed:", e);
    return fallback;
  }
}

function stripExe(name: string): string {
  return name.replace(/\.exe$/i, "");
}
