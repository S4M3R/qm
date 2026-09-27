import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  AppWindow,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Crown,
  ExternalLink,
  GitPullRequest,
  Hourglass,
  LifeBuoy,
  Send,
  Target,
  Trophy,
  type IconNode,
} from "lucide";
import { api, ApiError } from "./core-bridge";
import { deepLinkPath, parseDeepLink, UI_BASE } from "./deep-link";
import { setScopedSession } from "./session-scope";
import { startNewChat } from "./sessions";
import { appState, renderSidebarTop, replacePanePreservingFocus, switchView } from "./shell";
import { markdown } from "./message-markdown";
import { avatarTpl, onProfilePhotoChange } from "./profile-photo";
import { icon } from "./ui";

type MissionStatus = "open" | "answered" | "done" | "skipped";

interface Mission {
  id: string;
  kind?: string;
  context?: Record<string, unknown>;
  title: string;
  question: string;
  reason: string;
  app: { name: string; owner: string; url?: string };
  assignee: string;
  assigneeName: string;
  from: string;
  minutes: number;
  points: number;
  status: MissionStatus;
  createdAt: number;
  answer?: string;
  bonus?: number;
  bonusReason?: string;
  result?: { note: string; url?: string };
}

interface LeaderRow {
  name: string;
  craft: string;
  points: number;
  missions: number;
  principal?: string;
  photo?: string;
}

interface Board {
  viewer: { principal: string; name: string } | null;
  mine: Mission[];
  missions: Mission[];
  leaderboard: LeaderRow[];
  feed: FeedItem[];
}

interface FeedItem {
  id: string;
  at: number;
  kind: "system" | "points" | "message";
  text: string;
  person?: string;
  points?: number;
  gif?: string;
}

const GIFS: Array<{ label: string; id: string }> = [
  { label: "Let's go", id: "5UAofAl6g5t1GL5nO8" },
  { label: "Ship it", id: "143vPc6b08locw" },
  { label: "Cheers", id: "KVT0i8ls6Scp5X2255" },
  { label: "Slow clap", id: "1236TCtX5dsGEo" },
  { label: "Well done", id: "lvOnlEYunAwOkHjgmU" },
  { label: "Applause", id: "YRuFixSNWFVcXaxpmX" },
  { label: "Mind blown", id: "3XR0chfiSTtAI" },
  { label: "Party", id: "duNowzaVje6Di3hnOu" },
  { label: "Excited", id: "U4DswrBiaz0p67ZweH" },
  { label: "Thank you", id: "a3IWyhkEC0p32" },
  { label: "Love it", id: "TG3y3b2Ws0gRXgSHoP" },
  { label: "Abandon ship", id: "3o6ZtihIv0pJqdp3H2" },
];

function gifUrl(id: string): string {
  return `https://media.giphy.com/media/${id}/200w.gif`;
}

interface Reward {
  missionId: string;
  points: number;
  fromRank: number;
  toRank: number;
}

const POLL_MS = 3000;

interface KindSpec {
  label: string;
  glyph: IconNode;
  placeholder: string;
  watch: string;
  apply: string;
}

const KINDS: Record<string, KindSpec> = {
  app: {
    label: "App review",
    glyph: AppWindow,
    placeholder: "What would you change? Be specific, QM will apply it.",
    watch: "Watch QM apply your notes",
    apply:
      "Apply my notes to the app: change only what the notes ask for, keep everything else, and republish it at the same place.",
  },
  pr: {
    label: "PR review",
    glyph: GitPullRequest,
    placeholder: "Your review: what should change before this merges?",
    watch: "Watch QM write the review",
    apply:
      "Turn my notes into a clear review for the author: a short summary, then one comment per file with the exact suggested wording. Do not post it anywhere; show it to me here ready to paste.",
  },
  ticket: {
    label: "Support ticket",
    glyph: LifeBuoy,
    placeholder: "How should we answer? Rough notes are fine, QM will write the reply.",
    watch: "Watch QM write the reply",
    apply:
      "Write the reply to the customer from my notes: warm, specific, and short, with clear next steps. Show me the final reply ready to send.",
  },
  doc: {
    label: "Internal docs",
    glyph: BookOpen,
    placeholder: "What's wrong or missing? QM will update the doc.",
    watch: "Watch QM update the doc",
    apply:
      "Rewrite the doc with my corrections applied, keep its structure and tone, and show me the updated version with a short list of what changed.",
  },
};

function kindOf(m: Mission): KindSpec {
  return KINDS[m.kind ?? "app"] ?? { ...KINDS.app!, label: m.kind ?? "Mission", glyph: Target };
}

function ctxString(m: Mission, key: string): string {
  const v = m.context?.[key];
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : "";
}

