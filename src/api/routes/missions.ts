import { randomUUID } from "node:crypto";
import { createMemoryMap, type DurableMap } from "../../persistence/durable-map.ts";
import { sendJson } from "../http.ts";
import { isObj, orgScope } from "./shared.ts";
import { profilePhotos } from "./profile-photos.ts";
import { type ApiCtx, type Route } from "./route.ts";

type MissionStatus = "open" | "answered" | "done" | "skipped";

interface Mission {
  id: string;
  kind: string;
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
  answeredAt?: number;
  bonus?: number;
  bonusReason?: string;
  sessionThread?: string;
  result?: { note: string; url?: string };
  completedAt?: number;
  skippedAt?: number;
  skipReason?: string;
}

interface Person {
  name: string;
  craft: string;
  points: number;
  principal?: string;
  photo?: string;
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

interface MissionState {
  week: string;
  missions: Mission[];
  people: Person[];
  feed: FeedItem[];
}

export type MissionBoardDoc = Record<string, unknown>;

const fallbackBoards = createMemoryMap<MissionBoardDoc>();

function weekStart(now = new Date()): Date {
  const day = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
}

function weekKey(now = new Date()): string {
  const monday = weekStart(now);
  const thursday = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3));
  const week = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function emptyState(): MissionState {
  return { week: weekKey(), missions: [], people: [], feed: [] };
}

let state: MissionState = emptyState();
let queue: Promise<unknown> = Promise.resolve();

function boardStore(ctx: ApiCtx): DurableMap<MissionBoardDoc> {
  return ctx.deps.missionBoards ?? fallbackBoards;
}

async function persist(ctx: ApiCtx): Promise<void> {
  await boardStore(ctx).put(orgScope(), state as unknown as MissionBoardDoc);
}

async function load(ctx: ApiCtx): Promise<void> {
  const doc = (await boardStore(ctx).get(orgScope())) as Partial<MissionState> | null;
  state = { ...emptyState(), ...(doc ?? {}), week: doc?.week ?? weekKey() };
  const current = weekKey();
  if (state.week !== current) {
    state.week = current;
    state.people = state.people.map((p) => ({ ...p, points: 0 }));
    state.feed = [];
    post({ kind: "system", text: `Week ${current.split("-W")[1]} missions started` });
    await persist(ctx);
  }
}

