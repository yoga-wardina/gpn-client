/**
 * Network traffic monitor — samples total interface bytes and computes
 * in/out rates. Windows: `netstat -e` (interface stats). Linux: /proc/net/dev.
 * Also tracks per-target connection counts from the watcher.
 */
import { run } from "./proc.ts";
import { readFileSync } from "node:fs";

export interface TrafficSample {
  /** total bytes received across interfaces (cumulative) */
  rxBytes: number;
  /** total bytes sent (cumulative) */
  txBytes: number;
  /** bytes/sec in (computed over the sample window) */
  rxPerSec: number;
  /** bytes/sec out */
  txPerSec: number;
  ts: number;
}

let last: { rx: number; tx: number; ts: number } | null = null;
let current: TrafficSample = { rxBytes: 0, txBytes: 0, rxPerSec: 0, txPerSec: 0, ts: 0 };

async function readCounters(): Promise<{ rx: number; tx: number }> {
  if (process.platform === "win32") {
    // netstat -e: "Bytes Received/Bytes Sent" under Interface Statistics
    const out = await run("netstat", ["-e"]);
    let rx = 0, tx = 0;
    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/Bytes/i.test(lines[i])) {
        const nums = (lines[i + 1] ?? "").trim().split(/\s+/).map((n) => parseInt(n, 10));
        if (nums.length >= 2 && !isNaN(nums[0]) && !isNaN(nums[1])) {
          rx = nums[0];
          tx = nums[1];
        }
      }
    }
    return { rx, tx };
  } else {
    // sum all non-loopback interfaces
    const text = readFileSync("/proc/net/dev", "utf8");
    let rx = 0, tx = 0;
    for (const line of text.split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!rest || iface.trim() === "lo") continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      if (cols.length >= 9) {
        rx += cols[0];
        tx += cols[8];
      }
    }
    return { rx, tx };
  }
}

export async function sampleTraffic(): Promise<TrafficSample> {
  try {
    const { rx, tx } = await readCounters();
    const now = Date.now();
    if (last && now > last.ts) {
      const dt = (now - last.ts) / 1000;
      current = {
        rxBytes: rx,
        txBytes: tx,
        rxPerSec: Math.max(0, (rx - last.rx) / dt),
        txPerSec: Math.max(0, (tx - last.tx) / dt),
        ts: now,
      };
    }
    last = { rx, tx, ts: now };
  } catch (e) {
    console.error("[traffic] sample failed:", e);
  }
  return current;
}

export function currentSample(): TrafficSample {
  return current;
}

/** kick off a sampling loop; returns stop function */
export function startSampling(intervalMs = 1000): () => void {
  let stop = false;
  const tick = async () => {
    while (!stop) {
      await sampleTraffic();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  tick();
  return () => {
    stop = true;
  };
}
