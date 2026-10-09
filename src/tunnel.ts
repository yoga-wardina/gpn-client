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

const WG_DIR = "C:\\Program Files\\WireGuard";
const TUNNEL_DIR = join(WG_DIR, "Tunnel Configs");
const TUNNEL_NAME = "gpn";

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
  async register(apiUrl: string, token: string): Promise<TunnelState> {
    this.lastError = undefined;
    try {
      // keypair (wg.exe genkey / pubkey)
      const priv = (await run(this.wgExe("wg.exe"), ["genkey"])).trim();
      const pub = (await run(this.wgExe("wg.exe"), ["pubkey"], 30_000, priv)).trim();
      this.clientPriv = priv;
      this.clientPub = pub;
      api.peerKey = pub;

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

      // notify the server (so its side routes for this peer) — best effort
      await fetch(`${apiUrl.replace(/\/$/, "")}/api/targets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-gpn-peer": this.clientPub!,
        },
        body: JSON.stringify({ targets, ts: Date.now() }),
      }).catch(() => {}); // server update is belt-and-braces; client side config is what matters

      const ips = [...new Set(targets.map((t) => t.ip))];
      this.allowedIps = ips;

      // write wg-quick style config
      if (!existsSync(TUNNEL_DIR)) mkdirSync(TUNNEL_DIR, { recursive: true });
      const confPath = join(TUNNEL_DIR, `${TUNNEL_NAME}.conf`);
      const conf = [
        "[Interface]",
        `PrivateKey = ${this.clientPriv}`,
        `Address = ${this.vpnIp}/32`,
        "",
        "[Peer]",
        `PublicKey = ${this.serverPub}`,
        "AllowedIPs = " + (ips.length ? ips.join(", ") : "0.0.0.0/0"),
        `Endpoint = ${this.serverEndpoint}`,
        "PersistentKeepalive = 25",
        "",
      ].join("\n");
      writeFileSync(confPath, conf);

      // (re)install tunnel service — idempotent; reloads config
      if (!this.tunnelUp) {
        await run(this.wgExe("wireguard.exe"), ["/installtunnelservice", confPath]);
        this.tunnelUp = true;
      } else {
        // service is running; re-install replaces config. Need admin.
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
}