function ctxList<T>(m: Mission, key: string): T[] {
  const v = m.context?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

const missionsState = {
  board: null as Board | null,
  boardJson: "",
  openId: null as string | null,
  drafts: new Map<string, string>(),
  sending: false,
  starting: false,
  error: "",
  reward: null as Reward | null,
  seen: null as Set<string> | null,
  toast: null as Mission | null,
  tab: "chat" as "chat" | "scores",
  chatDraft: "",
  chatSending: false,
  gifOpen: false,
  gifFilter: "",
};

const previews = new Map<string, { html: string | null; version: string }>();

function previewHtml(url: string, version: string): string | null {
  const cached = previews.get(url);
  if (cached && cached.version === version) return cached.html;
  previews.set(url, { html: cached?.html ?? null, version });
  void loadPreview(url, version, cached?.html ?? null).then(() => draw());
  return cached?.html ?? null;
}

async function loadPreview(url: string, version: string, previous: string | null): Promise<void> {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    const base = `<base href="${new URL(url, location.href).href}">`;
    const doc = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${text}`;
    previews.set(url, { html: doc, version });
  } catch {
    previews.set(url, { html: previous ?? "", version });
  }
}

const bootLink = parseDeepLink(UI_BASE, location.pathname, location.search);
const demoParam = new URLSearchParams(location.search).get("demo");
if (demoParam === "1") localStorage.setItem("missions:demo", "1");
if (demoParam === "0") localStorage.removeItem("missions:demo");
const demoMode = localStorage.getItem("missions:demo") === "1";
let demoTimer = 0;
let demoCountdown = 0;

const DEMO_PEOPLE = [
  { name: "Eve", craft: "Design", points: 140, photo: "https://avatars.githubusercontent.com/u/103564765?v=4" },
  { name: "Josh", craft: "Engineering", points: 120, photo: "https://avatars.githubusercontent.com/u/12610835?v=4" },
  { name: "Regan", craft: "Engineering", points: 105, photo: "https://avatars.githubusercontent.com/u/5395217?v=4" },
  { name: "Agus", craft: "Design", points: 95, self: true },
  { name: "Sina", craft: "Infra", points: 80, photo: "https://avatars.githubusercontent.com/u/89218912?v=4" },
  { name: "Tom", craft: "Engineering", points: 60, photo: "https://avatars.githubusercontent.com/u/16757412?v=4" },
  { name: "Julian", craft: "Sales", points: 35, principal: "julian" },
];

const DEMO_FEED = [
  { kind: "system", text: "Week missions started", minutesAgo: 8600 },
  { kind: "points", person: "Eve", points: 60, text: "Checkout flow review", minutesAgo: 8000 },
  { kind: "message", person: "Josh", text: "Eve starting the week strong", minutesAgo: 7990 },
  {
    kind: "message",
    person: "Regan",
    text: "Slow clap",
    gif: "https://media.giphy.com/media/1236TCtX5dsGEo/200w.gif",
    minutesAgo: 7980,
  },
  { kind: "points", person: "Agus", points: 55, text: "Onboarding emails tone", minutesAgo: 6900 },
  { kind: "points", person: "Josh", points: 60, text: "Deals tab queries", minutesAgo: 6200 },
  { kind: "points", person: "Sina", points: 80, text: "Staging deploy cleanup", minutesAgo: 5000 },
  { kind: "message", person: "Sina", text: "That one was brutal", minutesAgo: 4990 },
  { kind: "points", person: "Regan", points: 45, text: "Cron retry review", minutesAgo: 4300 },
  { kind: "points", person: "Tom", points: 60, text: "Webhook docs", minutesAgo: 3000 },
  { kind: "points", person: "Agus", points: 40, text: "Investor update charts", minutesAgo: 2600 },
  { kind: "points", person: "Eve", points: 80, text: "Admin dashboard layout", minutesAgo: 1500 },
  { kind: "message", person: "Eve", text: "Anyone want to trade missions?", minutesAgo: 1490 },
  {
    kind: "message",
    person: "Sina",
    text: "Ship it",
    gif: "https://media.giphy.com/media/143vPc6b08locw/200w.gif",
    minutesAgo: 1480,
  },
  { kind: "points", person: "Josh", points: 60, text: "Slack bot latency", minutesAgo: 900 },
  { kind: "points", person: "Regan", points: 60, text: "Auth broker review", minutesAgo: 400 },
  { kind: "message", person: "Regan", text: "Catching up", minutesAgo: 380 },
  { kind: "points", person: "Julian", points: 35, text: "Pricing numbers check", minutesAgo: 120 },
  { kind: "message", person: "Julian", text: "Shipped my first pricing page with QM. Be gentle", minutesAgo: 60 },
];

const DEMO_MISSIONS: Array<Record<string, unknown>> = [
  {
    kind: "doc",
    title: "The deploy guide is out of date",
    question:
      "Hi Agus, people keep asking how to deploy in #eng because the guide still describes the old CLI. What should change?",
    reason: "You deployed QM twice this week with the new flow.",
    app: {
      name: "Deploy guide",
      owner: "Platform team",
    },
    context: {
      title: "How to deploy QM",
      owner: "Platform team",
      updated: "Last edited 5 months ago",
      markdown:
        "## How to deploy QM\n\n1. Install the CLI globally: `npm i -g qm-cli`\n2. Log in with `qm login` and pick the **acme** org.\n3. Copy `.env.example` to `.env` and fill in every value by hand.\n4. Run `qm deploy --env prod`.\n5. Ask Sina to add your email to the admin list.\n\n### Troubleshooting\n\nIf the deploy hangs, restart it. It usually works the second time.",
    },
    minutes: 10,
    points: 40,
    from: "QM",
  },
  {
    kind: "ticket",
    title: "A customer is stuck on SSO setup",
    question: "Hi Agus, Dana from Northwind can't finish SSO setup and has written twice. How should we answer?",
    reason: "You set up SSO for 3 customers this quarter.",
    app: {
      name: "Ticket #4821",
      owner: "Dana at Northwind",
    },
    context: {
      customer: "Dana Whitfield",
      company: "Northwind",
      plan: "Team plan",
      waiting: "Waiting 19 h",
      subject: "SSO setup fails at the last step",
      messages: [
        {
          from: "Dana Whitfield",
          at: "Yesterday 4:12 PM",
          text: 'Hi! We\'re setting up Okta SSO. Everything works until the final "Test connection" step, which says "audience mismatch". We copied the ACS URL from your settings page. What are we missing?',
        },
        {
          from: "Dana Whitfield",
          at: "Today 9:03 AM",
          text: "Any update? Our team can't sign in until this works and we have 40 people starting Monday.",
        },
      ],
    },
    minutes: 5,
    points: 30,
    from: "QM",
  },
  {
    kind: "pr",
    title: "Regan's PR needs a second reviewer",
    question:
      "Hi Agus, Regan split the sessions tool into subagents and sessions. Can you review the new tool descriptions? Will the agent understand when to use each one?",
    reason: "You reviewed 3 prompt changes this month, and this one touches every agent turn.",
    app: {
      name: "PR #1656",
      owner: "Regan",
      url: "https://github.com/yc-software/qm/pull/1656",
    },
    context: {
      repo: "yc-software/qm",
      number: 1656,
      author: "ReganBell",
      url: "https://github.com/yc-software/qm/pull/1656",
      title: "Split sessions into subagents and sessions tools",
      additions: 490,
      deletions: 68,
      fileCount: 16,
      body: 'Agents kept mixing up "sessions" and "subagents" because one tool, `sessions`, did both. This splits it in two, so each concept has one noun in tool names, descriptions and prompt text.\n\n**`subagents`**: workers the agent starts for a task. **`sessions`**: the conversations people see in the web sidebar.',
      files: [
        "src/harness/agent-tools.ts",
        "src/core/orchestrator.ts",
        "src/sessions/session-syscalls.ts",
        "plugins/web-ui/src/chat.ts",
        "plugins/web-ui/src/timeline.ts",
        "docs/persistent-subagent-sessions.md",
      ],
      diffFile: "src/harness/agent-tools.ts",
      diff: '@@ -358,7 +358,7 @@ export function coreToolOptions(config: Config): CoreToolOptions {\n const CLIENT_TOOL_DEFAULT_TIMEOUT_MS = 10_000;\n const CLIENT_TOOL_TIMEOUT_TEXT = "The page didn\'t respond in time. It may have been closed or navigated away.";\n \n-const READ_ONLY_TOOL_NAMES = new Set(["memory", "history", "finish_silently", "runtime", "sessions"]);\n+const READ_ONLY_TOOL_NAMES = new Set(["memory", "history", "finish_silently", "runtime", "sessions", "subagents"]);\n \n export function pauseStampAfterToolCall(\n   ref: Pick<ToolContextRef, "pausedOnApproval" | "silentRequested" | "runtimeHandoff">,\n@@ -1476,19 +1476,19 @@ export function createAgentTools(ref: ToolContextRef, opts?: AgentToolsOptions):\n     },\n   });\n \n-  const sessionTool = defineTool({\n-    name: "sessions",\n-    label: "sessions",\n+  const subagentTool = defineTool({',
    },
    minutes: 15,
    points: 60,
    from: "QM",
  },
];

function demoMission(): Record<string, unknown> {
  return {
    kind: "app",
    title: "Julian's pricing page could use a designer's eye",
    question:
      "Hi Agus, Julian has been working on this pricing page. How would you make it better? What should we change?",
    reason: "You've improved 4 layouts this month, and this page goes live with Friday's launch.",
    assignee: appState.me?.user ?? "",
    assigneeName: "Agus",
    app: { name: "Acme Pricing", owner: "Julian", url: new URL("/d/acme-pricing/", location.origin).href },
    minutes: 5,
    points: 40,
    from: "QM",
  };
}

async function demoReset(): Promise<void> {
  window.clearInterval(demoTimer);
  demoCountdown = 0;
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
  await post("/api/missions/reset", {});
  await post("/api/missions/people", {
    people: DEMO_PEOPLE.map(({ self, ...p }) => (self ? { ...p, principal: appState.me?.user ?? "" } : p)),
  });
  await post("/api/missions/feed", { items: DEMO_FEED });
  for (const mission of DEMO_MISSIONS) {
    await post("/api/missions", { ...mission, assignee: appState.me?.user ?? "", assigneeName: "Agus", quiet: true });
  }
  missionsState.seen = null;
  missionsState.reward = null;
  missionsState.openId = null;
  await fetchBoard();
  draw();
}

function demoSendSoon(seconds: number): void {
  window.clearInterval(demoTimer);
  demoCountdown = seconds;
  draw();
  demoTimer = window.setInterval(() => {
    demoCountdown -= 1;
    if (demoCountdown <= 0) {
      window.clearInterval(demoTimer);
      void api("/api/missions", { method: "POST", body: JSON.stringify(demoMission()) })
        .then(() => fetchBoard())
        .finally(() => draw());
    }
    draw();
  }, 1000);
}

function demoTpl(): TemplateResult | typeof nothing {
  if (!demoMode) return nothing;
  return html`<div class="missions-demo">
    <span>Demo</span>
    <button class="btn compact" type="button" @click=${() => void demoReset()}>Reset demo</button>
    <button class="btn compact" type="button" ?disabled=${demoCountdown > 0} @click=${() => demoSendSoon(8)}>
      ${demoCountdown > 0 ? `Sending in ${demoCountdown} s` : "Send mission in 8 s"}
    </button>
  </div>`;
}
let pendingOpen: string | null = bootLink.view === "missions" ? bootLink.item : null;
let host: HTMLDivElement | null = null;
let toastHost: HTMLDivElement | null = null;
let toastTimer = 0;
let watching = false;

function isMe(row: LeaderRow, board: Board): boolean {
  const viewer = board.viewer;
  if (!viewer) return false;
  const lower = (s?: string) => s?.toLowerCase();
  return lower(row.principal) === lower(viewer.principal) || lower(row.name) === lower(viewer.name);
}

function rankOf(board: Board | null): number {
  if (!board) return 0;
  const index = board.leaderboard.findIndex((row) => isMe(row, board));
  return index + 1;
}

export function openMissionCount(): number {
  return missionsState.board?.mine.filter((m) => m.status === "open").length ?? 0;
}

async function fetchBoard(): Promise<boolean> {
  const board = await api<Board>("/api/missions");
  const json = JSON.stringify(board);
  const changed = json !== missionsState.boardJson;
  const hadOpen = openMissionCount();
  missionsState.board = board;
  missionsState.boardJson = json;
  noticeNewMissions(board);
  if (openMissionCount() !== hadOpen) renderSidebarTop();
  return changed;
}

function noticeNewMissions(board: Board): void {
  const ids = new Set(board.mine.map((m) => m.id));
  if (missionsState.seen) {
    const fresh = board.mine.find((m) => m.status === "open" && !missionsState.seen!.has(m.id));
    if (fresh && !(appState.currentView === "missions" && missionsState.openId === fresh.id)) showToast(fresh);
  }
  missionsState.seen = ids;
}

export function startMissionsWatch(): void {
  if (watching) return;
  watching = true;
  const tick = async () => {
    try {
      const changed = await fetchBoard();
      if (changed && appState.currentView === "missions") draw();
    } catch {
      void 0;
    }
  };
  void tick();
  window.setInterval(() => void tick(), POLL_MS);
  onProfilePhotoChange(() => void tick());
  window.setInterval(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".missions-countdown")) el.textContent = countdownText();
  }, 1000);
}

export async function renderMissions(): Promise<void> {
  if (appState.currentView !== "missions") return;
  const { item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  missionsState.openId = pendingOpen ?? item;
  pendingOpen = null;
  if (missionsState.openId) {
    history.replaceState(null, "", deepLinkPath(UI_BASE, "missions", null, null, missionsState.openId));
  }
  draw();
  try {
    await fetchBoard();
    missionsState.error = "";
  } catch (e) {
    missionsState.error = e instanceof ApiError ? e.message : "Couldn't load missions.";
  }
  draw();
}

export function routeMissionsHistory(item: string | null): void {
  missionsState.openId = item;
  missionsState.reward = null;
  draw();
}

export function openMission(id: string): void {
  pendingOpen = id;
  missionsState.reward = null;
  setScopedSession(null);
  switchView("missions");
}

function go(id: string | null): void {
  missionsState.openId = id;
  missionsState.reward = null;
  missionsState.error = "";
  history.pushState(null, "", deepLinkPath(UI_BASE, "missions", null, null, id));
  draw();
  appState.mainEl?.querySelector(".pane")?.scrollTo({ top: 0 });
}

function draw(): void {
  if (appState.currentView !== "missions" || !appState.mainEl) return;
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "pane missions-pane";
    replacePanePreservingFocus(host);
  }
  const board = missionsState.board;
  const mission = missionsState.openId ? board?.missions.find((m) => m.id === missionsState.openId) : undefined;
  render(mission && board ? detailTpl(mission, board) : listTpl(board), host);
}

function earned(m: Mission): number {
  return m.status === "open" ? 0 : m.points + (m.bonus ?? 0);
}

function statusLine(m: Mission): TemplateResult {
  if (m.status === "skipped") return html`<span class="missions-status">Skipped</span>`;
  if (m.status === "done") return html`<span class="missions-status done">Shipped to ${m.app.name}</span>`;
  if (m.status === "answered") return html`<span class="missions-status working">QM is applying your notes</span>`;
  return html`<span class="missions-status open">Waiting for you</span>`;
}

function weekInfo(now = new Date()): { week: number; end: Date } {
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const end = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  const thursday = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { week, end };
}

export function countdownText(now = Date.now()): string {
  const left = Math.max(0, weekInfo(new Date(now)).end.getTime() - now);
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

function hue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clockTime(at);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${clockTime(at)}`;
}

function photoFor(board: Board, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return board.leaderboard.find((row) => row.name.toLowerCase() === name.toLowerCase())?.photo;
}

function myRow(board: Board): LeaderRow | undefined {
  return board.leaderboard.find((row) => isMe(row, board));
}

function listTpl(board: Board | null): TemplateResult {
  if (!board) return html`<div class="empty compact">Loading missions…</div>`;
  const { week } = weekInfo();
  const me = myRow(board);
  const rank = rankOf(board);
  return html`
    <div class="week">
      ${missionsState.error ? html`<div class="missions-error">${missionsState.error}</div>` : nothing}
      <header class="week-top">
        <div class="week-crew" aria-label="Everyone playing this week">
          ${board.leaderboard.slice(0, 7).map((row) => avatarTpl(row.name, row.photo, "week-crew-avatar"))}
        </div>
        <div class="week-pills">
          <span class="week-pill"><strong>${me?.points ?? 0}</strong><span>QM Points</span></span>
          <span class="week-pill"><strong>#${rank || "–"}</strong>${icon(Trophy, 16)}</span>
        </div>
        <div class="week-label">Week ${week}</div>
        <h1 class="week-title">This week</h1>
      </header>
      ${heroTpl(board)} ${moreTpl(board)}
      <div class="week-scout">
        <button
          class="btn"
          type="button"
          ?disabled=${missionsState.starting}
          @click=${() => void startSessionWith(scoutPrompt(board))}
        >
          ${icon(Target, 15)}<span>${missionsState.starting ? "Starting…" : "Ask QM to find missions"}</span>
        </button>
      </div>
      ${podiumTpl(board)}
      <div class="week-tabs settings-choice" role="tablist" aria-label="Missions feed">
        ${(["chat", "scores"] as const).map(
          (tab) =>
            html`<button
              class="settings-choice-option ${missionsState.tab === tab ? "selected" : ""}"
              type="button"
              role="tab"
              aria-selected=${missionsState.tab === tab ? "true" : "false"}
              @click=${() => {
                missionsState.tab = tab;
                draw();
              }}
            >
              ${tab === "chat" ? "Chat" : "Scores"}
            </button>`,
        )}
      </div>
      ${missionsState.tab === "chat" ? feedTpl(board) : scoresTpl(board)} ${demoTpl()}
    </div>
  `;
}

function openMissions(board: Board): Mission[] {
  return board.mine.filter((m) => m.status === "open");
}

function heroMission(board: Board): Mission | undefined {
  return openMissions(board)[0] ?? board.mine.find((m) => m.status !== "skipped");
}

function moreTpl(board: Board): TemplateResult | typeof nothing {
  const hero = heroMission(board);
  const rest = openMissions(board).filter((m) => m !== hero);
  if (!rest.length) return nothing;
  return html`<section class="week-more" aria-label="More missions this week">
    <h2 class="missions-section-title">More missions this week</h2>
    ${rest.map(
      (m) =>
        html`<a
          class="week-more-row"
          href=${deepLinkPath(UI_BASE, "missions", null, null, m.id)}
          @click=${(e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            go(m.id);
          }}
        >
          <span class="missions-card-icon">${icon(kindOf(m).glyph, 18)}</span>
          <span class="week-more-body">
            <strong>${m.title}</strong>
            <span>${kindOf(m).label}, ${m.app.name}, about ${m.minutes} min</span>
          </span>
          <span class="missions-points-pill">${m.points} pts</span>
        </a>`,
    )}
  </section>`;
}

function heroSnippet(m: Mission): TemplateResult {
  if (m.kind === "pr") {
    return html`<div class="week-hero-snippet">
      <span class="snippet-kind">${icon(GitPullRequest, 15)} ${ctxString(m, "repo")} #${ctxString(m, "number")}</span>
      <strong>${ctxString(m, "title")}</strong>
      <pre class="snippet-diff">${diffTpl(ctxString(m, "diff").split("\n").slice(0, 8).join("\n"))}</pre>
    </div>`;
  }
  if (m.kind === "ticket") {
    const first = ctxList<{ from: string; text: string }>(m, "messages")[0];
    return html`<div class="week-hero-snippet">
      <span class="snippet-kind">${icon(LifeBuoy, 15)} ${m.app.name}, ${ctxString(m, "company")}</span>
      <strong>${ctxString(m, "subject")}</strong>
      <p>${first?.text ?? ""}</p>
    </div>`;
  }
  if (m.kind === "doc") {
    return html`<div class="week-hero-snippet">
      <span class="snippet-kind">${icon(BookOpen, 15)} ${ctxString(m, "updated")}</span>
      <strong>${ctxString(m, "title")}</strong>
      <p>${ctxString(m, "markdown").replace(/[#`*]/g, "").slice(0, 220)}…</p>
    </div>`;
  }
  const url = m.result?.url ?? m.app.url;
  const doc = url ? previewHtml(url, `${m.status}:${m.result?.note ?? ""}`) : "";
  return html`${doc ? html`<iframe sandbox="" tabindex="-1" .srcdoc=${doc} title=${`${m.app.name} preview`}></iframe>` : nothing}`;
}

function heroTpl(board: Board): TemplateResult {
  const mission = heroMission(board);
  if (!mission) {
    return html`<div class="week-hero empty">
      <div class="week-hero-top">
        <span class="week-badge">${icon(Target, 14)}<span>No mission yet</span></span>
        <span class="week-badge"
          >${icon(Hourglass, 14)}<span class="missions-countdown" .textContent=${countdownText()}></span
        ></span>
      </div>
      <p class="week-hero-empty">QM sends one when a teammate's work could use your expertise.</p>
    </div>`;
  }
  return html`<a
    class="week-hero ${mission.status}"
    href=${deepLinkPath(UI_BASE, "missions", null, null, mission.id)}
    @click=${(e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      go(mission.id);
    }}
  >
    <div class="week-hero-top">
      <span class="week-badge">
        ${icon(mission.status === "open" ? Target : Trophy, 14)}
        <span>${mission.status === "open" ? `${mission.points} QM Points` : `+${earned(mission)} earned`}</span>
      </span>
      <span class="week-badge"
        >${icon(Hourglass, 14)}<span class="missions-countdown" .textContent=${countdownText()}></span
      ></span>
    </div>
    <div class="week-hero-preview ${mission.kind ?? "app"}">${heroSnippet(mission)}</div>
    <div class="week-hero-body">
      <span class="week-hero-app">${mission.app.name} by ${mission.app.owner}</span>
      <span class="week-hero-title">${mission.title}</span>
      <span class="week-hero-meta">About ${mission.minutes} min ${statusLine(mission)}</span>
    </div>
  </a>`;
}

function podiumTpl(board: Board): TemplateResult {
  const [first, second, third] = board.leaderboard;
  if (!first) return html``;
  const spot = (row: LeaderRow | undefined, place: number) =>
    row
      ? html`<div class="podium-spot place-${place} ${isMe(row, board) ? "is-me" : ""}">
          ${place === 1 ? html`<span class="podium-crown">${icon(Crown, 26)}</span>` : nothing}
          ${avatarTpl(row.name, row.photo, "podium-avatar")}
          <span class="podium-points">${row.points} pts</span>
          <span class="podium-name">${row.name}</span>
        </div>`
      : html`<div class="podium-spot"></div>`;
  return html`<section class="week-podium" aria-label="Top three">
      ${spot(second, 2)} ${spot(first, 1)} ${spot(third, 3)}
    </section>
    <div class="week-leader">
      <span class="week-leader-label">Leading this week</span>
      <span class="week-leader-name">${first.name}</span>
      <span class="week-leader-points">${first.points} QM Points</span>
    </div>`;
}

function feedTpl(board: Board): TemplateResult {
  const pointsItems = board.feed.filter((f) => f.kind === "points");
  const hot = new Set(
    [...pointsItems]
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.at - a.at)
      .slice(0, 2)
      .map((f) => f.id),
  );
  return html`<section class="week-feed" aria-label="Chat">
    ${board.feed.length ? nothing : html`<p class="week-feed-empty">No activity yet this week. Say hi.</p>`}
    ${board.feed.map((item) => feedItemTpl(board, item, hot.has(item.id)))}
    <form
      class="week-composer"
      @submit=${(e: Event) => {
        e.preventDefault();
        void sendChat();
      }}
    >
      <input
        class="week-composer-input"
        type="text"
        placeholder="Message"
        aria-label="Message"
        .value=${live(missionsState.chatDraft)}
        @input=${(e: Event) => (missionsState.chatDraft = (e.currentTarget as HTMLInputElement).value)}
      />
      <button
        class="week-gif-toggle ${missionsState.gifOpen ? "open" : ""}"
        type="button"
        aria-expanded=${missionsState.gifOpen ? "true" : "false"}
        @click=${() => openGifPicker()}
      >
        GIF
      </button>
      <button class="btn primary" type="submit" ?disabled=${missionsState.chatSending} aria-label="Send">
        ${icon(Send, 15)}
      </button>
      ${missionsState.gifOpen ? gifPickerTpl() : nothing}
    </form>
  </section>`;
}

function feedItemTpl(board: Board, item: FeedItem, hot: boolean): TemplateResult {
  if (item.kind === "system") {
    return html`<div class="feed-system"><span>${item.text}</span><time>${dayLabel(item.at)}</time></div>`;
  }
  const name = item.person ?? "Someone";
  const avatar = avatarTpl(name, photoFor(board, name), "feed-avatar");
  if (item.kind === "points") {
    return html`<div class="feed-points ${hot ? "hot" : ""}" title=${item.text}>
      ${avatar}
      <span class="feed-points-body">
        <strong>Scored ${item.points} pts</strong>
        <span>${name} ${dayLabel(item.at)}</span>
      </span>
    </div>`;
  }
  return html`<div class="feed-message">
    ${avatar}
    <div class="feed-bubble">
      <span class="feed-name" style=${`--name-hue:${hue(name)}`}>${name}</span>
      ${item.gif ? html`<img class="feed-gif" src=${item.gif} alt=${item.text || "GIF"} loading="lazy" />` : nothing}
      ${item.text && !item.gif ? html`<p>${item.text}</p>` : nothing}
      <time>${dayLabel(item.at)}</time>
    </div>
  </div>`;
}

function scoresTpl(board: Board): TemplateResult {
  return html`<section class="week-scores">${leaderboardTpl(board)}</section>`;
}

function openGifPicker(): void {
  missionsState.gifOpen = !missionsState.gifOpen;
  missionsState.gifFilter = "";
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLInputElement>(".week-gif-filter")?.focus());
}

function gifPickerTpl(): TemplateResult {
  const filter = missionsState.gifFilter.trim().toLowerCase();
  const shown = GIFS.filter((g) => !filter || g.label.toLowerCase().includes(filter));
  return html`<div class="week-gif-picker" role="dialog" aria-label="Send a GIF">
    <input
      class="week-gif-filter"
      type="search"
      placeholder="Filter reactions"
      aria-label="Filter reactions"
      .value=${live(missionsState.gifFilter)}
      @input=${(e: Event) => {
        missionsState.gifFilter = (e.currentTarget as HTMLInputElement).value;
        draw();
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          missionsState.gifOpen = false;
          draw();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const first = shown[0];
          if (first) void sendGif(first);
        }
      }}
    />
    <div class="week-gif-grid">
      ${shown.map(
        (g) =>
          html`<button class="week-gif-option" type="button" title=${g.label} @click=${() => void sendGif(g)}>
            <img src=${gifUrl(g.id)} alt="" loading="lazy" />
            <span>${g.label}</span>
          </button>`,
      )}
      ${shown.length ? nothing : html`<p class="week-gif-empty">No reactions match "${missionsState.gifFilter}"</p>`}
    </div>
    <span class="week-gif-credit">Powered by GIPHY</span>
  </div>`;
}

async function sendGif(gif: { label: string; id: string }): Promise<void> {
  if (missionsState.chatSending) return;
  missionsState.chatSending = true;
  missionsState.gifOpen = false;
  draw();
  try {
    await api("/api/missions/chat", { method: "POST", body: JSON.stringify({ text: gif.label, gif: gifUrl(gif.id) }) });
    await fetchBoard();
  } catch (e) {
    missionsState.error = e instanceof ApiError ? e.message : "Couldn't send that GIF.";
  } finally {
    missionsState.chatSending = false;
  }
  draw();
  requestAnimationFrame(() =>
    host?.querySelector(".week-composer")?.scrollIntoView({ block: "end", behavior: "smooth" }),
  );
}

async function sendChat(): Promise<void> {
  const text = missionsState.chatDraft.trim();
  if (!text || missionsState.chatSending) return;
  missionsState.chatSending = true;
  draw();
  try {
    await api("/api/missions/chat", { method: "POST", body: JSON.stringify({ text }) });
    missionsState.chatDraft = "";
    await fetchBoard();
  } catch (e) {
    missionsState.error = e instanceof ApiError ? e.message : "Couldn't send your message.";
  } finally {
    missionsState.chatSending = false;
  }
  draw();
  requestAnimationFrame(() =>
    host?.querySelector(".week-composer")?.scrollIntoView({ block: "end", behavior: "smooth" }),
  );
}

function leaderboardTpl(board: Board): TemplateResult {
  return html`<aside class="missions-board" aria-label="Leaderboard">
    <h2 class="missions-section-title">${icon(Trophy, 15)}<span>Leaderboard</span></h2>
    <ol class="missions-leaderboard">
      ${board.leaderboard.map(
        (row, i) =>
          html`<li class="missions-leader ${isMe(row, board) ? "is-me" : ""}" data-leader=${row.name}>
            <span class="missions-rank">${i + 1}</span>
            ${avatarTpl(row.name, row.photo, "missions-avatar")}
            <span class="missions-leader-name">
              <span>${row.name}${isMe(row, board) ? html` <span class="missions-you">You</span>` : nothing}</span>
              ${row.craft ? html`<small>${row.craft}</small>` : nothing}
            </span>
            <span class="missions-leader-points" data-points=${row.points}>${row.points}</span>
          </li>`,
      )}
    </ol>
    <p class="missions-prize">Most QM Points at the end of the month wins the prize.</p>
  </aside>`;
}

function diffClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function diffTpl(diff: string): TemplateResult[] {
  return diff.split("\n").map((line) => {
    return html`<span class="diff-line ${diffClass(line)}">${line || " "}</span>`;
  });
}

function panelBar(name: string, url: string | undefined, label: string): TemplateResult {
  return html`<div class="mission-preview-bar">
    <span class="mission-preview-name">${name}</span>
    ${
      url
        ? html`<a class="mission-preview-open" href=${url} target="_blank" rel="noopener">
            <span>${label}</span>${icon(ExternalLink, 13)}
          </a>`
        : nothing
    }
  </div>`;
}

function prPanel(m: Mission): TemplateResult {
  const files = ctxList<string>(m, "files");
  return html`<section class="mission-preview">
    ${panelBar(`${ctxString(m, "repo")} #${ctxString(m, "number")}`, ctxString(m, "url") || undefined, "Open on GitHub")}
    <div class="mission-context">
      <h2 class="context-title">${ctxString(m, "title")}</h2>
      <div class="context-meta">
        <span>${ctxString(m, "author")} wants to merge</span>
        <span class="diff-stat add">+${ctxString(m, "additions")}</span>
        <span class="diff-stat del">−${ctxString(m, "deletions")}</span>
        <span>${ctxString(m, "fileCount") || files.length} files</span>
      </div>
      <div class="context-body">${markdown(ctxString(m, "body"))}</div>
      <div class="context-files">${files.map((f) => html`<code>${f}</code>`)}</div>
      <div class="context-file-head">${ctxString(m, "diffFile")}</div>
      <pre class="context-diff">${diffTpl(ctxString(m, "diff"))}</pre>
    </div>
  </section>`;
}

function ticketPanel(m: Mission): TemplateResult {
  const messages = ctxList<{ from: string; at?: string; text: string; staff?: boolean }>(m, "messages");
  return html`<section class="mission-preview">
    ${panelBar(`${m.app.name}, ${ctxString(m, "company")}`, ctxString(m, "url") || undefined, "Open ticket")}
    <div class="mission-context">
      <h2 class="context-title">${ctxString(m, "subject")}</h2>
      <div class="context-meta">
        <span>${ctxString(m, "customer")}, ${ctxString(m, "company")}</span><span>${ctxString(m, "plan")}</span>
        <span class="ticket-waiting">${ctxString(m, "waiting")}</span>
      </div>
      <div class="ticket-thread">
        ${messages.map(
          (msg) =>
            html`<div class="ticket-message ${msg.staff ? "staff" : ""}">
              <div class="ticket-message-head"><strong>${msg.from}</strong><span>${msg.at ?? ""}</span></div>
              <p>${msg.text}</p>
            </div>`,
        )}
      </div>
    </div>
  </section>`;
}

function docPanel(m: Mission): TemplateResult {
  return html`<section class="mission-preview">
    ${panelBar(ctxString(m, "title"), ctxString(m, "url") || undefined, "Open doc")}
    <div class="mission-context">
      <div class="context-meta"><span>${ctxString(m, "owner")}</span><span>${ctxString(m, "updated")}</span></div>
      <div class="context-doc">${markdown(ctxString(m, "markdown"))}</div>
    </div>
  </section>`;
}

function contextTpl(m: Mission): TemplateResult {
  if (m.kind === "pr") return prPanel(m);
  if (m.kind === "ticket") return ticketPanel(m);
  if (m.kind === "doc") return docPanel(m);
  return previewTpl(m);
}

function previewTpl(m: Mission): TemplateResult {
  const url = m.result?.url ?? m.app.url;
  return html`<section class="mission-preview">
    <div class="mission-preview-bar">
      <span class="mission-preview-name">${m.app.name}</span>
      ${
        url
          ? html`<a class="mission-preview-open" href=${url} target="_blank" rel="noopener">
              <span>Open app</span>${icon(ExternalLink, 13)}
            </a>`
          : nothing
      }
    </div>
    ${previewBody(m, url)}
  </section>`;
}

function previewBody(m: Mission, url: string | undefined): TemplateResult {
  if (!url) return html`<div class="mission-preview-empty">No preview for this app</div>`;
  const doc = previewHtml(url, `${m.status}:${m.result?.note ?? ""}`);
  if (doc === null) return html`<div class="mission-preview-empty">Loading ${m.app.name}…</div>`;
  if (!doc) return html`<div class="mission-preview-empty">Open the app to see it</div>`;
  return html`<iframe
    class="mission-preview-frame"
    sandbox=""
    .srcdoc=${doc}
    title=${`${m.app.name} preview`}
  ></iframe>`;
}

function projectedRank(board: Board, gain: number): number {
  const me = myRow(board);
  if (!me) return 0;
  const mine = me.points + gain;
  return board.leaderboard.filter((row) => !isMe(row, board) && row.points > mine).length + 1;
}

function standingTpl(m: Mission, board: Board): TemplateResult {
  const me = myRow(board);
  const reward = missionsState.reward?.missionId === m.id ? missionsState.reward : null;
  return html`<div
    class="week-pills mission-standing ${reward ? "just-moved" : ""}"
    aria-label="Your standing this week"
  >
    <span class="week-pill"><strong class="standing-points">${me?.points ?? 0}</strong><span>QM Points</span></span>
    <span class="week-pill"><strong>#${rankOf(board) || "–"}</strong>${icon(Trophy, 16)}</span>
  </div>`;
}

function rewardHint(m: Mission, board: Board): string {
  const next = projectedRank(board, m.points);
  return next < rankOf(board)
    ? `${m.points} QM Points, enough to move up to #${next}`
    : `${m.points} QM Points, plus a bonus for specific notes`;
}

