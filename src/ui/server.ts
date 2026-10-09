/**
 * Local UI server — ExitLag-style dashboard, served at http://localhost:<uiPort>.
 * HTML lives in src/ui/index.html (imported as text so it works compiled).
 */
import type { GameWatcher } from "../watcher.ts";
import type { GpnApi } from "../api.ts";
import type { Config } from "../config.ts";
import { saveConfig } from "../config.ts";

import HTML from "./index.html" with { type: "text" };

interface UiDeps {
  watcher: GameWatcher;
  api: GpnApi;
  config: Config;
}

export function startUi(port: number, deps: UiDeps) {
  const { watcher, api, config } = deps;
  watcher.start();

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        return json({
          procs: watcher.listProcs(),
          targets: watcher.listTargets(),
          watched: watcher.listWatched(),
          gpnServerUrl: config.gpnServerUrl,
          running: true,
        });
      }

      if (url.pathname === "/api/watch" && req.method === "POST") {
        const { exe } = await req.json();
        if (!exe) return json({ error: "exe required" }, 400);
        watcher.watchExecutable(exe);
        const games = [...new Set([...config.games, exe])];
        saveConfig({ games });
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
  });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