function withBoard(handle: (ctx: ApiCtx) => Promise<void>): (ctx: ApiCtx) => Promise<void> {
  return (ctx) => {
    const run = queue.then(async () => {
      await load(ctx);
      await handle(ctx);
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

function post(item: Omit<FeedItem, "id" | "at"> & { at?: number }): void {
  state.feed.push({ id: randomUUID(), at: item.at ?? Date.now(), ...item });
  state.feed.sort((a, b) => a.at - b.at);
  if (state.feed.length > 200) state.feed.splice(0, state.feed.length - 200);
}

function log(text: string): void {
  post({ kind: "system", text });
}

function personName(viewer: string): string {
  return state.people.find((p) => same(p.principal, viewer))?.name ?? viewer;
}

function str(v: unknown, max = 400): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function viewerOf(ctx: ApiCtx): string | null {
  if (ctx.capability?.actorId) return ctx.capability.actorId;
  if (ctx.auth) return ctx.url.searchParams.get("principalId");
  return null;
}

function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function isMine(m: Mission, viewer: string | null): boolean {
  if (!viewer) return false;
  const person = state.people.find((p) => same(p.principal, viewer));
  return (
    same(m.assignee, viewer) || same(m.assigneeName, viewer) || Boolean(person && same(m.assigneeName, person.name))
  );
}

function earned(m: Mission): number {
  return m.status === "answered" || m.status === "done" ? m.points + (m.bonus ?? 0) : 0;
}

function earnedThisWeek(m: Mission): number {
  return (m.answeredAt ?? 0) >= weekStart().getTime() ? earned(m) : 0;
}

function leaderboard(photos: Map<string, string> = new Map()) {
  const rows = new Map<
    string,
    { name: string; craft: string; points: number; missions: number; principal?: string; photo?: string }
  >();
  for (const p of state.people) {
    rows.set(p.name.toLowerCase(), {
      name: p.name,
      craft: p.craft,
      points: p.points,
      missions: 0,
      ...(p.principal ? { principal: p.principal } : {}),
      ...(p.photo ? { photo: p.photo } : {}),
    });
  }
  for (const m of state.missions) {
    const key = m.assigneeName.toLowerCase();
    const row = rows.get(key) ?? { name: m.assigneeName, craft: "", points: 0, missions: 0, principal: m.assignee };
    if (earnedThisWeek(m) > 0) {
      row.points += earnedThisWeek(m);
      row.missions += 1;
    }
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => {
      const photo = (row.principal && photos.get(row.principal.toLowerCase())) || row.photo;
      return photo ? { ...row, photo } : row;
    })
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}

async function snapshot(ctx: ApiCtx, viewer: string | null) {
  const missions = [...state.missions].sort((a, b) => b.createdAt - a.createdAt);
  const me = state.people.find((p) => same(p.principal, viewer ?? undefined));
  const principals = [...state.people.map((p) => p.principal), ...state.missions.map((m) => m.assignee)].filter(
    (p): p is string => Boolean(p),
  );
  return {
    week: state.week,
    viewer: viewer ? { principal: viewer, name: me?.name ?? viewer } : null,
    mine: missions.filter((m) => isMine(m, viewer)),
    missions,
    leaderboard: leaderboard(await profilePhotos(ctx, principals)),
    feed: state.feed.slice(-80),
  };
}

function findMission(ctx: ApiCtx): Mission | null {
  const m = state.missions.find((x) => x.id === ctx.params.id);
  if (!m) sendJson(ctx.res, 404, { error: "not_found", message: `no mission ${ctx.params.id}` });
  return m ?? null;
}

function missionUrl(ctx: ApiCtx, id: string): string {
  const base = (ctx.deps.missions?.publicUrl ?? "http://localhost:8129").replace(/\/$/, "");
  return `${base}/missions/${encodeURIComponent(id)}`;
}

async function slack(ctx: ApiCtx, text: string, blocks?: unknown[]): Promise<void> {
  const hook = ctx.deps.missions?.slackWebhookUrl;
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    void 0;
  }
}

function announce(ctx: ApiCtx, m: Mission): Promise<void> {
  const url = missionUrl(ctx, m.id);
  const text = `New mission for ${m.assigneeName}: ${m.title}`;
  return slack(ctx, text, [
    { type: "section", text: { type: "mrkdwn", text: `*New mission for ${m.assigneeName}*\n${m.question}` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${m.app.name} by ${m.app.owner}  ·  about ${m.minutes} min  ·  *${m.points} QM Points*`,
        },
      ],
    },
    {
      type: "actions",
      elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Open mission" }, url }],
    },
  ]);
}

async function getMissions(ctx: ApiCtx): Promise<void> {
  sendJson(ctx.res, 200, await snapshot(ctx, viewerOf(ctx)));
}

async function createMission(ctx: ApiCtx): Promise<void> {
  const b = isObj(ctx.body) ? ctx.body : {};
  const app = isObj(b.app) ? b.app : {};
  const question = str(b.question, 600);
  const appName = str(app.name, 80);
  const assigneeName = str(b.assigneeName, 60) ?? str(b.assignee, 60);
  if (!question || !appName || !assigneeName) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "pass `question`, `assigneeName` (who should do it), and `app` {name, owner, url?}",
    });
  }
  const minutes = Math.min(Math.max(Number(b.minutes) || 5, 1), 120);
  const points = Math.min(Math.max(Number(b.points) || 40, 5), 200);
  const url = str(app.url, 500);
  const context = isObj(b.context) && JSON.stringify(b.context).length <= 40_000 ? b.context : undefined;
  const mission: Mission = {
    id: randomUUID().slice(0, 8),
    kind: str(b.kind, 30) ?? "app",
    ...(context ? { context } : {}),
    title: str(b.title, 100) ?? `Review ${appName}`,
    question,
    reason: str(b.reason, 300) ?? "",
    app: { name: appName, owner: str(app.owner, 60) ?? "a teammate", ...(url ? { url } : {}) },
    assignee: str(b.assignee, 120) ?? assigneeName,
    assigneeName,
    from: str(b.from, 40) ?? "QM",
    minutes,
    points,
    status: "open",
    createdAt: Date.now(),
  };
  state.missions.push(mission);
  if (b.quiet !== true) log(`${mission.from} sent ${assigneeName} a mission`);
  await persist(ctx);
  await announce(ctx, mission);
  sendJson(ctx.res, 200, { ok: true, mission, url: missionUrl(ctx, mission.id) });
}

async function answerMission(ctx: ApiCtx): Promise<void> {
  const m = findMission(ctx);
  if (!m) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const answer = str(b.answer, 4000);
  if (!answer) return sendJson(ctx.res, 400, { error: "bad_request", message: "pass `answer`" });
  if (m.status !== "open")
    return sendJson(ctx.res, 409, { error: "already_answered", message: "this mission already has an answer" });
  m.status = "answered";
  m.answer = answer;
  m.answeredAt = Date.now();
  const thread = str(b.sessionThread, 300);
  if (thread) m.sessionThread = thread;
  post({ kind: "points", person: m.assigneeName, points: m.points, text: m.title });
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, mission: m, leaderboard: leaderboard() });
}

async function skipMission(ctx: ApiCtx): Promise<void> {
  const m = findMission(ctx);
  if (!m) return;
  if (m.status !== "open")
    return sendJson(ctx.res, 409, { error: "not_open", message: "only open missions can be skipped" });
  const b = isObj(ctx.body) ? ctx.body : {};
  const reason = str(b.reason, 240);
  m.status = "skipped";
  m.skippedAt = Date.now();
  if (reason) m.skipReason = reason;
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, mission: m });
}

async function linkSession(ctx: ApiCtx): Promise<void> {
  const m = findMission(ctx);
  if (!m) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const thread = str(b.sessionThread, 300);
  if (!thread) return sendJson(ctx.res, 400, { error: "bad_request", message: "pass `sessionThread`" });
  m.sessionThread = thread;
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, mission: m });
}

async function scoreMission(ctx: ApiCtx): Promise<void> {
  const m = findMission(ctx);
  if (!m) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const bonus = Number(b.bonus);
  const reason = str(b.reason, 240);
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > 50 || !reason) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "pass `bonus` (0-50) and `reason`" });
  }
  if (m.status === "open")
    return sendJson(ctx.res, 409, { error: "not_answered", message: "score a mission after it's answered" });
  m.bonus = Math.round(bonus);
  m.bonusReason = reason;
  post({ kind: "points", person: m.assigneeName, points: m.bonus, text: `Bonus: ${reason}` });
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, mission: m, leaderboard: leaderboard() });
}

async function completeMission(ctx: ApiCtx): Promise<void> {
  const m = findMission(ctx);
  if (!m) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const note = str(b.note, 500);
  if (!note)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "pass `note` (what changed) and optionally `url`" });
  if (m.status === "open")
    return sendJson(ctx.res, 409, { error: "not_answered", message: "complete a mission after it's answered" });
  const url = str(b.url, 500);
  m.status = "done";
  m.completedAt = Date.now();
  m.result = { note, ...(url ? { url } : {}) };
  log(`${m.app.name} shipped with ${m.assigneeName}'s notes`);
  await persist(ctx);
  await slack(ctx, `${m.assigneeName} improved your ${m.app.name}`, [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${m.assigneeName} improved ${m.app.owner}'s ${m.app.name}*\n${note}` },
    },
    ...(url || m.app.url
      ? [
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "See the new version" }, url: url ?? m.app.url },
            ],
          },
        ]
      : []),
  ]);
  sendJson(ctx.res, 200, { ok: true, mission: m });
}

async function setPeople(ctx: ApiCtx): Promise<void> {
  const b = isObj(ctx.body) ? ctx.body : {};
  const list = Array.isArray(b.people) ? b.people : [];
  const people: Person[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const name = str(raw.name, 60);
    if (!name) continue;
    const principal = str(raw.principal, 120);
    const photo =
      typeof raw.photo === "string" && /^(https:\/\/|data:image\/)/.test(raw.photo)
        ? raw.photo.slice(0, 400_000)
        : undefined;
    people.push({
      name,
      craft: str(raw.craft, 40) ?? "",
      points: Math.max(0, Number(raw.points) || 0),
      ...(principal ? { principal } : {}),
      ...(photo ? { photo } : {}),
    });
  }
  state.people = people;
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, leaderboard: leaderboard() });
}