function askTpl(m: Mission, board: Board): TemplateResult {
  const draft = missionsState.drafts.get(m.id) ?? "";
  return html`<form
      class="mission-composer"
      @submit=${(e: Event) => {
        e.preventDefault();
        void submit(m);
      }}
    >
      <textarea
        id="mission-notes"
        class="mission-notes"
        rows="5"
        aria-label="Your notes"
        placeholder=${kindOf(m).placeholder}
        .value=${live(draft)}
        @input=${(e: Event) => missionsState.drafts.set(m.id, (e.currentTarget as HTMLTextAreaElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(m);
          }
        }}
      ></textarea>
      <div class="mission-composer-foot">
        <span class="mission-hint">${rewardHint(m, board)}</span>
        <span class="mission-composer-actions">
          <button
            class="btn compact mission-skip"
            type="button"
            ?disabled=${missionsState.sending}
            @click=${() => void skip(m)}
          >
            Skip
          </button>
          <button class="mission-send" type="submit" ?disabled=${missionsState.sending} aria-label="Send to QM">
            ${icon(ArrowUp, 16)}
          </button>
        </span>
      </div>
    </form>
    ${missionsState.error ? html`<div class="missions-error">${missionsState.error}</div>` : nothing}`;
}

function rewardTpl(m: Mission): TemplateResult {
  const reward = missionsState.reward?.missionId === m.id ? missionsState.reward : null;
  return html`<section class="mission-reward">
    <div class="mission-reward-head">
      <span class="mission-reward-points">+${earned(m)}</span>
      <span class="mission-reward-label">QM Points</span>
    </div>
    ${
      reward && reward.fromRank > reward.toRank
        ? html`<p class="mission-reward-rank">
            You moved up from #${reward.fromRank} to <strong>#${reward.toRank}</strong> on the leaderboard.
          </p>`
        : nothing
    }
    ${m.bonus ? html`<p class="mission-bonus">+${m.bonus} bonus: ${m.bonusReason}</p>` : nothing}
    <blockquote class="mission-answer">${m.answer}</blockquote>
    ${
      m.status === "done"
        ? html`<div class="mission-shipped"><strong>Shipped to ${m.app.name}.</strong> ${m.result?.note}</div>`
        : html`<button
              class="btn primary mission-watch"
              type="button"
              ?disabled=${missionsState.starting}
              @click=${() => void applyWithQm(m)}
            >
              ${missionsState.starting ? "Starting…" : kindOf(m).watch}
            </button>
            <span class="mission-hint">QM takes it from here and tells ${m.app.owner}.</span>`
    }
  </section>`;
}

