/** Shared child-process runner used by watcher and metadata modules. */
import { spawn } from "node:child_process";

export function run(cmd: string, args: string[], timeoutMs = 30_000, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    if (stdin !== undefined) p.stdin?.write(stdin);
    p.stdin?.end();
    let out = "";
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        p.kill();
        resolve(out); // partial output better than nothing
      }
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", () => {});
    p.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(t);
        reject(e);
      }
    });
    p.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(out);
      }
    });
  });
}
