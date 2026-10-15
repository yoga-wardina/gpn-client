/**
 * Local WireGuard tunnel management for the GPN client (Windows-first).
 *
 * Uses WireGuard for Windows (wg.exe / wireguard.exe) in C:\Program Files\WireGuard\. Flow:
 *   1. generate (once) + persist a client keypair; register the public key with the GPN server
 *   2. write a wg-quick config whose AllowedIPs are only the detected public game IPs
 *      (split tunnel: everything else keeps going direct)
 *   3. `wireguard.exe /installtunnelservice <conf>` brings the tunnel up
 *   4. on target changes: tell the server, then apply the new AllowedIPs
 *
 * Requires WireGuard for Windows installed and this app running elevated (service install).
 * All mutating operations are serialized through lock().
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { run, runStrict } from "./proc.ts";
import { config, restrictFile, saveConfig } from "./config.ts";
import { errorMessage, type GpnApi } from "./api.ts";
import { isPublicIpv4, sameSet, sleep } from "./net.ts";
import { TUNNEL_DIR, TUNNEL_NAME, wgExe } from "./wgpaths.ts";

export interface TunnelState {
  registered: boolean;
  vpnIp?: string;
  tunnelUp: boolean;
  allowedIps: string[];
  lastError?: string;
}

const SERVICE = `WireGuardTunnel$${TUNNEL_NAME}`;

export class TunnelManager {
  private clientPriv?: string;
  private clientPub?: string;
  private vpnIp?: string;
  private serverPub?: string;
  private serverEndpoint?: string;
  private allowedIps: string[] = [];
  private tunnelUp = false;
  private upSince = 0;
  private confPath = join(TUNNEL_DIR, `${TUNNEL_NAME}.conf`);
  private queue: Promise<unknown> = Promise.resolve();
  lastError?: string;

  constructor(private api: GpnApi) {}

  get state(): TunnelState {
    return {
      registered: !!this.vpnIp,
      vpnIp: this.vpnIp,
      tunnelUp: this.tunnelUp,
      allowedIps: [...this.allowedIps],
      lastError: this.lastError,
    };
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Adopt a tunnel service left running by a previous run (crash / restart). */
  async init(): Promise<void> {
    if (process.platform !== "win32") return;
    if (await this.probeStatus()) {
      this.upSince = Date.now();
      this.allowedIps = (await this.runningAllowedIps()) ?? [];
      console.log(`[gpn] adopted running tunnel (${this.allowedIps.length} allowed ip(s))`);
    }
  }

  /** Register with the GPN server (idempotent) and make sure we have a keypair. */
  register(): Promise<TunnelState> {
    return this.lock(async () => {
      this.lastError = undefined;
      try {
        await this.registerInner();
        return this.state;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      }
    });
  }

  private async ensureKeys() {
    let priv = config.wgPrivateKey;
    if (!priv) {
      priv = (await runStrict(wgExe("wg.exe"), ["genkey"])).trim();
      saveConfig({ wgPrivateKey: priv }); // persisted in the single shared config object
    }
    this.clientPriv = priv;
    this.clientPub = (await runStrict(wgExe("wg.exe"), ["pubkey"], { stdin: priv })).trim();
    this.api.peerKey = this.clientPub;
  }

  private async registerInner() {
    await this.ensureKeys();
    const res = await this.api.request("/api/register", {
      method: "POST",
      body: { publicKey: this.clientPub, name: hostname().slice(0, 64) },
    });
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status} ${await errorMessage(res)}`);
    const data: any = await res.json();
    this.vpnIp = data.ip;
    this.serverPub = data.serverPublicKey;
    this.serverEndpoint = data.endpoint;
  }

  /** Tell the server our current targets. Re-registers once if the server forgot this peer. */
  private async syncServer(ips: string[]) {
    const post = () => this.api.request("/api/targets", { method: "POST", body: { targets: ips.map((ip) => ({ ip })), ts: Date.now() } });
    try {
      let res = await post();
      if (res.status === 404) {
        await this.registerInner();
        res = await post();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await errorMessage(res)}`);
      console.log("[gpn] server-side routes synced");
    } catch (e) {
      console.error("[gpn] server-side route sync FAILED:", e);
    }
  }

  /** Apply the given public game IPs: sync the server, then create/update the tunnel. */
  applyTargets(ips: string[]): Promise<TunnelState> {
    return this.lock(async () => {
      this.lastError = undefined;
      try {
        const next = [...new Set(ips)].filter(isPublicIpv4).sort();
        if (!next.length) return this.state;
        if (this.tunnelUp && sameSet(this.allowedIps, next)) return this.state;

        if (!this.clientPriv || !this.vpnIp || !this.serverPub || !this.serverEndpoint) await this.registerInner();
        await this.syncServer(next);

        if (!existsSync(TUNNEL_DIR)) mkdirSync(TUNNEL_DIR, { recursive: true });
        // No DNS line: with a split tunnel the DNS server isn't in AllowedIPs and would break name resolution.
        writeFileSync(
          this.confPath,
          [
            "[Interface]",
            `PrivateKey = ${this.clientPriv}`,
            `Address = ${this.vpnIp}/32`,
            "",
            "[Peer]",
            `PublicKey = ${this.serverPub}`,
            `AllowedIPs = ${next.join(", ")}`,
            `Endpoint = ${this.serverEndpoint}`,
            "PersistentKeepalive = 15",
            "",
          ].join("\n")
        );
        restrictFile(this.confPath, ["*S-1-5-18", "*S-1-5-32-544"]); // SYSTEM + Administrators only

        if (!this.tunnelUp) {
          await this.install();
        } else {
          const running = await this.runningAllowedIps();
          if (running && sameSet(running, next)) {
            // already in sync — nothing to do
          } else if (config.tunnelLiveUpdate && (await this.liveUpdate(this.allowedIps, next))) {
            console.log("[gpn] tunnel updated live");
          } else {
            await this.reinstall();
          }
        }
        this.allowedIps = next;
        return this.state;
      } catch (e) {
        this.lastError = String(e);
        throw e;
      }
    });
  }

  teardown(): Promise<void> {
    return this.lock(async () => {
      await this.uninstall();
      this.tunnelUp = false;
      this.allowedIps = [];
    });
  }

  private async install() {
    try {
      await runStrict(wgExe("wireguard.exe"), ["/installtunnelservice", this.confPath]);
    } catch (first) {
      // service may already exist (stale from a crash): remove and retry once
      await this.uninstall();
      await sleep(1000);
      try {
        await runStrict(wgExe("wireguard.exe"), ["/installtunnelservice", this.confPath]);
      } catch (e) {
        throw new Error(`could not install the tunnel service (is the app running as Administrator?): ${e}`);
      }
    }
    for (let i = 0; i < 10; i++) {
      if (await this.probeStatus()) {
        this.upSince = Date.now();
        return;
      }
      await sleep(500);
    }
    throw new Error("tunnel service installed but is not running");
  }

  private async uninstall() {
    try {
      await runStrict(wgExe("wireguard.exe"), ["/uninstalltunnelservice", TUNNEL_NAME]);
    } catch {} // not installed is fine
  }

  /** Windows only reloads AllowedIPs/routes on service (re)start: costs a short blip. */
  private async reinstall() {
    await this.uninstall();
    await sleep(500);
    await this.install();
  }

  /**
   * Experimental no-blip path: update the peer's allowed-ips on the live interface and
   * add/remove the /32 routes ourselves. Returns false (caller reinstalls) on any failure.
   */
  private async liveUpdate(prev: string[], next: string[]): Promise<boolean> {
    try {
      await runStrict(wgExe("wg.exe"), ["set", TUNNEL_NAME, "peer", this.serverPub!, "allowed-ips", next.map((i) => `${i}/32`).join(",")]);
      for (const ip of next.filter((x) => !prev.includes(x))) {
        await runStrict("netsh", ["interface", "ipv4", "add", "route", `prefix=${ip}/32`, `interface=${TUNNEL_NAME}`]);
      }
      for (const ip of prev.filter((x) => !next.includes(x))) {
        await run("netsh", ["interface", "ipv4", "delete", "route", `prefix=${ip}/32`, `interface=${TUNNEL_NAME}`]);
      }
      const running = await this.runningAllowedIps();
      return !!running && sameSet(running, next);
    } catch (e) {
      console.error("[gpn] live tunnel update failed, falling back to reinstall:", e);
      return false;
    }
  }

  /** Current allowed-ips of the running interface (order-insensitive), or null if unreadable. */
  private async runningAllowedIps(): Promise<string[] | null> {
    try {
      const out = await runStrict(wgExe("wg.exe"), ["show", TUNNEL_NAME, "allowed-ips"]);
      const line = out.trim().split("\n")[0] ?? "";
      return (line.split("\t")[1] ?? "")
        .split(/[\s,]+/)
        .map((s) => s.replace(/\/32$/, ""))
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  /** Is the tunnel service actually RUNNING? Updates tunnelUp. */
  async probeStatus(): Promise<boolean> {
    try {
      const out = await run("sc", ["query", SERVICE], 10_000);
      this.tunnelUp = out.includes("RUNNING");
    } catch {
      this.tunnelUp = false;
    }
    return this.tunnelUp;
  }

  /**
   * Watchdog — every 30s: if the tunnel is running but the latest handshake is older
   * than 3 minutes (keepalives should renew it every ~2 min) — or there has never been
   * one since it came up — reinstall the service to force a fresh handshake.
   * `wg show latest-handshakes` prints a UNIX TIMESTAMP (0 = never), not an age.
   */
  startWatchdog(): () => void {
    let stop = false;
    let lastReload = 0;
    void (async () => {
      while (!stop) {
        await sleep(30_000);
        if (stop) return;
        try {
          if (!(await this.probeStatus())) continue;
          const out = await run(wgExe("wg.exe"), ["show", TUNNEL_NAME, "latest-handshakes"], 10_000);
          const ts = parseInt(out.trim().split("\n")[0]?.split("\t")[1] ?? "0", 10) || 0;
          const now = Date.now();
          const ageSec = ts > 0 ? now / 1000 - ts : (now - this.upSince) / 1000;
          if (ageSec > 180 && now - lastReload > 120_000) {
            lastReload = now;
            console.log(`[gpn] watchdog: handshake stale (${Math.round(ageSec)}s) — reloading tunnel`);
            await this.lock(() => this.reinstall());
            console.log("[gpn] watchdog: tunnel reloaded");
          }
        } catch (e) {
          console.error("[gpn] watchdog error:", e);
        }
      }
    })();
    return () => {
      stop = true;
    };
  }
}