function taskTpl(m: Mission, board: Board): TemplateResult {
  if (m.status === "open") return askTpl(m, board);
  if (m.status === "skipped") return skippedTpl();
  return rewardTpl(m);
}

function detailTpl(m: Mission, board: Board): TemplateResult {
  return html`
    <div class="mission-detail">
      <div class="mission-task">
        <div class="mission-topbar">
          <button class="context-back" type="button" @click=${() => go(null)}>
            ${icon(ArrowLeft, 15)}<span>Missions</span>
          </button>
          ${standingTpl(m, board)}
        </div>
        <h1 class="pane-title mission-title">${m.title}</h1>
        <div class="mission-meta">
          <span class="mission-kind">${icon(kindOf(m).glyph, 13)}${kindOf(m).label}</span>
          <span>${m.app.name}, ${m.app.owner}</span><span>About ${m.minutes} min</span>
          <span class="missions-points-pill ${m.status === "open" ? "" : "earned"}">${m.points} QM Points</span>
        </div>
        <div class="mission-message">
          <span class="mission-from">${m.from}</span>
          <p>${m.question}</p>
          ${m.reason ? html`<p class="mission-reason">${m.reason}</p>` : nothing}
        </div>
        ${taskTpl(m, board)}
      </div>
      ${contextTpl(m)}
    </div>
  `;
}

