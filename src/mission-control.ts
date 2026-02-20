#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawnSync } from 'child_process';
import { URL } from 'url';
import {
    CHATS_DIR,
    EVENTS_DIR,
    QUEUE_INCOMING,
    QUEUE_OUTGOING,
    QUEUE_PROCESSING,
    TINYCLAW_HOME,
    getAgents,
    getSettings,
    getTeams,
} from './lib/config';

type EventRecord = {
    type?: string;
    timestamp?: number;
    [key: string]: unknown;
};

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function queueDepth(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

function isQueueProcessorAlive(): boolean {
    const out = spawnSync('pgrep', ['-f', 'dist/queue-processor.js'], { stdio: 'pipe' });
    return out.status === 0;
}

function readRecentEvents(limit: number): EventRecord[] {
    if (!fs.existsSync(EVENTS_DIR)) return [];
    const files = fs
        .readdirSync(EVENTS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(EVENTS_DIR, f))
        .map((full) => ({ full, mtime: fs.statSync(full).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit);
    const events: EventRecord[] = [];
    for (const file of files) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file.full, 'utf8')) as EventRecord;
            events.push(parsed);
        } catch {
            // Skip malformed events
        }
    }
    return events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function readRecentConversations(limit: number): Array<Record<string, unknown>> {
    if (!fs.existsSync(CHATS_DIR)) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const teamId of fs.readdirSync(CHATS_DIR)) {
        const teamDir = path.join(CHATS_DIR, teamId);
        if (!fs.statSync(teamDir).isDirectory()) continue;
        const files = fs.readdirSync(teamDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
            const full = path.join(teamDir, file);
            const stat = fs.statSync(full);
            rows.push({
                teamId,
                file,
                path: full,
                timestamp: stat.mtimeMs,
            });
        }
    }
    return rows.sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).slice(0, limit);
}

function statusPayload(): Record<string, unknown> {
    const settings = getSettings();
    return {
        ok: true,
        tinyclawHome: TINYCLAW_HOME,
        processorAlive: isQueueProcessorAlive(),
        queue: {
            incoming: queueDepth(QUEUE_INCOMING),
            processing: queueDepth(QUEUE_PROCESSING),
            outgoing: queueDepth(QUEUE_OUTGOING),
        },
        agents: Object.keys(getAgents(settings)),
        teams: Object.keys(getTeams(settings)),
        timestamp: Date.now(),
    };
}