const GIF_PATTERN = /^https:\/\/media[0-9]?\.giphy\.com\/media\/[A-Za-z0-9]+\/[A-Za-z0-9_.]+$/;

async function chat(ctx: ApiCtx): Promise<void> {
  const viewer = viewerOf(ctx);
  const b = isObj(ctx.body) ? ctx.body : {};
  const text = str(b.text, 500);
  const gif = typeof b.gif === "string" && GIF_PATTERN.test(b.gif) ? b.gif : undefined;
  if (!viewer || (!text && !gif))
    return sendJson(ctx.res, 400, { error: "bad_request", message: "pass `text` or a Giphy `gif` URL" });
  post({ kind: "message", person: personName(viewer), text: text ?? "", ...(gif ? { gif } : {}) });
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true, feed: state.feed.slice(-80) });
}

async function seedFeed(ctx: ApiCtx): Promise<void> {
  const b = isObj(ctx.body) ? ctx.body : {};
  const items = Array.isArray(b.items) ? b.items : [];
  const now = Date.now();
  for (const raw of items.slice(0, 100)) {
    if (!isObj(raw)) continue;
    const kind = raw.kind === "points" || raw.kind === "message" ? raw.kind : "system";
    const text = str(raw.text, 500) ?? "";
    const person = str(raw.person, 60);
    const points = Number(raw.points);
    const minutesAgo = Math.max(0, Number(raw.minutesAgo) || 0);
    const gif = typeof raw.gif === "string" && GIF_PATTERN.test(raw.gif) ? raw.gif : undefined;
    post({
      kind,
      text,
      ...(gif ? { gif } : {}),
      at: now - minutesAgo * 60_000,
      ...(person ? { person } : {}),
      ...(kind === "points" && Number.isFinite(points) ? { points } : {}),
    });
  }
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true });
}

