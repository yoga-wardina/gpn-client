/** Shared child-process runner used by watcher, tunnel and metadata modules. */
import { spawn } from "node:child_process";

export interface RunOpts {
  timeoutMs?: number;
  stdin?: string;
  env?: Record<string, string>;
}

function exec(cmd: string, args: string[], opts: RunOpts, strict: boolean): Promise<string> {
  const { timeoutMs = 30_000, stdin, env } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    if (stdin !== undefined) p.stdin?.write(stdin);
    p.stdin?.end();
    let out = "";
    let err = "";
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill();
      if (strict) reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      else resolve(out); // partial output better than nothing
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (strict && code !== 0) reject(new Error(`${cmd} exited ${code}: ${(err || out).trim().slice(0, 500)}`));
      else resolve(out);
    });
  });
}

/** Lenient: resolves with stdout whatever the exit code (used for polling tools). */
export function run(cmd: string, args: string[], timeoutMs = 30_000, stdin?: string, env?: Record<string, string>) {
  return exec(cmd, args, { timeoutMs, stdin, env }, false);
}

/** Strict: rejects on spawn error, timeout or non-zero exit. */
export function runStrict(cmd: string, args: string[], opts: RunOpts = {}) {
  return exec(cmd, args, opts, true);
}
