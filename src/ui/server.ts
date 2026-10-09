/**
 * Local UI server — ExitLag-style dashboard, served at http://localhost:<uiPort>.
 * Dark theme, game cards, live target feed. Vanilla HTML/CSS/JS, no build step.
 */
import type { GameWatcher } from "../watcher.ts";
import type { GpnApi } from "../api.ts";
import type { Config } from "../config.ts";
import { saveConfig } from "../config.ts";

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
        saveConfig({ games: config.games.filter((g) => g !== exe) });
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
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
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

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GPN Client</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #121722; --panel2: #171d2b; --border: #232b3d;
    --accent: #22d3ee; --accent2: #6366f1; --text: #e5e9f0; --dim: #8b95a8;
    --green: #34d399; --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: "Segoe UI", system-ui, sans-serif; min-height: 100vh;
  }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 24px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .logo { font-weight: 800; font-size: 18px; letter-spacing: 1px; }
  .logo span { color: var(--accent); }
  .status-pill {
    margin-left: auto; display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--dim);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot.off { background: var(--red); box-shadow: 0 0 8px var(--red); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--dim); margin: 24px 0 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 14px;
  }
  .card .icon {
    width: 42px; height: 42px; border-radius: 10px; flex: none;
    background: linear-gradient(135deg, var(--accent2), var(--accent));
    display: grid; place-items: center; font-weight: 800; font-size: 18px; color: #fff;
  }
  .card .name { font-weight: 600; }
  .card .sub { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .card button, .btn {
    margin-left: auto; background: var(--panel2); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px;
    cursor: pointer; font-size: 13px;
  }
  .card button:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: linear-gradient(135deg, var(--accent2), var(--accent)); color: #fff; border: none; font-weight: 600; }
  .add-row { display: flex; gap: 8px; }
  .add-row input {
    flex: 1; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); padding: 10px 12px; font-size: 14px; outline: none;
  }
  .add-row input:focus { border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
  td.mono, .mono { font-family: Consolas, monospace; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
  .tag.udp { background: rgba(99,102,241,.15); color: var(--accent2); }
  .tag.tcp { background: rgba(34,211,238,.12); color: var(--accent); }
  .settings input {
    width: 100%; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); padding: 10px 12px; font-size: 14px; outline: none; margin-bottom: 10px;
  }
  .row { display: flex; gap: 8px; }
  .empty { color: var(--dim); font-size: 13px; padding: 18px; text-align: center; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo">GPN<span>CLIENT</span></div>
    <div class="status-pill"><div class="dot" id="dot"></div><span id="statusText">connecting…</span></div>
  </div>
  <div class="wrap">
    <h2>Watched Games</h2>
    <div class="add-row">
      <input id="exeInput" placeholder="Game executable name or path (e.g. valorant.exe)">
      <button class="btn primary" onclick="addGame()">Watch</button>
    </div>
    <div id="games" style="margin-top:12px"></div>

    <h2>Live Server Targets</h2>
    <table>
      <thead><tr><th>Protocol</th><th>IP</th><th>Port</th><th>First seen</th></tr></thead>
      <tbody id="targets"><tr><td colspan="4" class="empty">No game traffic detected yet.</td></tr></tbody>
    </table>

    <h2>Settings</h2>
    <div class="card settings" style="display:block">
      <input id="serverUrl" placeholder="GPN server URL (e.g. https://gpn.example.com)">
      <input id="token" placeholder="Auth token" type="password">
      <div class="row">
        <button class="btn primary" onclick="saveSettings()">Save</button>
        <button class="btn" onclick="pingServer()">Test connection</button>
        <span id="pingResult" style="align-self:center;font-size:13px"></span>
      </div>
    </div>
  </div>
<script>
  async function refresh() {
    try {
      const s = await (await fetch('/api/state')).json();
      document.getElementById('dot').classList.toggle('off', !s.running);
      document.getElementById('statusText').textContent = s.running ? 'monitoring' : 'stopped';
      document.getElementById('serverUrl').value = s.gpnServerUrl || '';

      const games = document.getElementById('games');
      games.innerHTML = s.watched.length ? '' : '<div class="empty">No games watched. Add an executable above.</div>';
      for (const exe of s.watched) {
        const live = s.procs.some(p => p.name.toLowerCase().includes(exe));
        games.insertAdjacentHTML('beforeend', \\\`
          <div class="card">
            <div class="icon">\\\${exe.charAt(0).toUpperCase()}</div>
            <div>
              <div class="name">\\\${exe}</div>
              <div class="sub">\\\${live ? '<span style="color:var(--green)">● running</span>' : 'not running'}</div>
            </div>
            <button onclick="unwatch('\\\${exe}')">Remove</button>
          </div>\\\`);
      }

      const tb = document.getElementById('targets');
      if (!s.targets.length) {
        tb.innerHTML = '<tr><td colspan="4" class="empty">No game traffic detected yet.</td></tr>';
      } else {
        tb.innerHTML = s.targets.map(t => \\\`
          <tr>
            <td><span class="tag \\\${t.proto}">\\\${t.proto.toUpperCase()}</span></td>
            <td class="mono">\\\${t.ip}</td>
            <td class="mono">\\\${t.port ?? '—'}</td>
            <td class="mono">\\\${new Date(t.firstSeen).toLocaleTimeString()}</td>
          </tr>\\\`).join('');
      }
    } catch (e) {
      document.getElementById('dot').classList.add('off');
      document.getElementById('statusText').textContent = 'ui error';
    }
  }
  async function addGame() {
    const exe = document.getElementById('exeInput').value.trim();
    if (!exe) return;
    await fetch('/api/watch', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ exe }) });
    document.getElementById('exeInput').value = '';
    refresh();
  }
  async function unwatch(exe) {
    await fetch('/api/unwatch', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ exe }) });
    refresh();
  }
  async function saveSettings() {
    await fetch('/api/settings', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({
      gpnServerUrl: document.getElementById('serverUrl').value.trim(),
      gpnToken: document.getElementById('token').value.trim(),
    })});
    document.getElementById('pingResult').textContent = 'saved';
  }
  async function pingServer() {
    const el = document.getElementById('pingResult');
    el.textContent = 'testing…';
    const r = await (await fetch('/api/ping', { method: 'POST' })).json();
    el.textContent = r.ok ? '✓ server reachable' : '✗ ' + (r.error || 'unreachable');
    el.style.color = r.ok ? 'var(--green)' : 'var(--red)';
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