async function reset(ctx: ApiCtx): Promise<void> {
  const keepPeople = isObj(ctx.body) && ctx.body.keepPeople === true;
  state = { ...emptyState(), people: keepPeople ? state.people : [] };
  await persist(ctx);
  sendJson(ctx.res, 200, { ok: true });
}

export const missionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/missions", auth: "either", handle: withBoard(getMissions) },
  { method: "POST", path: "/v1/missions", auth: "either", handle: withBoard(createMission) },
  { method: "POST", path: "/v1/missions/people", auth: "either", handle: withBoard(setPeople) },
  { method: "POST", path: "/v1/missions/reset", auth: "either", handle: withBoard(reset) },
  { method: "POST", path: "/v1/missions/chat", auth: "either", handle: withBoard(chat) },
  { method: "POST", path: "/v1/missions/feed", auth: "either", handle: withBoard(seedFeed) },
  { method: "POST", path: "/v1/missions/:id/answer", auth: "either", handle: withBoard(answerMission) },
  { method: "POST", path: "/v1/missions/:id/session", auth: "either", handle: withBoard(linkSession) },
  { method: "POST", path: "/v1/missions/:id/skip", auth: "either", handle: withBoard(skipMission) },
  { method: "POST", path: "/v1/missions/:id/score", auth: "either", handle: withBoard(scoreMission) },
  { method: "POST", path: "/v1/missions/:id/complete", auth: "either", handle: withBoard(completeMission) },
];