function skippedTpl(): TemplateResult {
  return html`<section class="mission-reward">
    <p class="mission-skipped">You skipped this mission. No points, no hard feelings.</p>
    <button class="btn mission-watch" type="button" @click=${() => go(null)}>Back to missions</button>
  </section>`;
}

async function skip(m: Mission): Promise<void> {
  if (missionsState.sending) return;
  missionsState.sending = true;
  draw();
  try {
    await api(`/api/missions/${encodeURIComponent(m.id)}/skip`, { method: "POST", body: "{}" });
    missionsState.drafts.delete(m.id);
    await fetchBoard();
    missionsState.sending = false;
    go(null);
    return;
  } catch (e) {
    missionsState.error = e instanceof ApiError ? e.message : "Couldn't skip this mission.";
  }
  missionsState.sending = false;
  draw();
}

async function submit(m: Mission): Promise<void> {
  const answer = (missionsState.drafts.get(m.id) ?? "").trim();
  if (!answer) {
    missionsState.error = "Write a few notes first. Specific notes earn a bonus.";
    draw();
    return;
  }
  if (missionsState.sending) return;
  missionsState.sending = true;
  missionsState.error = "";
  draw();
  const fromRank = rankOf(missionsState.board);
  const before = leaderPositions();
  try {
    await api(`/api/missions/${encodeURIComponent(m.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    await fetchBoard();
    missionsState.drafts.delete(m.id);
    missionsState.reward = { missionId: m.id, points: m.points, fromRank, toRank: rankOf(missionsState.board) };
  } catch (e) {
    missionsState.error = e instanceof ApiError ? e.message : "Couldn't send your notes. Try again.";
  } finally {
    missionsState.sending = false;
  }
  draw();
  if (missionsState.reward?.missionId === m.id) requestAnimationFrame(() => celebrate(before));
}

function leaderPositions(): Map<string, number> {
  const out = new Map<string, number>();
  host?.querySelectorAll<HTMLElement>(".missions-leader").forEach((li) => {
    out.set(li.dataset.leader ?? "", li.getBoundingClientRect().top);
  });
  return out;
}

function celebrate(before: Map<string, number>): void {
  if (!host) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  host.querySelectorAll<HTMLElement>(".missions-leader").forEach((li) => {
    const prev = before.get(li.dataset.leader ?? "");
    const dy = prev === undefined ? 0 : prev - li.getBoundingClientRect().top;
    if (dy && !reduced) {
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: 900,
        delay: 350,
        easing: "cubic-bezier(.2,.8,.2,1)",
        fill: "backwards",
      });
    }
    if (li.classList.contains("is-me")) li.classList.add("just-moved");
  });
  const standing = host.querySelector<HTMLElement>(".mission-standing .standing-points");
  const gain = missionsState.reward?.points ?? 0;
  if (standing && gain && !reduced) {
    const to = Number(standing.textContent) || 0;
    const started = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - started) / 900, 1);
      standing.textContent = String(Math.round(to - gain + gain * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const points = host.querySelector<HTMLElement>(".mission-reward-points");
  if (!points) return;
  const target = Number(points.textContent?.replace(/\D/g, "")) || 0;
  if (!reduced) {
    const started = performance.now();
    const step = (now: number) => {
      const p = Math.min((now - started) / 800, 1);
      points.textContent = `+${Math.round(target * (1 - Math.pow(1 - p, 3)))}`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    confetti(points);
  }
}

const CONFETTI = ["#e8843a", "#e45d79", "#a78bfa", "#60a5fa", "#5cc074", "#f6cc46"];

function confetti(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const burst = document.createElement("div");
  burst.className = "missions-confetti";
  burst.setAttribute("aria-hidden", "true");
  burst.style.left = `${rect.left + rect.width / 2}px`;
  burst.style.top = `${rect.top + rect.height / 2}px`;
  document.body.appendChild(burst);
  const pieces: Promise<Animation>[] = [];
  for (let i = 0; i < 28; i++) {
    const piece = document.createElement("span");
    piece.style.backgroundColor = CONFETTI[i % CONFETTI.length]!;
    burst.appendChild(piece);
    const angle = (i / 28) * Math.PI * 2;
    const dist = 60 + Math.random() * 70;
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist - 40;
    const spin = (i % 2 ? 1 : -1) * (180 + Math.random() * 240);
    pieces.push(
      piece.animate(
        [
          { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${spin}deg)`,
            opacity: 1,
            offset: 0.6,
          },
          {
            transform: `translate(calc(-50% + ${x * 1.1}px), calc(-50% + ${y + 70}px)) rotate(${spin * 1.4}deg)`,
            opacity: 0,
          },
        ],
        { duration: 1100 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
      ).finished,
    );
  }
  void Promise.allSettled(pieces).then(() => burst.remove());
}

