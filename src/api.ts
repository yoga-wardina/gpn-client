/** GPN VPS API client — pushes detected game targets to the server. */
import type { Target } from "./watcher.ts";

export class GpnApi {
  /** WireGuard public key of this client (set after tunnel registration) */
  peerKey: string | null = null;

  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  setServer(url: string) {
    this.baseUrl = url;
  }
  setToken(t: string) {
    this.token = t;
  }

  private headers() {
    const h: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
    if (this.peerKey) h["x-gpn-peer"] = this.peerKey;
    return h;
  }

  async pushTargets(targets: Target[]) {
    // plain pushes need the peer key; before tunnel registration the tunnel
    // module handles target routing itself — skip to avoid 400 spam
    if (!this.peerKey) {
      console.log("[gpn] skipping push (not registered yet — tunnel will sync targets)");
      return { skipped: true };
    }
    const res = await fetch(`${this.baseUrl}/api/targets`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ targets, ts: Date.now() }),
    });
    if (!res.ok) throw new Error(`push failed: HTTP ${res.status} ${await res.text()}`);
    return res.json().catch(() => ({}));
  }

  async ping() {
    const res = await fetch(`${this.baseUrl}/api/health`, { headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }
}
