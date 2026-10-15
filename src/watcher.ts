/**
 * GameWatcher — watches for a game process and polls its network connections.
 * Works on Windows (netstat) and Linux (ss) by parsing per-PID socket tables.
 *
 * Only established TCP connections to public IPv4 hosts are reported. UDP is not
 * detected on Windows: netstat lists UDP sockets without a remote address.
 */
import { EventEmitter } from "node:events";
import { run } from "./proc.ts";
import { baseName, isPublicIpv4, sleep } from "./net.ts";

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
  remote: string;
  proto: "tcp" | "udp";
}

// English TCP states that mean "not an active connection". (Windows localizes state names;
// on other locales nothing is excluded here and only the remote-port check applies.)
const DEAD_STATES = new Set(["TIME_WAIT", "CLOSE_WAIT", "FIN_WAIT_1", "FIN_WAIT_2", "LAST_ACK", "CLOSING", "SYN_SENT", "SYN_RECEIVED"]);

export class GameWatcher extends EventEmitter {
  private watchedExes: string[] = []; // lowercase file names
  private activeProcs = new Map<number, GameProc>();
  private targets = new Map<string, Target>(); // key: proto:ip:port
  private running = false;

  constructor(
    private pollMs = 2000,
    private getPorts: () => number[] = () => []
  ) {
    super();
  }

  watchExecutable(nameOrPath: string) {
    const n = baseName(nameOrPath).toLowerCase();
    if (n && !this.watchedExes.includes(n)) this.watchedExes.push(n);
  }

  unwatchExecutable(nameOrPath: string) {
    const n = baseName(nameOrPath).toLowerCase();
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
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  /** Self-scheduling so a slow netstat can never cause overlapping ticks. */
  private async loop() {
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error("[watcher]", e);
      }
      await sleep(this.pollMs);
    }
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
    const ports = this.getPorts();
    const now = Date.now();
    const prevKeys = new Set(this.targets.keys());

    for (const c of conns) {
      const ep = parseEndpoint(c.remote);
      if (!ep || !isPublicIpv4(ep.ip)) continue;
      if (ports.length && !ports.includes(ep.port)) continue;
      const key = `${c.proto}:${ep.ip}:${ep.port}`;
      const existing = this.targets.get(key);
      if (existing) existing.lastSeen = now;
      else this.targets.set(key, { ip: ep.ip, port: ep.port, proto: c.proto, firstSeen: now, lastSeen: now });
    }

    // expire targets not seen recently
    for (const [k, t] of this.targets) {
      if (t.lastSeen < now - this.pollMs * 3) this.targets.delete(k);
    }

    const changed = prevKeys.size !== this.targets.size || [...this.targets.keys()].some((k) => !prevKeys.has(k));
    if (changed) this.emit("targetsChanged", this.listTargets());
  }

  private matches(procName: string, minTruncatedLen: number): boolean {
    const name = procName.toLowerCase();
    // tasklist/ps truncate long image names; accept a truncated prefix of a watched name
    return this.watchedExes.some((w) => name === w || (name.length >= minTruncatedLen && w.startsWith(name)));
  }

  private async findWatchedProcesses(): Promise<GameProc[]> {
    if (!this.watchedExes.length) return [];
    if (process.platform === "win32") {
      // tasklist CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
      const out = await run("tasklist", ["/FO", "CSV", "/NH"], 10_000);
      return parseCsvLines(out)
        .filter((r) => r[0] && this.matches(r[0], 25))
        .map((r) => ({ name: r[0]!, pid: parseInt(r[1] ?? "", 10) }))
        .filter((p) => !isNaN(p.pid));
    }
    const out = await run("ps", ["-eo", "pid,comm"], 10_000);
    return out
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const [pidStr, ...rest] = line.trim().split(/\s+/);
        return { pid: parseInt(pidStr ?? "", 10), name: rest.join(" ") };
      })
      .filter((p) => !isNaN(p.pid) && this.matches(p.name, 15));
  }

  private async getConnections(pids: number[]): Promise<ConnLine[]> {
    const wanted = new Set(pids);
    const lines: ConnLine[] = [];
    if (process.platform === "win32") {
      // netstat -nao TCP rows: Proto Local Foreign State PID  (UDP rows have no state => 4 columns, skipped)
      const out = await run("netstat", ["-nao"], 10_000);
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [proto, , remote, state, pidStr] = parts as [string, string, string, string, string];
        if (!proto.toLowerCase().startsWith("tcp")) continue;
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid) || !wanted.has(pid)) continue;
        if (DEAD_STATES.has(state.toUpperCase())) continue;
        lines.push({ pid, remote, proto: "tcp" });
      }
    } else {
      // ss -tunap: Netid State Recv-Q Send-Q Local Peer Process
      const out = await run("ss", ["-tunap"], 10_000);
      for (const line of out.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6 || parts[1] !== "ESTAB") continue;
        const pid = parseInt(line.match(/pid=(\d+)/)?.[1] ?? "", 10);
        if (isNaN(pid) || !wanted.has(pid)) continue;
        lines.push({ pid, remote: parts[5]!, proto: parts[0] === "udp" ? "udp" : "tcp" });
      }
    }
    return lines;
  }
}

/** "1.2.3.4:443", "[2001:db8::1]:443" or "[::ffff:1.2.3.4]:443" -> {ip, port}; null for "*:*" etc. */
function parseEndpoint(s: string): { ip: string; port: number } | null {
  let host: string;
  let portStr: string;
  const m = /^\[(.+)\]:(\d+)$/.exec(s);
  if (m) {
    host = m[1]!;
    portStr = m[2]!;
  } else {
    const i = s.lastIndexOf(":");
    if (i < 0) return null;
    host = s.slice(0, i);
    portStr = s.slice(i + 1);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) host = mapped[1]!;
  const port = parseInt(portStr, 10);
  if (!Number.isInteger(port) || port <= 0) return null; // 0 = LISTENING rows
  return { ip: host, port };
}

function parseCsvLines(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.match(/"((?:[^"]|"")*)"/g)?.map((s) => s.slice(1, -1).replace(/""/g, '"')) ?? []);
}
