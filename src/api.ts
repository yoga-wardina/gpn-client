/** GPN VPS API client — pushes detected game targets to the server. */
import type { Target } from "./watcher.ts";

export class GpnApi {
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
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
  }

  async pushTargets(targets: Target[]) {
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