function missionContextText(m: Mission): string {
  if (m.kind === "pr") {
    return [
      `Pull request: ${ctxString(m, "repo")} #${ctxString(m, "number")} "${ctxString(m, "title")}" by ${ctxString(m, "author")} (${ctxString(m, "url")}).`,
      `Description:\n${ctxString(m, "body")}`,
      `Diff excerpt (${ctxString(m, "diffFile")}):\n${ctxString(m, "diff")}`,
    ].join("\n\n");
  }
  if (m.kind === "ticket") {
    const thread = ctxList<{ from: string; at?: string; text: string }>(m, "messages")
      .map((msg) => `${msg.from}${msg.at ? ` (${msg.at})` : ""}: ${msg.text}`)
      .join("\n");
    return `Support ticket ${m.app.name} from ${ctxString(m, "customer")} at ${ctxString(m, "company")}: "${ctxString(m, "subject")}".\n\n${thread}`;
  }
  if (m.kind === "doc")
    return `Internal doc "${ctxString(m, "title")}" (${ctxString(m, "updated")}):\n\n${ctxString(m, "markdown")}`;
  return `App: ${m.app.name} by ${m.app.owner}${m.app.url ? ` (${m.app.url})` : ""}.`;
}

function sessionPrompt(m: Mission): string {
  return [
    `Mission "${m.title}" (id ${m.id}), ${kindOf(m).label.toLowerCase()} for ${m.app.owner}.`,
    `QM asked me: ${m.question}`,
    missionContextText(m),
    `My notes:\n${m.answer ?? ""}`,
    kindOf(m).apply,
    `When it's done: score my notes with POST /v1/missions/${m.id}/score (bonus 0-30 for how specific and actionable they were, one-line reason), then complete the mission with POST /v1/missions/${m.id}/complete with a one-sentence note of what changed${m.app.url ? " and the URL" : ""}.`,
  ].join("\n\n");
}

