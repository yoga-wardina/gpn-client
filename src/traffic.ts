/**
 * Network traffic monitor — computes in/out rates. While the GPN tunnel is up it samples the
 * tunnel interface (`wg show gpn transfer`, i.e. actual game traffic through the VPS);
 * otherwise total interface bytes (Windows: `netstat -e`, Linux: /proc/net/dev).
 */
import { run } from "./proc.ts";
import { readFileSync } from "node:fs";
import { sleep } from "./net.ts";
import { TUNNEL_NAME, wgExe } from "./wgpaths.ts";

export interface TrafficSample {
  /** total bytes received (cumulative, of the current source) */
  rxBytes: number;
  /** total bytes sent (cumulative) */
  txBytes: number;
  /** bytes/sec in (computed over the sample window) */
  rxPerSec: number;
  /** bytes/sec out */
  txPerSec: number;
  /** what is being measured */
  source: "tunnel" | "nic";
  ts: number;
}

type Counters = { rx: number; tx: number; source: "tunnel" | "nic" };

let last: (Counters & { ts: number }) | null = null;
let current: TrafficSample = { rxBytes: 0, txBytes: 0, rxPerSec: 0, txPerSec: 0, source: "nic", ts: 0 };

async function readCounters(tunnelUp: boolean): Promise<Counters> {
  if (process.platform === "win32") {
    if (tunnelUp) {
      try {
        // "<peer pubkey>\t<rx>\t<tx>"
        const out = await run(wgExe("wg.exe"), ["show", TUNNEL_NAME, "transfer"], 5_000);
        const [, rx, tx] = (out.trim().split("\n")[0] ?? "").split("\t");
        if (rx !== undefined && tx !== undefined && !isNaN(+rx) && !isNaN(+tx)) return { rx: +rx, tx: +tx, source: "tunnel" };
      } catch {}
    }
    // `netstat -e`: the first "<label> <n> <n>" line is Bytes (matched without relying on the
    // English label so it also works on localized Windows).
    const out = await run("netstat", ["-e"], 5_000);
    for (const line of out.split("\n")) {
      const m = /^\D+(\d+)\s+(\d+)$/.exec(line.trim());
      if (m) return { rx: +m[1]!, tx: +m[2]!, source: "nic" };
    }
    return { rx: 0, tx: 0, source: "nic" };
  }
  // sum all non-loopback interfaces
  const text = readFileSync("/proc/net/dev", "utf8");
  let rx = 0,
    tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const [iface, rest] = line.split(":");
    if (!rest || iface!.trim() === "lo") continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    if (cols.length >= 9) {
      rx += cols[0]!;
      tx += cols[8]!;
    }
  }
  return { rx, tx, source: "nic" };
}

export async function sampleTraffic(tunnelUp = false): Promise<TrafficSample> {
  try {
    const c = await readCounters(tunnelUp);
    const now = Date.now();
    // different source or counter reset => no meaningful delta this round
    if (last && last.source === c.source && now > last.ts && c.rx >= last.rx && c.tx >= last.tx) {
      const dt = (now - last.ts) / 1000;
      current = { rxBytes: c.rx, txBytes: c.tx, rxPerSec: (c.rx - last.rx) / dt, txPerSec: (c.tx - last.tx) / dt, source: c.source, ts: now };
    } else {
      current = { rxBytes: c.rx, txBytes: c.tx, rxPerSec: 0, txPerSec: 0, source: c.source, ts: now };
    }
    last = { ...c, ts: now };
  } catch (e) {
    console.error("[traffic] sample failed:", e);
  }
  return current;
}

export function currentSample(): TrafficSample {
  return current;
}

let stopSampling: (() => void) | null = null;

/** Start the (single) sampling loop; calling it again returns the existing stop function. */
export function startSampling(intervalMs = 2000, tunnelUp: () => boolean = () => false): () => void {
  if (stopSampling) return stopSampling;
  let stop = false;
  void (async () => {
    while (!stop) {
      await sampleTraffic(tunnelUp());
      await sleep(intervalMs);
    }
  })();
  stopSampling = () => {
    stop = true;
    stopSampling = null;
  };
  return stopSampling;
}
