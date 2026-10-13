/** GPN VPS API client — user auth + pushes detected game targets. */
import type { Target } from "./watcher.ts";

export interface AuthSession {
  username: string;
  role: string;
  status?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class GpnApi {
  /** WireGuard public key of this client (set after tunnel registration) */
  peerKey: string | null = null;
  /** current user session (null = logged out / machine mode) */
  session: AuthSession | null = null;
  /** called when tokens rotate so the caller can persist them */
  onSessionUpdate: ((s: AuthSession | null) => void) | null = null;

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
  setSession(s: AuthSession | null) {
    this.session = s;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.session) {
      if (Date.now() >= this.session.expiresAt) {
        await this.refresh(); // best effort
      }
      if (this.session) h.authorization = `Bearer ${this.session.accessToken}`;
      else h.authorization = `Bearer ${this.token}`;
    } else {
      h.authorization = `Bearer ${this.token}`;
    }
    if (this.peerKey) h["x-gpn-peer"] = this.peerKey;
    return h;
  }

  async register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    return this.authFlow("/api/auth/register", username, password);
  }

  async login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    return this.authFlow("/api/auth/login", username, password);
  }

  private async authFlow(path: string, username: string, password: string) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    this.session = {
      username: data.user.username,
      role: data.user.role,
      status: data.user.status,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + 23 * 3600_000, // refresh 1h before real expiry
    };
    this.onSessionUpdate?.(this.session);
    return { ok: true };
  }

  async logout(): Promise<void> {
    if (this.session) {
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      }).catch(() => {});
    }
    this.session = null;
    this.onSessionUpdate?.(null);
  }

  async refresh(): Promise<boolean> {
    if (!this.session) return false;
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      if (!res.ok) {
        this.session = null;
        this.onSessionUpdate?.(null);
        return false;
      }
      const data = await res.json();
      this.session = {
        ...this.session,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + 23 * 3600_000,
      };
      this.onSessionUpdate?.(this.session);
      return true;
    } catch {
      return false;
    }
  }

  async pushTargets(targets: Target[]) {
    if (!this.peerKey) {
      console.log("[gpn] skipping push (not registered yet — tunnel will sync targets)");
      return { skipped: true };
    }
    const res = await fetch(`${this.baseUrl}/api/targets`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ targets, ts: Date.now() }),
    });
    if (!res.ok) throw new Error(`push failed: HTTP ${res.status} ${await res.text()}`);
    return res.json().catch(() => ({}));
  }

  async ping() {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }
}