async function startSessionWith(prompt: string): Promise<void> {
  if (missionsState.starting) return;
  missionsState.starting = true;
  draw();
  try {
    setScopedSession(null);
    switchView("chats");
    const conv = startNewChat(null, null);
    if (!conv) return;
    for (let i = 0; i < 60; i++) {
      const agent = conv.state.agent;
      if (agent && (agent.state.isStreaming || agent.state.messages.length)) return;
      if (agent) await conv.composer.submit(prompt);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (conv.state.agent && !conv.composer.state.draft) conv.composer.fillSuggestedPrompt(prompt, conv.state.agent);
  } finally {
    missionsState.starting = false;
  }
}

function applyWithQm(m: Mission): Promise<void> {
  return startSessionWith(sessionPrompt(m));
}

function scoutPrompt(board: Board): string {
  const team = board.leaderboard
    .map(
      (row) =>
        `- ${row.name}${row.craft ? ` (${row.craft})` : ""}${row.principal ? `, principal ${row.principal}` : ""}`,
    )
    .join("\n");
  const open = board.missions
    .filter((m) => m.status === "open")
    .map((m) => `- ${m.title} (${m.app.name}) for ${m.assigneeName}`)
    .join("\n");
  return [
    "Scout for Missions this week.",
    "Look at what the team shipped recently that you can see: my published apps, recent sessions, and files. Pick up to 3 concrete things where one specific teammate's expertise would clearly make the work better (a design pass on an app, a review of a risky change, a customer reply, outdated docs). Skip anything you could fix well yourself.",
    `Teammates and their crafts:\n${team || "- (no one on the board yet; assign to me)"}`,
    open ? `Already open, do not duplicate:\n${open}` : "",
    'For each one, send a mission with POST /v1/missions: {kind: "app"|"pr"|"ticket"|"doc", title, question (start with "Hi <first name>,"), reason (one sentence on why this person), assigneeName, assignee (their principal if listed), app: {name, owner, url}, context (kind-specific, see the API), minutes, points (20-60, scaled to effort), from: "QM"}. Use real URLs from what you looked at.',
    "Finish with a short list of the missions you sent and why.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function showToast(m: Mission): void {
  missionsState.toast = m;
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "missions-toast-host";
    document.body.appendChild(toastHost);
  }
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    missionsState.toast = null;
    drawToast();
  }, 12000);
  drawToast();
}

function drawToast(): void {
  if (!toastHost) return;
  const m = missionsState.toast;
  render(
    m
      ? html`<div class="missions-toast" role="status">
          <span class="missions-card-icon">${icon(Target, 18)}</span>
          <span class="missions-toast-body">
            <strong>New mission from ${m.from}</strong>
            <span>${m.title}</span>
          </span>
          <button
            class="btn primary compact"
            type="button"
            @click=${() => {
              missionsState.toast = null;
              drawToast();
              openMission(m.id);
            }}
          >
            Open
          </button>
        </div>`
      : nothing,
    toastHost,
  );
}
