import { createMemoryMap, type DurableMap } from "../../persistence/durable-map.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

export interface ProfilePhotoDoc {
  photo: string;
  updatedAt: number;
}

const MAX_PHOTO_CHARS = 400_000;
const PHOTO_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const fallbackPhotos = createMemoryMap<ProfilePhotoDoc>();

function store(ctx: ApiCtx): DurableMap<ProfilePhotoDoc> {
  return ctx.deps.profilePhotos ?? fallbackPhotos;
}

function key(principal: string): string {
  return principal.trim().toLowerCase();
}

export async function profilePhotos(ctx: ApiCtx, principals: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(principals.map(key).filter(Boolean))].slice(0, 100);
  const docs = await Promise.all(unique.map((principal) => store(ctx).get(principal)));
  unique.forEach((principal, i) => {
    const doc = docs[i];
    if (doc?.photo) out.set(principal, doc.photo);
  });
  return out;
}

function principalOf(ctx: ApiCtx): string | null {
  if (ctx.capability?.actorId) return ctx.capability.actorId;
  if (ctx.auth) return ctx.url.searchParams.get("principalId");
  return null;
}

async function getPhoto(ctx: ApiCtx): Promise<void> {
  const principal = principalOf(ctx);
  if (!principal) return sendJson(ctx.res, 400, { error: "bad_request", message: "no principal" });
  const doc = await store(ctx).get(key(principal));
  sendJson(ctx.res, 200, { principal, photo: doc?.photo ?? null });
}

async function listPhotos(ctx: ApiCtx): Promise<void> {
  const wanted = (ctx.url.searchParams.get("principals") ?? "").split(",");
  const photos = await profilePhotos(ctx, wanted);
  sendJson(ctx.res, 200, { photos: Object.fromEntries(photos) });
}

async function setPhoto(ctx: ApiCtx): Promise<void> {
  const principal = principalOf(ctx);
  if (!principal) return sendJson(ctx.res, 400, { error: "bad_request", message: "no principal" });
  const b = isObj(ctx.body) ? ctx.body : {};
  if (b.photo === null) {
    await store(ctx).delete(key(principal));
    return sendJson(ctx.res, 200, { ok: true, photo: null });
  }
  const photo = typeof b.photo === "string" ? b.photo : "";
  if (!PHOTO_PATTERN.test(photo)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "photo must be a PNG, JPEG, or WebP data URL" });
  }
  if (photo.length > MAX_PHOTO_CHARS) {
    return sendJson(ctx.res, 413, {
      error: "too_large",
      message: "photo is too large; use an image under about 300 KB",
    });
  }
  await store(ctx).put(key(principal), { photo, updatedAt: Date.now() });
  sendJson(ctx.res, 200, { ok: true, photo });
}

export const profilePhotoRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/profile-photo", auth: "either", handle: getPhoto },
  { method: "GET", path: "/v1/profile-photos", auth: "either", handle: listPhotos },
  { method: "POST", path: "/v1/profile-photo", auth: "either", handle: setPhoto },
];