function writeJson(res: http.ServerResponse, code: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function indexHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TinyClaw Mission Control</title>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #111a2b;
      --muted: #8fa2c0;
      --text: #e6edf8;
      --line: #22314c;
      --ok: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --blue: #4f8cff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
    .app { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
    .sidebar { border-right: 1px solid var(--line); background: #0f1728; padding: 20px; position: sticky; top: 0; height: 100vh; }
    .title { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; }
    .ok { background: rgba(34,197,94,.18); color: #90f6b3; }
    .bad { background: rgba(239,68,68,.18); color: #ffaaaa; }
    .main { padding: 24px; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
    .k { color: var(--muted); font-size: 12px; }
    .v { font-size: 22px; font-weight: 700; }
    .section { margin-top: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    .section h3 { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 14px; }
    .table { max-height: 65vh; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { position: sticky; top: 0; background: #12203a; z-index: 1; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-word; }
    .muted { color: var(--muted); }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      .cards { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="title">Mission Control</div>
      <div class="sub">Queue + Traceability</div>
      <div id="processorBadge" class="badge bad">processor: down</div>
      <div class="sub" style="margin-top:14px">Live stream via SSE</div>
    </aside>
    <main class="main">
      <section class="cards">
        <div class="card"><div class="k">Incoming</div><div id="incoming" class="v">0</div></div>
        <div class="card"><div class="k">Processing</div><div id="processing" class="v">0</div></div>
        <div class="card"><div class="k">Outgoing</div><div id="outgoing" class="v">0</div></div>
        <div class="card"><div class="k">Total Events</div><div id="eventCount" class="v">0</div></div>
      </section>
      <section class="section">
        <h3>Recent Team/Event Trace</h3>
        <div class="table">
          <table>
            <thead>
              <tr><th>Time</th><th>Type</th><th>Flow</th><th>Details</th></tr>
            </thead>
            <tbody id="eventsBody"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
  <script>
    const eventsBody = document.getElementById('eventsBody');
    const incomingEl = document.getElementById('incoming');
    const processingEl = document.getElementById('processing');
    const outgoingEl = document.getElementById('outgoing');
    const eventCountEl = document.getElementById('eventCount');
    const processorBadge = document.getElementById('processorBadge');
    let events = [];

    function fmtTime(ts) {
      if (!ts) return '-';
      return new Date(ts).toLocaleTimeString();
    }
    function flowOf(ev) {
      if (ev.fromAgent || ev.toAgent) return '@' + (ev.fromAgent || '?') + ' → @' + (ev.toAgent || ev.agentId || '?');
      if (ev.agentId) return '@' + ev.agentId;
      return '-';
    }
    function detailOf(ev) {
      return ev.message || ev.responseText || ev.teamName || ev.channel || '';
    }
    function renderEvents() {
      const rows = events.slice(-200).map((ev) => {
        return '<tr>'
          + '<td class="mono">' + fmtTime(ev.timestamp) + '</td>'
          + '<td class="mono">' + (ev.type || '-') + '</td>'
          + '<td class="mono">' + flowOf(ev) + '</td>'
          + '<td class="mono muted">' + String(detailOf(ev)).slice(0, 180) + '</td>'
          + '</tr>';
      }).join('');
      eventsBody.innerHTML = rows || '<tr><td colspan="4" class="muted">No events yet</td></tr>';
      eventCountEl.textContent = String(events.length);
    }
    function applyStatus(status) {
      incomingEl.textContent = String(status.queue.incoming || 0);
      processingEl.textContent = String(status.queue.processing || 0);
      outgoingEl.textContent = String(status.queue.outgoing || 0);
      processorBadge.textContent = status.processorAlive ? 'processor: up' : 'processor: down';
      processorBadge.className = 'badge ' + (status.processorAlive ? 'ok' : 'bad');
    }

    async function bootstrap() {
      const [statusRes, eventsRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/events?limit=200')
      ]);
      const status = await statusRes.json();
      const ev = await eventsRes.json();
      applyStatus(status);
      events = ev.events || [];
      renderEvents();
    }

    const es = new EventSource('/api/stream');
    es.addEventListener('status', (e) => {
      const payload = JSON.parse(e.data);
      applyStatus(payload);
    });
    es.addEventListener('event', (e) => {
      const payload = JSON.parse(e.data);
      events.push(payload);
      if (events.length > 2000) events = events.slice(-1000);
      renderEvents();
    });

    bootstrap().catch((err) => {
      console.error(err);
    });
  </script>
</body>
</html>`;
}

function startServer(port: number): void {
    ensureDir(EVENTS_DIR);
    ensureDir(QUEUE_INCOMING);
    ensureDir(QUEUE_PROCESSING);
    ensureDir(QUEUE_OUTGOING);

    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

        if (reqUrl.pathname === '/health') {
            return writeJson(res, 200, { ok: true, timestamp: Date.now() });
        }
        if (reqUrl.pathname === '/api/status') {
            return writeJson(res, 200, statusPayload());
        }
        if (reqUrl.pathname === '/api/events') {
            const limit = Math.max(1, Math.min(1000, Number(reqUrl.searchParams.get('limit') || '200')));
            return writeJson(res, 200, { events: readRecentEvents(limit) });
        }
        if (reqUrl.pathname === '/api/conversations') {
            const limit = Math.max(1, Math.min(500, Number(reqUrl.searchParams.get('limit') || '50')));
            return writeJson(res, 200, { conversations: readRecentConversations(limit) });
        }
        if (reqUrl.pathname === '/api/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
            });
            let lastSeen = 0;
            const send = (eventName: string, payload: unknown) => {
                res.write(`event: ${eventName}\n`);
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            const tick = setInterval(() => {
                send('status', statusPayload());
                const recent = readRecentEvents(100);
                for (const ev of recent) {
                    if ((ev.timestamp || 0) <= lastSeen) continue;
                    lastSeen = Math.max(lastSeen, ev.timestamp || 0);
                    send('event', ev);
                }
            }, 2000);
            req.on('close', () => clearInterval(tick));
            return;
        }
        if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
            const html = indexHtml();
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(html),
            });
            return res.end(html);
        }
        writeJson(res, 404, { error: 'not_found' });
    });

    server.listen(port, '0.0.0.0', () => {
        process.stdout.write(`Mission Control listening on http://0.0.0.0:${port}\n`);
        process.stdout.write('GET /api/status, /api/events, /api/conversations, /api/stream, /health\n');
    });
}

function parsePort(): number {
    const idx = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
    if (idx >= 0 && process.argv[idx + 1]) {
        const p = Number(process.argv[idx + 1]);
        if (Number.isFinite(p) && p > 0 && p < 65536) return p;
    }
    return 4317;
}

startServer(parsePort());

