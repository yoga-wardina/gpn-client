/**
 * Local WireGuard tunnel management for the GPN client (Windows-first).
 *
 * Uses the WireGuard NT command line (wg.exe / wireguard.exe / wg-quick.exe)
 * expected at C:\Program Files\WireGuard\. Flow:
 *   1. register with GPN server -> get assigned VPN IP + server pub key
 *   2. generate a client keypair + a wg-quick config with AllowedIPs = game targets
 *   3. `wireguard.exe /installtunnelservice <conf>` to bring the tunnel up as admin
 *   4. on each targets push, rewrite AllowedIPs in the config and reload the tunnel
 *
 * Requires: WireGuard for Windows installed + the app running elevated once
 * (tunnel service install needs admin; the service itself keeps running after).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";
import { loadPersistedValue, savePersistedValue } from "./config.ts";

/** client WG private key persisted next to the config */
function loadClientKey(): string | null {
  return loadPersistedValue("wgPrivateKey");
}
function saveClientKey(priv: string) {
  savePersistedValue("wgPrivateKey", priv);
}

const WG_DIR = "C:\\Program Files\\WireGuard";
const TUNNEL_DIR = join(WG_DIR, "Tunnel Configs");
const TUNNEL_NAME = "gpn";

/** path of the conf file the watchdog reloads from */
let currentConfPath = join(TUNNEL_DIR, `${TUNNEL_NAME}.conf`);

export interface TunnelState {
  registered: boolean;
  vpnIp?: string;
  tunnelUp: boolean;
  allowedIps: string[];
  lastError?: string;
}

export class TunnelManager {
  private clientPriv?: string;
  private clientPub?: string;
  private vpnIp?: string;
  private serverPub?: string;
  private serverEndpoint?: string;
  private allowedIps: string[] = [];
  private tunnelUp = false;
  lastError?: string;

  get state(): TunnelState {
    return {
      registered: !!this.clientPub,
      vpnIp: this.vpnIp,
      tunnelUp: this.tunnelUp,
      allowedIps: [...this.allowedIps],
      lastError: this.lastError,
    };
  }

  private wgExe(exe: string): string {
    return join(WG_DIR, exe);
  }

  /** Register with the GPN server and generate our keypair. */
  constructor(private api?: { peerKey: string | null }) {}

