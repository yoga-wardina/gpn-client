/** GPN VPS API client — user auth + authenticated requests + game-target pushes. */
import { isSecureOrLocalUrl, normalizeServerUrl } from "./net.ts";

export interface AuthSession {
  username: string;
  role: string;
  status?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const TIMEOUT_MS = 10_000;
const SESSION_TTL_MS = 23 * 3600_000; // refresh 1h before the server's 24h expiry

export class GpnApi {
  /** WireGuard public key of this client (set after tunnel registration) */
  peerKey: string | null = null;
  /** current user session (null = logged out / machine mode) */
  session: AuthSession | null = null;
  /** called when the session changes so the caller can persist it */
  onSessionUpdate: ((s: AuthSession | null) => void) | null = null;

  private baseUrl: string;
  private refreshing: Promise<boolean> | null = null;

  constructor(
    baseUrl: string,
    private token: string
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    if (!isSecureOrLocalUrl(this.baseUrl)) {
      console.warn(`[gpn] WARNING: ${this.baseUrl} is not https — credentials will cross the network in clear text`);
    }
  }

  get serverUrl() {
    return this.baseUrl;
  }
  setServer(url: string) {
    this.baseUrl = normalizeServerUrl(url);
  }
  setToken(t: string) {
    this.token = t;
  }
  setSession(s: AuthSession | null) {
    this.session = s;
  }

  /**
   * Authenticated request. Uses the user session when logged in (refreshing it when
   * expired or on a 401, single-flight), else the machine token. Does not throw on
   * HTTP errors — only on network failure/timeouts.
   */
  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const send = async () => {
      if (this.session && Date.now() >= this.session.expiresAt) await this.refresh();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.session) headers.authorization = `Bearer ${this.session.accessToken}`;
      else if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (this.peerKey) headers["x-gpn-peer"] = this.peerKey;
      return fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    };
    let res = await send();
    if (res.status === 401 && this.session && (await this.refresh())) res = await send();
    return res;
  }

  register(username: string, password: string, inviteCode?: string) {
    return this.authFlow("/api/auth/register", { username, password, ...(inviteCode ? { inviteCode } : {}) });
  }

  login(username: string, password: string) {
    return this.authFlow("/api/auth/login", { username, password });
  }

  private async authFlow(path: string, body: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      this.session = {
        username: data.user.username,
        role: data.user.role,
        status: data.user.status,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      this.onSessionUpdate?.(this.session);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `cannot reach server: ${e instanceof Error ? e.message : e}` };
    }
  }

  async logout(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.onSessionUpdate?.(null);
    if (s) {
      await fetch(`${this.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.accessToken}` },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {});
    }
  }

  /** Single-flight: refresh tokens are one-time, so concurrent refreshes must share one call. */
  refresh(): Promise<boolean> {
    return (this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    }));
  }

  private async doRefresh(): Promise<boolean> {
    const s = this.session;
    if (!s) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        // definitively rejected -> logged out. Transient errors (5xx, 429, network) keep the session.
        if (this.session === s) {
          this.session = null;
          this.onSessionUpdate?.(null);
        }
        return false;
      }
      if (!res.ok) return false;
      const data: any = await res.json();
      if (this.session !== s) return false; // logged out / replaced meanwhile
      this.session = {
        ...s,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      this.onSessionUpdate?.(this.session);
      return true;
    } catch {
      return false;
    }
  }

  /** Push the current set of public game IPs for this client's peer. */
  async pushTargets(ips: string[]) {
    if (!this.peerKey) {
      console.log("[gpn] skipping push (not registered yet — tunnel will sync targets)");
      return { skipped: true };
    }
    const res = await this.request("/api/targets", {
      method: "POST",
      body: { targets: ips.map((ip) => ({ ip })), ts: Date.now() },
    });
    if (!res.ok) throw new Error(`push failed: HTTP ${res.status} ${await errorMessage(res)}`);
    return res.json().catch(() => ({}));
  }

  async ping() {
    const res = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }
}

/** Best-effort extraction of the server's `{error}` message from a failed response. */
export async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text.slice(0, 200);
  }
}
