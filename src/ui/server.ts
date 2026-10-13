/**
 * Local UI server — ExitLag-style dashboard, served at http://localhost:<uiPort>.
 * HTML lives in src/ui/index.html (imported as text so it works compiled).
 */
import type { GameWatcher } from "../watcher.ts";
import type { GpnApi } from "../api.ts";
import type { Config } from "../config.ts";
import { saveConfig } from "../config.ts";
import { getCachedMeta, resolveMeta } from "../meta.ts";
import type { TunnelManager } from "../tunnel.ts";
import { currentSample, startSampling } from "../traffic.ts";

import HTML from "./index.html" with { type: "text" };

interface UiDeps {
  watcher: GameWatcher;
  api: GpnApi;
  config: Config;
  tunnel: TunnelManager;
}

export function startUi(port: number, deps: UiDeps) {
  const { watcher, api, config, tunnel } = deps;
  watcher.start();
  startSampling(1000);

  // restore persisted session into the api client
  if (config.auth) api.setSession(config.auth);
  api.onSessionUpdate = (s) => {
    saveConfig({ auth: s ?? undefined });
  };

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // ===== auth proxy endpoints =====
      if (url.pathname === "/api/auth/session") {
        return json({
          loggedIn: !!config.auth,
          user: config.auth ? { username: config.auth.username, role: config.auth.role } : null,
        });
      }

      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const { username, password } = await req.json();
        const r = await api.login(String(username ?? ""), String(password ?? ""));
        if (r.ok && api.session) {
          saveConfig({ auth: api.session });
          return json({ ok: true, user: { username: api.session.username, role: api.session.role } });
        }
        return json({ ok: false, error: r.error }, 401);
      }

      if (url.pathname === "/api/auth/register" && req.method === "POST") {
        const { username, password } = await req.json();
        const r = await api.register(String(username ?? ""), String(password ?? ""));
        if (r.ok && api.session) {
          saveConfig({ auth: api.session });
          return json({ ok: true, user: { username: api.session.username, role: api.session.role } });
        }
        return json({ ok: false, error: r.error }, 400);
      }

      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        await api.logout();
        saveConfig({ auth: undefined });
        return json({ ok: true });
      }

      if (url.pathname === "/api/state") {
        return json({
          procs: watcher.listProcs(),
          targets: watcher.listTargets(),
          watched: watcher.listWatched(),
          meta: Object.fromEntries(watcher.listWatched().map((exe) => [exe, getCachedMeta(exe) ?? null])),
          gpnServerUrl: config.gpnServerUrl,
          user: config.auth ? { username: config.auth.username, role: config.auth.role } : null,
          running: true,
        });
      }

      if (url.pathname === "/api/meta" && req.method === "POST") {
        const { exe } = await req.json();
        if (!exe) return json({ error: "exe required" }, 400);
        const meta = await resolveMeta(exe);
        return json({ ok: true, exe, meta });
      }

      if (url.pathname === "/api/watch" && req.method === "POST") {
        const { exe } = await req.json();
        if (!exe) return json({ error: "exe required" }, 400);
        watcher.watchExecutable(exe);
        const games = [...new Set([...config.games, exe])];
        saveConfig({ games });
        resolveMeta(exe).catch(() => {}); // fire-and-forget icon/name resolution
        return json({ ok: true, watched: watcher.listWatched() });
      }

      if (url.pathname === "/api/unwatch" && req.method === "POST") {
        const { exe } = await req.json();
        watcher.unwatchExecutable(exe);
        saveConfig({ games: config.games.filter((g: string) => g !== exe) });
        return json({ ok: true, watched: watcher.listWatched() });
      }

      if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = await req.json();
        const partial: Partial<Config> = {};
        if (typeof body.gpnServerUrl === "string") partial.gpnServerUrl = body.gpnServerUrl;
        if (typeof body.gpnToken === "string") {
          partial.gpnToken = body.gpnToken;
          api.setToken(body.gpnToken);
        }
        saveConfig(partial);
        if (partial.gpnServerUrl) api.setServer(partial.gpnServerUrl);
        return json({ ok: true });
      }

      if (url.pathname === "/api/tunnel/state") {
        return json({ ok: true, state: tunnel.state });
      }

      if (url.pathname === "/api/tunnel/register" && req.method === "POST") {
        try {
          await tunnel.register(config.gpnServerUrl, config.gpnToken);
          return json({ ok: true, state: tunnel.state });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 502);
        }
      }

      if (url.pathname === "/api/tunnel/teardown" && req.method === "POST") {
        await tunnel.teardown();
        return json({ ok: true, state: tunnel.state });
      }

      if (url.pathname === "/api/traffic") {
        return json(currentSample());
      }

      // WebSocket: live traffic + state stream (1s)
      if (url.pathname === "/ws") {
        const success = server.upgrade(req, { data: {} as never });
        if (!success) return new Response("upgrade failed", { status: 400 });
        return undefined as unknown as Response;
      }

      if (url.pathname === "/api/ping" && req.method === "POST") {
        try {
          return json({ ok: true, result: await api.ping() });
        } catch (e) {
          return json({ ok: false, error: String(e) }, 502);
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML as unknown as string, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        // per-socket push loop: full state snapshot whenever it changes,
        // traffic rates every 1s, heartbeat every 5s
        let stop = false;
        (ws.data as unknown as { _stop?: () => void })._stop = () => {
          stop = true;
        };

        const snapshot = () => ({
          procs: watcher.listProcs(),
          targets: watcher.listTargets(),
          watched: watcher.listWatched(),
          meta: Object.fromEntries(watcher.listWatched().map((exe) => [exe, getCachedMeta(exe) ?? null])),
          gpnServerUrl: config.gpnServerUrl,
          user: config.auth ? { username: config.auth.username, role: config.auth.role } : null,
          tunnel: tunnel.state,
          running: true,
        });
        const snapKey = (s: ReturnType<typeof snapshot>) =>
          JSON.stringify([s.procs, s.targets, s.watched, s.user, s.tunnel, s.gpnServerUrl]);
        let lastSnap = "";

        (async () => {
          while (!stop) {
            // 1) traffic rates (every 1s)
            const s = currentSample();
            try {
              ws.send(JSON.stringify({
                type: "traffic",
                rxPerSec: Math.round(s.rxPerSec),
                txPerSec: Math.round(s.txPerSec),
                rxBytes: s.rxBytes,
                txBytes: s.txBytes,
                ts: s.ts,
              }));
            } catch {}

            // 2) full state only when changed
            const snap = snapshot();
            const key = snapKey(snap);
            if (key !== lastSnap) {
              lastSnap = key;
              try {
                ws.send(JSON.stringify({ type: "state", state: snap }));
              } catch {}
            }

            await new Promise((r) => setTimeout(r, 1000));
          }
        })();
      },
      message() {},
      close(ws) {
        (ws.data as unknown as { _stop?: () => void })._stop?.();
      },
    },
  });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