  async register(apiUrl: string, token: string): Promise<TunnelState> {
    this.lastError = undefined;
    try {
      // keypair — reuse persisted one if present so restarts keep the same WG identity
      let priv = loadClientKey();
      if (!priv) {
        priv = (await run(this.wgExe("wg.exe"), ["genkey"])).trim();
        saveClientKey(priv);
      }
      const pub = (await run(this.wgExe("wg.exe"), ["pubkey"], 30_000, priv)).trim();
      this.clientPriv = priv;
      this.clientPub = pub;
      if (this.api) this.api.peerKey = pub;

      const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ publicKey: pub, name: "windows-client" }),
      });
      if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`);
      const data = await res.json();
      this.vpnIp = data.ip;
      this.serverPub = data.serverPublicKey;
      this.serverEndpoint = data.endpoint;
      return this.state;
    } catch (e) {
      this.lastError = String(e);
      throw e;
    }
  }

  /** Create/update the tunnel config with current game target IPs and apply it. */
  async applyTargets(apiUrl: string, token: string, targets: { ip: string; port?: number }[]): Promise<TunnelState> {
    this.lastError = undefined;
    try {
      if (!this.clientPriv || !this.vpnIp || !this.serverPub) {
        await this.register(apiUrl, token);
      }

      // notify the server (so its side routes for this peer) — REQUIRED, not best-effort
      try {
        const push = await fetch(`${apiUrl.replace(/\/$/, "")}/api/targets`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-gpn-peer": this.clientPub!,
          },
          body: JSON.stringify({ targets, ts: Date.now() }),
        });
        if (!push.ok) throw new Error(`HTTP ${push.status}: ${await push.text()}`);
        console.log("[gpn] server-side routes synced");
      } catch (e) {
        console.error("[gpn] server-side route sync FAILED (traffic will bypass tunnel for new IPs):", e);
      }

      const ips = [...new Set(targets.map((t) => t.ip))]
        .filter((ip) => ip !== "127.0.0.1" && !ip.startsWith("10.66.") && !ip.startsWith("192.168.") && !/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
      if (!ips.length) {
        console.log("[gpn] no routable game IPs — skipping tunnel update");
        return this.state;
      }
      this.allowedIps = ips;

      // write wg-quick style config into the standard Program Files location
      if (!existsSync(TUNNEL_DIR)) mkdirSync(TUNNEL_DIR, { recursive: true });
      const confPath = join(TUNNEL_DIR, `${TUNNEL_NAME}.conf`);
      const conf = [
        "[Interface]",
        `PrivateKey = ${this.clientPriv}`,
        `Address = ${this.vpnIp}/32`,
        "DNS = 1.1.1.1",
        "",
        "[Peer]",
        `PublicKey = ${this.serverPub}`,
        "AllowedIPs = " + ips.join(", "),
        `Endpoint = ${this.serverEndpoint}`,
        "PersistentKeepalive = 15",
        "",
      ].join("\n");
      writeFileSync(confPath, conf);
      currentConfPath = confPath;

      // (re)install tunnel service to apply the new AllowedIPs.
      // Windows WireGuard needs uninstall+install to reload; doing it on every
      // target change causes a ~1s blip but keeps routing correct.
      if (!this.tunnelUp) {
        await run(this.wgExe("wireguard.exe"), ["/installtunnelservice", confPath]);
        this.tunnelUp = true;
      } else {
        // verify the running config actually matches what we just wrote —
        // if yes, skip the disruptive reload
        try {
          const cur = await run(this.wgExe("wg.exe"), ["show", TUNNEL_NAME, "allowed-ips"]);
          const running = cur.trim().split("\n")[0]?.split("\t")[1] ?? "";
          const want = ips.map((i) => `${i}/32`).join("  ");
          const wantAlt = ips.map((i) => `${i}/32`).join(", ");
          if (running === want || running === wantAlt || running.replace(/, /g, " ") === want) {
            return this.state; // already in sync
          }
        } catch {}
        await run(this.wgExe("wireguard.exe"), ["/uninstalltunnelservice", TUNNEL_NAME]);
        await run(this.wgExe("wireguard.exe"), ["/installtunnelservice", confPath]);
      }
      return this.state;
    } catch (e) {
      this.lastError = String(e);
      throw e;
    }
  }

  async teardown(): Promise<void> {
    try {
      await run(this.wgExe("wireguard.exe"), ["/uninstalltunnelservice", TUNNEL_NAME]);
    } catch {}
    this.tunnelUp = false;
    this.allowedIps = [];
  }

  /** best-effort probe of current service status */
  async probeStatus(): Promise<boolean> {
    try {
      const out = await run("sc", ["query", "WireGuardTunnel$gpn"]);
      this.tunnelUp = out.includes("RUNNING");
    } catch {
      this.tunnelUp = false;
    }
    return this.tunnelUp;
  }

  /**
   * Watchdog — every 30s: if the tunnel service is running but the latest
   * handshake is older than 3 minutes (25s/15s keepalives should renew it
   * every ~2min), the NAT mapping has gone stale: reinstall the service to
   * force a fresh handshake. Requires admin, same as install.
   */
  startWatchdog(reloadConfPath: () => string = () => currentConfPath): () => void {
    let stop = false;
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 30_000));
        if (stop) return;
        try {
          if (!(await this.probeStatus())) continue;
          const out = await run(this.wgExe("wg.exe"), ["show", TUNNEL_NAME, "latest-handshakes"]);
          const hsAgo = parseInt(out.trim().split("\t")[1] ?? "0", 10);
          if (hsAgo > 180) {
            console.log(`[gpn] watchdog: handshake stale (${hsAgo}s) — reloading tunnel`);
            const confPath = reloadConfPath();
            await run(this.wgExe("wireguard.exe"), ["/uninstalltunnelservice", TUNNEL_NAME]);
            await new Promise((r) => setTimeout(r, 2000));
            await run(this.wgExe("wireguard.exe"), ["/installtunnelservice", confPath]);
            console.log("[gpn] watchdog: tunnel reloaded");
          }
        } catch (e) {
          console.error("[gpn] watchdog error:", e);
        }
      }
    };
    tick();
    return () => {
      stop = true;
    };
  }
}
