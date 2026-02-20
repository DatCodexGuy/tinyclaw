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

function readQueueSamples(limit: number): Record<string, unknown> {
    const readDir = (dir: string): Array<Record<string, unknown>> => {
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((name) => {
                const full = path.join(dir, name);
                const stat = fs.statSync(full);
                let parsed: Record<string, unknown> = {};
                try {
                    parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
                } catch {
                    parsed = {};
                }
                return {
                    file: name,
                    mtime: stat.mtimeMs,
                    channel: parsed.channel || null,
                    sender: parsed.sender || null,
                    messageId: parsed.messageId || null,
                    preview: typeof parsed.message === 'string' ? parsed.message.slice(0, 120) : null,
                };
            })
            .sort((a, b) => Number(b.mtime) - Number(a.mtime))
            .slice(0, limit);
    };

    return {
        incoming: readDir(QUEUE_INCOMING),
        processing: readDir(QUEUE_PROCESSING),
        outgoing: readDir(QUEUE_OUTGOING),
    };
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
      --bg-0: #060a14;
      --bg-1: #0e1627;
      --bg-2: #121d31;
      --panel: #101a2d;
      --panel-2: #0f1727;
      --line: #24324a;
      --text: #e8eef8;
      --muted: #96a9c7;
      --ok: #2dd489;
      --warn: #ffbd4a;
      --bad: #ff6b7a;
      --accent: #6aa8ff;
      --accent-2: #79f0ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Segoe UI", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
      background:
        radial-gradient(1000px 600px at -10% -20%, #1d355f 0%, transparent 50%),
        radial-gradient(900px 500px at 120% -10%, #223e63 0%, transparent 45%),
        linear-gradient(160deg, var(--bg-0), var(--bg-1) 42%, #0a1220);
    }
    .app {
      display: grid;
      grid-template-columns: 260px 1fr;
      min-height: 100vh;
      gap: 0;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 16px;
      border-right: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(12,20,35,.92), rgba(8,13,24,.9));
      backdrop-filter: blur(8px);
    }
    .logo { font-weight: 700; font-size: 19px; letter-spacing: .2px; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .nav { margin-top: 18px; display: grid; gap: 8px; }
    .nav-item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      background: rgba(11,18,33,.7);
      color: var(--text);
      font-size: 13px;
    }
    .nav-item strong { color: #fff; display: block; margin-bottom: 3px; font-size: 12px; }
    .badge {
      margin-top: 14px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 12px;
      font-weight: 600;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .ok .dot { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .bad .dot { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
    .main {
      padding: 16px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
      min-width: 0;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 6;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(11,18,31,.86);
      backdrop-filter: blur(8px);
    }
    .heading { font-size: 15px; font-weight: 650; }
    .muted { color: var(--muted); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-word;
    }
    .chips { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel-2);
      padding: 5px 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(6, minmax(110px, 1fr));
      gap: 10px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: linear-gradient(180deg, rgba(16,26,45,.96), rgba(12,20,34,.96));
      min-height: 72px;
    }
    .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .7px; }
    .v { font-size: 23px; font-weight: 720; margin-top: 4px; }
    .layout {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 12px;
      min-height: 0;
    }
    .col { display: grid; gap: 12px; min-height: 0; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(15,23,39,.92);
      min-height: 0;
      overflow: hidden;
    }
    .panel-h {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(15,26,42,.95);
    }
    .panel-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; }
    .panel-body { max-height: 33vh; overflow: auto; padding: 8px; }
    .event {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 8px;
      background: rgba(11,18,30,.75);
      cursor: pointer;
    }
    .event:hover { border-color: #3a5478; }
    .event.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px rgba(106,168,255,.4); }
    .event-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
    .type {
      border: 1px solid #324a70;
      background: rgba(47,88,141,.2);
      color: #b9d7ff;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
    }
    .type.handoff { border-color: #2f7f66; background: rgba(45,212,137,.14); color: #93f0c2; }
    .type.error { border-color: #7c3242; background: rgba(255,107,122,.16); color: #ffbac1; }
    .type.done { border-color: #2f6d7f; background: rgba(121,240,255,.13); color: #bdf7ff; }
    .flow { color: #b7c8e6; font-size: 12px; }
    .detail { font-size: 12px; color: var(--muted); line-height: 1.35; }
    .tiny { font-size: 11px; color: var(--muted); }
    .q-item, .conv-item {
      border-bottom: 1px solid rgba(36,50,74,.7);
      padding: 7px 2px;
    }
    .q-item:last-child, .conv-item:last-child { border-bottom: 0; }
    .label {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 1px 6px;
      font-size: 11px;
      margin-right: 6px;
      color: #bed1f2;
      background: rgba(31,46,72,.4);
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #cee1ff;
      font-size: 12px;
      line-height: 1.35;
      background: rgba(8,13,23,.9);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    input, select {
      background: #091324;
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
    }
    .filters { display: flex; gap: 8px; align-items: center; }
    .grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 1200px) {
      .cards { grid-template-columns: repeat(3, minmax(110px, 1fr)); }
      .layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .cards { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="logo">TinyClaw Mission</div>
      <div class="sub">Live orchestration control view</div>
      <div id="processorBadge" class="badge bad"><span class="dot"></span><span>Processor Offline</span></div>
      <div class="nav">
        <div class="nav-item"><strong>Overview</strong>Queue depth, health, agent/team count</div>
        <div class="nav-item"><strong>Trace Feed</strong>Realtime message routing and handoffs</div>
        <div class="nav-item"><strong>Inspector</strong>Raw JSON lives here only, for debugging</div>
        <div class="nav-item"><strong>Conversations</strong>Recent saved team chat artifacts</div>
      </div>
    </aside>
    <main class="main">
      <section class="topbar">
        <div>
          <div class="heading">Mission Control Dashboard</div>
          <div class="tiny">SSE live stream enabled</div>
        </div>
        <div class="chips">
          <span class="chip">Home: <span id="homePath" class="mono"></span></span>
          <span class="chip">Updated: <span id="lastUpdate" class="mono">-</span></span>
        </div>
      </section>
      <section class="cards">
        <div class="card"><div class="k">Incoming</div><div id="incoming" class="v">0</div></div>
        <div class="card"><div class="k">Processing</div><div id="processing" class="v">0</div></div>
        <div class="card"><div class="k">Outgoing</div><div id="outgoing" class="v">0</div></div>
        <div class="card"><div class="k">Agents</div><div id="agentCount" class="v">0</div></div>
        <div class="card"><div class="k">Teams</div><div id="teamCount" class="v">0</div></div>
        <div class="card"><div class="k">Total Events</div><div id="eventCount" class="v">0</div></div>
      </section>

      <section class="layout">
        <div class="col">
          <div class="panel">
            <div class="panel-h">
              <div class="panel-title">Realtime Trace Feed</div>
              <div class="filters">
                <select id="typeFilter">
                  <option value="all">all events</option>
                  <option value="chain_handoff">handoffs</option>
                  <option value="chain_step_start">step start</option>
                  <option value="chain_step_done">step done</option>
                  <option value="response_ready">response ready</option>
                </select>
                <input id="searchBox" placeholder="search flow/details" />
              </div>
            </div>
            <div id="eventsList" class="panel-body"></div>
          </div>
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Queue Snapshot</div><div class="tiny">Newest first</div></div>
            <div class="panel-body grid-two">
              <div><div class="tiny" style="margin-bottom:6px">Incoming</div><div id="qIncoming"></div></div>
              <div><div class="tiny" style="margin-bottom:6px">Processing</div><div id="qProcessing"></div></div>
            </div>
          </div>
        </div>

        <div class="col">
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Event Inspector</div><div class="tiny">Selected event JSON</div></div>
            <div class="panel-body"><pre id="eventInspector">{}</pre></div>
          </div>
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Recent Conversations</div><div class="tiny">Saved markdown transcripts</div></div>
            <div id="convList" class="panel-body"></div>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const eventsList = document.getElementById('eventsList');
    const eventInspector = document.getElementById('eventInspector');
    const incomingEl = document.getElementById('incoming');
    const processingEl = document.getElementById('processing');
    const outgoingEl = document.getElementById('outgoing');
    const agentCountEl = document.getElementById('agentCount');
    const teamCountEl = document.getElementById('teamCount');
    const eventCountEl = document.getElementById('eventCount');
    const processorBadge = document.getElementById('processorBadge');
    const homePathEl = document.getElementById('homePath');
    const lastUpdateEl = document.getElementById('lastUpdate');
    const typeFilterEl = document.getElementById('typeFilter');
    const searchBoxEl = document.getElementById('searchBox');
    const qIncomingEl = document.getElementById('qIncoming');
    const qProcessingEl = document.getElementById('qProcessing');
    const convListEl = document.getElementById('convList');
    let events = [];
    let selectedEventId = null;

    function fmtTime(ts) {
      if (!ts) return '-';
      const d = new Date(ts);
      return d.toLocaleTimeString();
    }
    function flowOf(ev) {
      if (ev.fromAgent || ev.toAgent) return '@' + (ev.fromAgent || '?') + ' → @' + (ev.toAgent || ev.agentId || '?');
      if (ev.agentId) return '@' + ev.agentId;
      return '-';
    }
    function titleCase(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
    }
    function shortText(value, limit = 180) {
      const raw = String(value || '').replace(/\s+/g, ' ').trim();
      if (!raw) return '';
      if (raw.length <= limit) return raw;
      return raw.slice(0, limit - 1) + '…';
    }
    function eventTypeClass(ev) {
      if (ev.type === 'chain_handoff') return 'handoff';
      if (ev.type === 'response_ready' || ev.type === 'team_chain_end') return 'done';
      if (String(ev.type || '').includes('error')) return 'error';
      return '';
    }
    function humanSummary(ev) {
      switch (ev.type) {
        case 'processor_start':
          return 'Queue processor started and loaded current agents and teams.';
        case 'message_received':
          return 'Incoming message received from ' + (ev.sender || 'unknown sender') + ' on ' + titleCase(ev.channel || 'unknown channel') + '.';
        case 'agent_routed':
          return 'Routed to @' + (ev.agentId || '?') + ' using ' + titleCase(ev.provider || 'provider') + ' (' + (ev.model || 'default model') + ').';
        case 'team_chain_start':
          return 'Team conversation started for ' + (ev.teamName || ev.teamId || 'team') + '.';
        case 'chain_step_start':
          return '@' + (ev.agentId || '?') + ' started working on this step.';
        case 'chain_handoff':
          return '@' + (ev.fromAgent || '?') + ' delegated to @' + (ev.toAgent || '?') + '.';
        case 'chain_step_done':
          return '@' + (ev.agentId || '?') + ' completed a step (' + (ev.responseLength || 0) + ' chars response).';
        case 'response_ready':
          return 'Final response prepared for ' + titleCase(ev.channel || 'channel') + ' sender ' + (ev.sender || 'unknown') + '.';
        case 'team_chain_end':
          return 'Team conversation completed with ' + (ev.totalSteps || 0) + ' total steps.';
        default:
          return shortText(ev.message || ev.responseText || ev.teamName || ev.channel || 'Event captured.');
      }
    }
    function eventSubtitle(ev) {
      const flow = flowOf(ev);
      const extra = ev.teamId ? ' · team ' + ev.teamId : '';
      return flow === '-' ? 'system' + extra : flow + extra;
    }
    function renderEvents() {
      const typeFilter = typeFilterEl.value;
      const query = (searchBoxEl.value || '').toLowerCase().trim();
      const filtered = events.filter((ev) => {
        if (typeFilter !== 'all' && ev.type !== typeFilter) return false;
        if (!query) return true;
        const hay = (JSON.stringify(ev) || '').toLowerCase();
        return hay.includes(query);
      }).slice(-300);
      const rows = filtered.map((ev, idx) => {
        const syntheticId = String(ev.timestamp || 0) + ':' + String(idx);
        const cls = syntheticId === selectedEventId ? 'event selected' : 'event';
        const typeLabel = titleCase(ev.type || 'event');
        const typeClass = eventTypeClass(ev);
        return '<div class="' + cls + '" data-eid="' + syntheticId + '">'
          + '<div class="event-top"><span class="type ' + typeClass + '">' + typeLabel + '</span><span class="tiny mono">' + fmtTime(ev.timestamp) + '</span></div>'
          + '<div class="flow mono">' + eventSubtitle(ev) + '</div>'
          + '<div class="detail">' + shortText(humanSummary(ev), 240) + '</div>'
          + '</div>';
      }).join('');
      eventsList.innerHTML = rows || '<div class="tiny muted">No events yet</div>';
      eventCountEl.textContent = String(events.length);

      const nodes = eventsList.querySelectorAll('.event');
      nodes.forEach((node) => {
        node.addEventListener('click', () => {
          selectedEventId = node.getAttribute('data-eid');
          const index = Array.from(nodes).indexOf(node);
          const filteredIndexBase = Math.max(0, filtered.length - nodes.length);
          const ev = filtered[filteredIndexBase + index];
          if (ev) {
            eventInspector.textContent = JSON.stringify(ev, null, 2);
          }
          renderEvents();
        });
      });
    }
    function renderQueue(data) {
      const channelLabel = (value) => titleCase(value || 'unknown');
      const renderItems = (items) => {
        if (!items || items.length === 0) return '<div class="tiny muted">empty</div>';
        return items.map((item) => {
          const msgId = item.messageId ? String(item.messageId) : 'n/a';
          const preview = shortText(item.preview || 'No message preview available', 140);
          return '<div class="q-item">'
            + '<div><span class="label">' + channelLabel(item.channel) + '</span><span class="tiny">' + (item.sender || 'unknown sender') + '</span></div>'
            + '<div class="tiny muted">' + preview + '</div>'
            + '<div class="mono tiny muted">id: ' + msgId + '</div>'
            + '</div>';
        }).join('');
      };
      qIncomingEl.innerHTML = renderItems(data.incoming || []);
      qProcessingEl.innerHTML = renderItems(data.processing || []);
    }
    function renderConversations(rows) {
      if (!rows || rows.length === 0) {
        convListEl.innerHTML = '<div class="tiny muted">No saved conversations yet</div>';
        return;
      }
      convListEl.innerHTML = rows.map((row) => {
        const when = fmtTime(row.timestamp);
        return '<div class="conv-item">'
          + '<div><span class="label">Team ' + (row.teamId || 'unknown') + '</span><span class="tiny muted">' + when + '</span></div>'
          + '<div class="tiny">Transcript: <span class="mono">' + (row.file || '') + '</span></div>'
          + '<div class="tiny muted">Saved conversation artifact ready for review.</div>'
          + '</div>';
      }).join('');
    }
    function applyStatus(status) {
      incomingEl.textContent = String(status.queue.incoming || 0);
      processingEl.textContent = String(status.queue.processing || 0);
      outgoingEl.textContent = String(status.queue.outgoing || 0);
      agentCountEl.textContent = String((status.agents || []).length);
      teamCountEl.textContent = String((status.teams || []).length);
      homePathEl.textContent = status.tinyclawHome || '-';
      lastUpdateEl.textContent = fmtTime(status.timestamp);
      const label = status.processorAlive ? 'Processor Online' : 'Processor Offline';
      processorBadge.querySelector('span:last-child').textContent = label;
      processorBadge.className = 'badge ' + (status.processorAlive ? 'ok' : 'bad');
    }

    async function bootstrap() {
      const [statusRes, eventsRes, convRes, queueRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/events?limit=250'),
        fetch('/api/conversations?limit=30'),
        fetch('/api/queue?limit=20')
      ]);
      const status = await statusRes.json();
      const ev = await eventsRes.json();
      const conv = await convRes.json();
      const queue = await queueRes.json();
      applyStatus(status);
      events = ev.events || [];
      renderEvents();
      renderConversations(conv.conversations || []);
      renderQueue(queue.queue || {});
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

    setInterval(async () => {
      try {
        const [convRes, queueRes] = await Promise.all([
          fetch('/api/conversations?limit=30'),
          fetch('/api/queue?limit=20')
        ]);
        const conv = await convRes.json();
        const queue = await queueRes.json();
        renderConversations(conv.conversations || []);
        renderQueue(queue.queue || {});
      } catch (_e) {}
    }, 4000);

    typeFilterEl.addEventListener('change', renderEvents);
    searchBoxEl.addEventListener('input', renderEvents);

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
        if (reqUrl.pathname === '/api/queue') {
            const limit = Math.max(1, Math.min(50, Number(reqUrl.searchParams.get('limit') || '20')));
            return writeJson(res, 200, { queue: readQueueSamples(limit) });
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
