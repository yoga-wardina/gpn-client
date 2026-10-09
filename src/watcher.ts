/**
 * GameWatcher — watches for a game process and polls its network connections.
 * Works on Windows (netstat) and Linux (ss) by parsing per-PID socket tables.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface GameProc {
  pid: number;
  name: string;
}

export interface Target {
  ip: string;
  port?: number;
  proto: "tcp" | "udp";
  firstSeen: number;
  lastSeen: number;
}

interface ConnLine {
  pid: number;
  local: string;
  remote: string;
  proto: "tcp" | "udp";
  state: string;
}

export class GameWatcher extends EventEmitter {
  private watchedExes: string[] = [];
  private activeProcs = new Map<number, GameProc>();
  private targets = new Map<string, Target>(); // key: ip:port:proto
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;

  constructor(pollMs = 2000) {
    super();
    this.pollMs = pollMs;
  }

  watchExecutable(nameOrPath: string) {
    const n = nameOrPath.toLowerCase();
    if (!this.watchedExes.includes(n)) this.watchedExes.push(n);
  }

  unwatchExecutable(nameOrPath: string) {
    const n = nameOrPath.toLowerCase();
    this.watchedExes = this.watchedExes.filter((x) => x !== n);
  }

  listWatched() {
    return [...this.watchedExes];
  }

  listTargets(): Target[] {
    return [...this.targets.values()];
  }

  listProcs(): GameProc[] {
    return [...this.activeProcs.values()];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => console.error("[watcher]", e)), this.pollMs);
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    const procs = await this.findWatchedProcesses();
    const started = procs.filter((p) => !this.activeProcs.has(p.pid));
    const stopped = [...this.activeProcs.values()].filter((p) => !procs.some((q) => q.pid === p.pid));

    for (const p of started) {
      this.activeProcs.set(p.pid, p);
      this.emit("gameStarted", p);
    }
    for (const p of stopped) {
      this.activeProcs.delete(p.pid);
      this.emit("gameStopped", p);
    }

    if (procs.length === 0) {
      if (this.targets.size > 0) {
        this.targets.clear();
        this.emit("targetsChanged", []);
      }
      return;
    }

    const conns = await this.getConnections(procs.map((p) => p.pid));
    const now = Date.now();
    const prevKeys = new Set(this.targets.keys());

    for (const c of conns) {
      const ip = c.remote.split(":").slice(0, -1).join(":"); // handle IPv6 [::]:port too
      if (!ip || ip === "0.0.0.0" || ip === "::" || ip === "-") continue;
      const portStr = c.remote.split(":").pop() ?? "";
      const port = parseInt(portStr, 10);
      const key = `${c.proto}:${ip}:${port}`;
      const existing = this.targets.get(key);
      if (existing) {
        existing.lastSeen = now;
      } else {
        this.targets.set(key, { ip, port, proto: c.proto, firstSeen: now, lastSeen: now });
      }
    }

    // expire stale targets not seen this round
    for (const [k, t] of this.targets) {
      if (t.lastSeen < now - this.pollMs * 3) this.targets.delete(k);
    }

    const changed =
      prevKeys.size !== this.targets.size ||
      [...this.targets.keys()].some((k) => !prevKeys.has(k));
    if (changed) this.emit("targetsChanged", this.listTargets());
  }

  private async findWatchedProcesses(): Promise<GameProc[]> {
    if (process.platform === "win32") {
      // tasklist CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
      const out = await run("tasklist", ["/FO", "CSV", "/NH"]);
      const rows = parseCsvLines(out);
      return rows
        .filter((r) => this.watchedExes.some((w) => r[0]?.toLowerCase().includes(w)))
        .map((r) => ({ name: r[0], pid: parseInt(r[1], 10) }))
        .filter((p) => !isNaN(p.pid));
    } else {
      // linux/mac: ps aux
      const out = await run("ps", ["-eo", "pid,comm"]);
      return out
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => {
          const [pidStr, ...rest] = line.trim().split(/\s+/);
          return { pid: parseInt(pidStr, 10), name: rest.join(" ") };
        })
        .filter((p) => !isNaN(p.pid) && this.watchedExes.some((w) => p.name.toLowerCase().includes(w)));
    }
  }

  private async getConnectionIds(pids: number[]): Promise<Set<number>> {
    return new Set(pids);
  }

  private async getConnections(pids: number[]): Promise<ConnLine[]> {
    const wanted = new Set(pids);
    if (process.platform === "win32") {
      // netstat -nao: Proto Local Foreign State PID
      const out = await run("netstat", ["-nao"]);
      const lines: ConnLine[] = [];
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [proto, local, remote, state, pidStr] = parts;
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid) || !wanted.has(pid)) continue;
        const p = proto.toLowerCase();
        if (!p.startsWith("tcp") && !p.startsWith("udp")) continue;
        lines.push({
          pid,
          local,
          remote,
          state: p.startsWith("udp") ? "UDP" : state,
          proto: p.startsWith("udp") ? "udp" : "tcp",
        });
      }
      return lines;
    } else {
      // ss -tunap: Netid State Local Peer Process
      const out = await run("ss", ["-tunap"]);
      const lines: ConnLine[] = [];
      for (const line of out.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [netid, , local, remote] = parts;
        const procMatch = line.match(/pid=(\d+)/);
        if (!procMatch) continue;
        const pid = parseInt(procMatch[1], 10);
        if (!wanted.has(pid)) continue;
        const proto = netid === "udp" ? "udp" : "tcp";
        lines.push({ pid, local, remote, state: netid, proto });
      }
      return lines;
    }
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}

function parseCsvLines(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.match(/"((?:[^"]|"")*)"/g)?.map((s) => s.slice(1, -1).replace(/""/g, '"')) ?? []);
}
