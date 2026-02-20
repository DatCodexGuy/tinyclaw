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
      --bg: #f5f7fb;
      --panel: #ffffff;
      --line: #e4e9f1;
      --line-2: #d9e0ec;
      --text: #1f2a3d;
      --muted: #6e7c95;
      --soft: #f3f6fc;
      --brand: #2f6df6;
      --brand-soft: #e9f0ff;
      --ok: #1fb96d;
      --warn: #d7a019;
      --bad: #d44757;
    }
    * { box-sizing: border-box; min-width: 0; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Inter", "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
    }
    .app {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
      background: var(--bg);
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 18px 14px;
      border-right: 1px solid var(--line);
      background: #fff;
    }
    .logo { font-weight: 700; font-size: 22px; letter-spacing: .2px; color: #172235; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .nav { margin-top: 18px; display: grid; gap: 8px; }
    .nav-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fff;
      font-size: 12px;
    }
    .nav-item strong { display: block; margin-bottom: 3px; font-size: 12px; color: #1f2c42; }
    .badge {
      margin-top: 12px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line-2);
      font-size: 11px;
      font-weight: 600;
      background: #fff;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .ok .dot { background: var(--ok); }
    .bad .dot { background: var(--bad); }
    .main {
      padding: 16px 18px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 14px;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 6;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
    }
    .heading { font-size: 18px; font-weight: 650; }
    .muted { color: var(--muted); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      word-break: break-word;
    }
    .chips { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .chip {
      border: 1px solid var(--line-2);
      border-radius: 999px;
      background: var(--soft);
      padding: 5px 10px;
      font-size: 11px;
      color: var(--muted);
    }
    .search {
      border: 1px solid var(--line-2);
      background: var(--soft);
      border-radius: 8px;
      padding: 7px 10px;
      min-width: 260px;
      font-size: 12px;
      color: var(--muted);
    }
    .live-pill {
      border: 1px solid #bfe8d1;
      color: #1e9f5d;
      background: #effcf4;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 10px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(6, minmax(100px, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: var(--panel);
      min-height: 70px;
    }
    .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
    .v { font-size: 22px; font-weight: 700; margin-top: 6px; color: #1d2b42; }
    .board-wrap {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      overflow: hidden;
    }
    .board-h {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .board-title { font-size: 16px; font-weight: 650; }
    .board-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .board-btn {
      border: 1px solid #c9d7f4;
      background: var(--brand);
      color: #fff;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      padding: 7px 10px;
    }
    .board-cols {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      padding: 12px;
      background: #fafbfd;
    }
    .col-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      color: #24344f;
      font-size: 12px;
      font-weight: 600;
    }
    .count-pill {
      border: 1px solid var(--line-2);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      color: var(--muted);
      background: #fff;
    }
    .lane-card {
      border: 1px solid var(--line-2);
      border-radius: 8px;
      background: #fff;
      padding: 9px;
      font-size: 12px;
      color: #30435f;
      margin-bottom: 8px;
    }
    .lane-card:last-child { margin-bottom: 0; }
    .lane-muted { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .list {
      margin: 0;
      padding-left: 16px;
      color: #334766;
      font-size: 12px;
      line-height: 1.5;
    }
    .list li { margin: 6px 0; }
    .layout {
      display: grid;
      grid-template-columns: 1.1fr 1fr 1fr;
      gap: 14px;
      min-height: 0;
    }
    .col { display: grid; gap: 14px; min-height: 0; align-content: start; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
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
      background: #fff;
    }
    .panel-title { font-size: 13px; font-weight: 700; color: #22344f; }
    .panel-body { max-height: 40vh; overflow: auto; padding: 10px; background: #fff; }
    .event {
      border: 1px solid var(--line-2);
      border-radius: 8px;
      padding: 9px;
      margin-bottom: 8px;
      background: #fcfdff;
      cursor: pointer;
    }
    .event:hover { border-color: #b8c6dd; }
    .event.selected { border-color: var(--brand); box-shadow: inset 0 0 0 1px #d5e2ff; }
    .event-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
    .type {
      border: 1px solid #cad6ef;
      background: #eff4ff;
      color: #3d5b8f;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
    }
    .type.handoff { border-color: #bae6cf; background: #eefbf4; color: #23854e; }
    .type.error { border-color: #f1c3ca; background: #fff1f3; color: #b84b59; }
    .type.done { border-color: #c7def4; background: #f0f7ff; color: #2f6aa2; }
    .flow { color: #4d5f7f; font-size: 12px; }
    .detail { font-size: 12px; color: var(--muted); line-height: 1.35; }
    .tiny { font-size: 11px; color: var(--muted); }
    .q-item, .conv-item {
      border-bottom: 1px solid var(--line);
      padding: 8px 2px;
    }
    .q-item:last-child, .conv-item:last-child { border-bottom: 0; }
    .label {
      display: inline-block;
      border: 1px solid #d6e1f3;
      border-radius: 6px;
      padding: 1px 6px;
      font-size: 11px;
      margin-right: 6px;
      color: #2f5ea8;
      background: #edf3ff;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #2f4568;
      font-size: 12px;
      line-height: 1.35;
      background: #f7f9fd;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
    }
    input, select {
      background: #f7f9fd;
      color: #2f4568;
      border: 1px solid var(--line-2);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
    }
    .filters { display: flex; gap: 8px; align-items: center; }
    .grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .board { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; }
    .lane { border: 1px solid var(--line); border-radius: 8px; background: #fafbfd; min-height: 120px; overflow: hidden; }
    .lane-h { padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #52617e; background: #fff; font-weight: 700; }
    .lane-b { padding: 8px; max-height: 210px; overflow: auto; }
    .agent {
      border: 1px solid var(--line-2);
      border-radius: 8px;
      background: #fff;
      padding: 7px;
      margin-bottom: 7px;
    }
    .agent:last-child { margin-bottom: 0; }
    .agent-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .agent-name { font-size: 12px; color: #1c2b43; font-weight: 600; }
    .state {
      font-size: 10px;
      border-radius: 999px;
      padding: 1px 7px;
      border: 1px solid #bbe9cf;
      color: #159053;
      background: #eefbf4;
    }
    .state.waiting {
      border-color: #f0ddb0;
      color: #a87b15;
      background: #fff8e8;
    }
    .state.idle {
      border-color: #c6d9f5;
      color: #3b6aa7;
      background: #eef4ff;
    }
    .agent-meta { font-size: 11px; color: var(--muted); line-height: 1.3; }
    @media (max-width: 1200px) {
      .cards { grid-template-columns: repeat(3, minmax(100px, 1fr)); }
      .layout { grid-template-columns: 1fr; }
      .board { grid-template-columns: 1fr; }
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .cards { grid-template-columns: repeat(2, minmax(100px, 1fr)); }
      .topbar { flex-direction: column; align-items: stretch; }
      .search { min-width: 0; width: 100%; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="logo">TinyClaw</div>
      <div class="sub">Multi-Agent Orchestration</div>
      <div id="processorBadge" class="badge bad"><span class="dot"></span><span>Processor Offline</span></div>
      <div class="nav">
        <div class="nav-item"><strong>Dashboard</strong>Live system and task orchestration overview</div>
        <div class="nav-item"><strong>Task Board</strong>Inbox / in-progress / completed flow</div>
        <div class="nav-item"><strong>Agents</strong>Team workload and handoff states</div>
        <div class="nav-item"><strong>Trace Feed</strong>Human-readable event activity stream</div>
      </div>
    </aside>
    <main class="main">
      <section class="topbar">
        <div>
          <div class="heading">Multi-Agent Dashboard</div>
          <div class="tiny">Monitor and orchestrate your TinyClaw team</div>
        </div>
        <div class="chips">
          <span class="live-pill">Live</span>
          <input class="search" value="Search tasks, agents, messages..." readonly />
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

      <section class="board-wrap">
        <div class="board-h">
          <div>
            <div class="board-title">Task Board</div>
            <div class="board-sub">Track and manage agent tasks</div>
          </div>
          <button class="board-btn" type="button">New Task</button>
        </div>
        <div class="board-cols">
          <div>
            <div class="col-head">Inbox <span class="count-pill" id="inboxCount">0</span></div>
            <div class="lane-card">Incoming queue contains new work waiting to be picked up.</div>
            <div class="lane-muted">Messages move here first before processing starts.</div>
          </div>
          <div>
            <div class="col-head">In Progress <span class="count-pill" id="progressCount">0</span></div>
            <div class="lane-card">Active tasks currently being handled by one or more agents.</div>
            <div class="lane-muted">This reflects processing queue activity and live handoffs.</div>
          </div>
          <div>
            <div class="col-head">Done <span class="count-pill" id="doneCount">0</span></div>
            <div class="lane-card">Completed responses delivered successfully.</div>
            <div class="lane-muted">Output queue and response-ready events roll up here.</div>
          </div>
        </div>
      </section>

      <section class="layout">
        <div class="col">
          <div class="panel">
            <div class="panel-h">
              <div class="panel-title">Agent Performance</div>
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
            <div class="panel-body">
              <div class="board">
                <div class="lane">
                  <div class="lane-h">Active</div>
                  <div id="laneActive" class="lane-b"></div>
                </div>
                <div class="lane">
                  <div class="lane-h">Waiting</div>
                  <div id="laneWaiting" class="lane-b"></div>
                </div>
                <div class="lane">
                  <div class="lane-h">Idle</div>
                  <div id="laneIdle" class="lane-b"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Realtime Trace Feed</div><div class="tiny">Human-readable activity</div></div>
            <div id="eventsList" class="panel-body"></div>
          </div>
        </div>

        <div class="col">
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Consensus & Queue</div><div class="tiny">Current collaboration signals</div></div>
            <div class="panel-body grid-two">
              <div><div class="tiny" style="margin-bottom:6px">Incoming</div><div id="qIncoming"></div></div>
              <div><div class="tiny" style="margin-bottom:6px">Processing</div><div id="qProcessing"></div></div>
            </div>
            <div class="panel-body" style="border-top:1px solid var(--line)">
              <div class="tiny" style="margin-bottom:6px">Consensus Highlights</div>
              <ul id="consensusList" class="list"></ul>
            </div>
          </div>
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Recent Conversations</div><div class="tiny">Saved markdown transcripts</div></div>
            <div id="convList" class="panel-body"></div>
          </div>
        </div>

        <div class="col">
          <div class="panel">
            <div class="panel-h"><div class="panel-title">System Health</div><div class="tiny">Operational diagnostics</div></div>
            <div class="panel-body">
              <ul id="healthList" class="list"></ul>
            </div>
          </div>
          <div class="panel">
            <div class="panel-h"><div class="panel-title">Event Inspector</div><div class="tiny">Raw JSON (debug only)</div></div>
            <div class="panel-body"><pre id="eventInspector">{}</pre></div>
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
    const consensusListEl = document.getElementById('consensusList');
    const healthListEl = document.getElementById('healthList');
    const laneActiveEl = document.getElementById('laneActive');
    const laneWaitingEl = document.getElementById('laneWaiting');
    const laneIdleEl = document.getElementById('laneIdle');
    const inboxCountEl = document.getElementById('inboxCount');
    const progressCountEl = document.getElementById('progressCount');
    const doneCountEl = document.getElementById('doneCount');
    let events = [];
    let selectedEventId = null;
    let currentStatus = null;

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
      return raw.replace(/[_-]+/g, ' ').replace(/\\b\\w/g, (m) => m.toUpperCase());
    }
    function shortText(value, limit = 180) {
      const raw = String(value || '').replace(/\\s+/g, ' ').trim();
      if (!raw) return '';
      if (raw.length <= limit) return raw;
      return raw.slice(0, limit - 1) + '…';
    }
    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    function renderAgentLanes() {
      const stats = new Map();
      const upsert = (id) => {
        if (!id) return null;
        if (!stats.has(id)) {
          stats.set(id, {
            id,
            state: 'idle',
            stepsStart: 0,
            stepsDone: 0,
            handoffIn: 0,
            handoffOut: 0,
            lastAt: 0,
            lastSummary: 'No recent activity',
          });
        }
        return stats.get(id);
      };

      for (const ev of events.slice(-500)) {
        if (!ev || !ev.type) continue;
        if (ev.type === 'chain_step_start') {
          const row = upsert(ev.agentId);
          if (!row) continue;
          row.state = 'active';
          row.stepsStart += 1;
          row.lastAt = ev.timestamp || row.lastAt;
          row.lastSummary = 'Started a step';
        } else if (ev.type === 'chain_step_done') {
          const row = upsert(ev.agentId);
          if (!row) continue;
          row.state = 'idle';
          row.stepsDone += 1;
          row.lastAt = ev.timestamp || row.lastAt;
          row.lastSummary = 'Completed a step';
        } else if (ev.type === 'chain_handoff') {
          const from = upsert(ev.fromAgent);
          const to = upsert(ev.toAgent);
          if (from) {
            from.state = 'waiting';
            from.handoffOut += 1;
            from.lastAt = ev.timestamp || from.lastAt;
            from.lastSummary = 'Delegated to @' + (ev.toAgent || '?');
          }
          if (to) {
            to.state = 'active';
            to.handoffIn += 1;
            to.lastAt = ev.timestamp || to.lastAt;
            to.lastSummary = 'Received handoff from @' + (ev.fromAgent || '?');
          }
        } else if (ev.type === 'response_ready' && ev.agentId) {
          const row = upsert(ev.agentId);
          if (!row) continue;
          row.state = 'idle';
          row.lastAt = ev.timestamp || row.lastAt;
          row.lastSummary = 'Prepared final response';
        }
      }

      const rows = Array.from(stats.values()).sort((a, b) => b.lastAt - a.lastAt);
      const active = rows.filter((r) => r.state === 'active');
      const waiting = rows.filter((r) => r.state === 'waiting');
      const idle = rows.filter((r) => r.state === 'idle');

      const renderList = (target, list, stateClass) => {
        if (!list.length) {
          target.innerHTML = '<div class="tiny muted">No agents currently in this lane.</div>';
          return;
        }
        target.innerHTML = list.map((row) => {
          const id = esc(row.id);
          const state = esc(titleCase(row.state));
          const summary = esc(row.lastSummary);
          return '<div class="agent">'
            + '<div class="agent-top"><div class="agent-name">@' + id + '</div><span class="state ' + stateClass + '">' + state + '</span></div>'
            + '<div class="agent-meta">Steps: ' + row.stepsDone + '/' + row.stepsStart + ' · Handoffs: ' + row.handoffOut + '→' + row.handoffIn + '</div>'
            + '<div class="agent-meta">' + summary + '</div>'
            + '</div>';
        }).join('');
      };

      renderList(laneActiveEl, active, '');
      renderList(laneWaitingEl, waiting, 'waiting');
      renderList(laneIdleEl, idle, 'idle');
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
        const typeLabel = esc(titleCase(ev.type || 'event'));
        const typeClass = eventTypeClass(ev);
        const subtitle = esc(eventSubtitle(ev));
        const summary = esc(shortText(humanSummary(ev), 240));
        return '<div class="' + cls + '" data-eid="' + syntheticId + '">'
          + '<div class="event-top"><span class="type ' + typeClass + '">' + typeLabel + '</span><span class="tiny mono">' + fmtTime(ev.timestamp) + '</span></div>'
          + '<div class="flow mono">' + subtitle + '</div>'
          + '<div class="detail">' + summary + '</div>'
          + '</div>';
      }).join('');
      eventsList.innerHTML = rows || '<div class="tiny muted">No events yet</div>';
      eventCountEl.textContent = String(events.length);
      renderAgentLanes();
      renderDerivedInsights();

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
          const msgId = esc(item.messageId ? String(item.messageId) : 'n/a');
          const preview = esc(shortText(item.preview || 'No message preview available', 140));
          const channel = esc(channelLabel(item.channel));
          const sender = esc(item.sender || 'unknown sender');
          return '<div class="q-item">'
            + '<div><span class="label">' + channel + '</span><span class="tiny">' + sender + '</span></div>'
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
        const team = esc(row.teamId || 'unknown');
        const file = esc(row.file || '');
        return '<div class="conv-item">'
          + '<div><span class="label">Team ' + team + '</span><span class="tiny muted">' + when + '</span></div>'
          + '<div class="tiny">Transcript: <span class="mono">' + file + '</span></div>'
          + '<div class="tiny muted">Saved conversation artifact ready for review.</div>'
          + '</div>';
      }).join('');
    }
    function renderDerivedInsights() {
      const recent = events.slice(-400);
      const handoffCount = recent.filter((e) => e.type === 'chain_handoff').length;
      const stepDoneCount = recent.filter((e) => e.type === 'chain_step_done').length;
      const responseReadyCount = recent.filter((e) => e.type === 'response_ready').length;
      const uniqueAgents = new Set(recent.map((e) => e.agentId).filter(Boolean)).size;
      const latestEvent = recent.length ? recent[recent.length - 1] : null;

      const incoming = Number(currentStatus?.queue?.incoming || 0);
      const processing = Number(currentStatus?.queue?.processing || 0);
      const outgoing = Number(currentStatus?.queue?.outgoing || 0);
      inboxCountEl.textContent = String(incoming);
      progressCountEl.textContent = String(processing);
      doneCountEl.textContent = String(outgoing + responseReadyCount);

      const consensusItems = [
        'Recent handoffs completed: ' + handoffCount,
        'Steps completed recently: ' + stepDoneCount,
        'Unique active agents in feed: ' + uniqueAgents,
        latestEvent ? ('Latest activity: ' + shortText(humanSummary(latestEvent), 120)) : 'Latest activity: none yet',
      ];
      consensusListEl.innerHTML = consensusItems.map((item) => '<li>' + esc(item) + '</li>').join('');

      const processorUp = !!currentStatus?.processorAlive;
      const healthItems = [
        'Queue processor is ' + (processorUp ? 'online' : 'offline'),
        'Queue depth: incoming ' + incoming + ', processing ' + processing + ', outgoing ' + outgoing,
        processing > 0 ? 'Workload active: agents are currently executing tasks.' : 'No active execution backlog detected.',
        'Event stream coverage: ' + recent.length + ' recent events loaded.',
      ];
      healthListEl.innerHTML = healthItems.map((item) => '<li>' + esc(item) + '</li>').join('');
    }
    function applyStatus(status) {
      currentStatus = status;
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
      renderDerivedInsights();
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
