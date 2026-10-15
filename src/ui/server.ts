/**
 * Local UI server — ExitLag-style dashboard, served at http://localhost:<uiPort>.
 * HTML lives in src/ui/index.html (imported as text so it works compiled).
 *
 * Hardened against browser-based attacks on the local port: bound to loopback only,
 * Host must be localhost/127.0.0.1 (DNS rebinding), and state-changing requests /
 * WebSocket upgrades must not carry a foreign Origin (CSRF).
 */
import type { GameWatcher } from "../watcher.ts";
import type { GpnApi } from "../api.ts";
import type { Config } from "../config.ts";
import { saveConfig } from "../config.ts";
import { getCachedMeta, resolveMeta } from "../meta.ts";
import type { TunnelManager } from "../tunnel.ts";
import { currentSample } from "../traffic.ts";
import { baseName, isSecureOrLocalUrl, normalizeServerUrl } from "../net.ts";

import HTML from "./index.html" with { type: "text" };

interface UiDeps {
  watcher: GameWatcher;
  api: GpnApi;
  config: Config;
  tunnel: TunnelManager;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function startUi(port: number, deps: UiDeps) {
  const { watcher, api, config, tunnel } = deps;
  watcher.start();

  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  const origins = hosts.map((h) => `http://${h}`);

  function guard(req: Request, pathname: string) {
    if (!hosts.includes(req.headers.get("host") ?? "")) throw new HttpError(403, "forbidden host");
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    const origin = req.headers.get("origin");
    // browsers always send Origin on cross-origin POSTs and WebSocket handshakes
    if ((mutating || pathname === "/ws") && origin && !origins.includes(origin)) throw new HttpError(403, "forbidden origin");
  }

  async function readJson(req: Request): Promise<Record<string, any>> {
    try {
      const body = await req.json();
      if (body && typeof body === "object" && !Array.isArray(body)) return body;
    } catch {}
    throw new HttpError(400, "invalid JSON body");
  }

  const user = () => (config.auth ? { username: config.auth.username, role: config.auth.role } : null);

  /** Exe entries: a plain file name or path, no control chars, bounded length. */
  function exeArg(v: unknown): string {
    if (typeof v !== "string" || !v.trim() || v.length > 260 || /[\x00-\x1f]/.test(v)) throw new HttpError(400, "invalid exe");
    return v.trim();
  }

  async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    guard(req, path);

    // ===== auth proxy endpoints =====
    if (path === "/api/auth/session") return json({ loggedIn: !!config.auth, user: user() });

    if ((path === "/api/auth/login" || path === "/api/auth/register") && req.method === "POST") {
      const body = await readJson(req);
      const username = String(body.username ?? "");
      const password = String(body.password ?? "");
      const r =
        path === "/api/auth/login"
          ? await api.login(username, password)
          : await api.register(username, password, typeof body.inviteCode === "string" ? body.inviteCode : undefined);
      // session persistence happens via api.onSessionUpdate
      if (r.ok && api.session) return json({ ok: true, user: { username: api.session.username, role: api.session.role } });
      return json({ ok: false, error: r.error }, path === "/api/auth/login" ? 401 : 400);
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      await api.logout();
      return json({ ok: true });
    }

    if (path === "/api/state") {
      return json({
        procs: watcher.listProcs(),
        targets: watcher.listTargets(),
        watched: watcher.listWatched(),
        meta: Object.fromEntries(watcher.listWatched().map((exe) => [exe, getCachedMeta(exe) ?? null])),
        gpnServerUrl: config.gpnServerUrl,
        user: user(),
        running: true,
      });
    }

    if (path === "/api/meta" && req.method === "POST") {
      const exe = exeArg((await readJson(req)).exe);
      return json({ ok: true, exe, meta: await resolveMeta(exe) });
    }

    if (path === "/api/watch" && req.method === "POST") {
      const exe = exeArg((await readJson(req)).exe);
      watcher.watchExecutable(exe);
      saveConfig({ games: [...new Set([...config.games, exe])] });
      resolveMeta(exe).catch(() => {}); // fire-and-forget icon/name resolution
      return json({ ok: true, watched: watcher.listWatched() });
    }

    if (path === "/api/unwatch" && req.method === "POST") {
      const exe = exeArg((await readJson(req)).exe);
      watcher.unwatchExecutable(exe);
      const key = baseName(exe).toLowerCase();
      saveConfig({ games: config.games.filter((g: string) => baseName(g).toLowerCase() !== key) });
      return json({ ok: true, watched: watcher.listWatched() });
    }

    if (path === "/api/settings" && req.method === "POST") {
      const body = await readJson(req);
      const partial: Partial<Config> = {};
      if (typeof body.gpnServerUrl === "string") {
        const u = normalizeServerUrl(body.gpnServerUrl);
        if (!isSecureOrLocalUrl(u)) return json({ ok: false, error: "server URL must be https:// (http only for localhost)" }, 400);
        if (u !== config.gpnServerUrl) {
          // never carry a session or peer identity over to a different server
          partial.gpnServerUrl = u;
          partial.auth = undefined;
          api.setServer(u);
          api.setSession(null);
          api.peerKey = null;
        }
      }
      if (typeof body.gpnToken === "string" && body.gpnToken.length <= 512) {
        partial.gpnToken = body.gpnToken;
        api.setToken(body.gpnToken);
      }
      saveConfig(partial);
      return json({ ok: true });
    }

    if (path === "/api/tunnel/state") return json({ ok: true, state: tunnel.state });

    if (path === "/api/tunnel/register" && req.method === "POST") {
      try {
        await tunnel.register();
        return json({ ok: true, state: tunnel.state });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
    }

    if (path === "/api/tunnel/teardown" && req.method === "POST") {
      await tunnel.teardown();
      return json({ ok: true, state: tunnel.state });
    }

    if (path === "/api/traffic") return json(currentSample());

    // WebSocket: live traffic + state stream (1s, one shared publisher)
    if (path === "/ws") {
      if (server.upgrade(req, { data: {} as never })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    if (path === "/api/ping" && req.method === "POST") {
      try {
        return json({ ok: true, result: await api.ping() });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
    }

    if (path === "/" || path === "/index.html") {
      return new Response(HTML as unknown as string, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "frame-ancestors 'none'",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  const snapshot = () => ({
    procs: watcher.listProcs(),
    targets: watcher.listTargets(),
    watched: watcher.listWatched(),
    meta: Object.fromEntries(watcher.listWatched().map((exe) => [exe, getCachedMeta(exe) ?? null])),
    gpnServerUrl: config.gpnServerUrl,
    user: user(),
    tunnel: tunnel.state,
    running: true,
  });
  const snapKey = (x: ReturnType<typeof snapshot>) => JSON.stringify([x.procs, x.targets, x.watched, x.user, x.tunnel, x.gpnServerUrl]);
  let lastSnap = "";

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    maxRequestBodySize: 64 * 1024,
    fetch: (req) =>
      handle(req).catch((e) => {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
        console.error("[ui] unhandled error:", e);
        return json({ ok: false, error: "internal error" }, 500);
      }) as Promise<Response>,
    websocket: {
      open(ws) {
        ws.subscribe("stats");
        // a new socket gets the full state immediately; later changes are published to everyone
        try {
          ws.send(JSON.stringify({ type: "state", state: snapshot() }));
        } catch {}
      },
      message() {},
      close(ws) {
        ws.unsubscribe("stats");
      },
    },
  });

  setInterval(() => {
    if (server.subscriberCount("stats") === 0) return;
    const s = currentSample();
    server.publish(
      "stats",
      JSON.stringify({
        type: "traffic",
        rxPerSec: Math.round(s.rxPerSec),
        txPerSec: Math.round(s.txPerSec),
        rxBytes: s.rxBytes,
        txBytes: s.txBytes,
        source: s.source,
        ts: s.ts,
        targets: watcher.listTargets().length,
        procs: watcher.listProcs().length,
      })
    );
    const snap = snapshot();
    const key = snapKey(snap);
    if (key !== lastSnap) {
      lastSnap = key;
      server.publish("stats", JSON.stringify({ type: "state", state: snap }));
    }
  }, 1000).unref();

  return server;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
