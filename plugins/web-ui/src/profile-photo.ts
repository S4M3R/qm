import { html, nothing, type TemplateResult } from "lit";
import { api, ApiError } from "./core-bridge";

const PHOTO_SIZE = 256;

export const profilePhotoState = {
  mine: null as string | null,
  saving: false,
  error: "",
};

const listeners = new Set<() => void>();

export function onProfilePhotoChange(listener: () => void): void {
  listeners.add(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export async function loadProfilePhoto(): Promise<void> {
  try {
    const r = await api<{ photo: string | null }>("/api/profile-photo");
    profilePhotoState.mine = r.photo;
  } catch {
    profilePhotoState.mine = null;
  }
  notify();
}

async function squareDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't process images.");
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) * 0.25;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.86);
}

async function savePhoto(photo: string | null): Promise<void> {
  profilePhotoState.saving = true;
  profilePhotoState.error = "";
  notify();
  try {
    const r = await api<{ photo: string | null }>("/api/profile-photo", {
      method: "POST",
      body: JSON.stringify({ photo }),
    });
    profilePhotoState.mine = r.photo;
  } catch (e) {
    profilePhotoState.error = e instanceof ApiError ? e.message : "Couldn't save your photo. Try again.";
  } finally {
    profilePhotoState.saving = false;
    notify();
  }
}

export async function uploadProfilePhoto(file: File): Promise<void> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    profilePhotoState.error = "Choose a PNG, JPEG, or WebP image.";
    notify();
    return;
  }
  try {
    await savePhoto(await squareDataUrl(file));
  } catch (e) {
    profilePhotoState.error = e instanceof Error ? e.message : "Couldn't read that image.";
    notify();
  }
}

export function removeProfilePhoto(): Promise<void> {
  return savePhoto(null);
}

export function avatarTpl(name: string, photo: string | null | undefined, className: string): TemplateResult {
  if (photo) return html`<img class="${className} has-photo" src=${photo} alt="" />`;
  return html`<span class=${className} aria-hidden="true">${name.trim().slice(0, 1).toUpperCase()}</span>`;
}

function uploadLabel(saving: boolean, hasPhoto: boolean): string {
  if (saving) return "Saving…";
  return hasPhoto ? "Change photo" : "Upload photo";
}

export function profilePhotoSettingsRow(name: string): TemplateResult {
  const { mine, saving, error } = profilePhotoState;
  return html`<div class="settings-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">Profile picture</div>
      <div class="settings-row-note">Teammates see it next to your name in QM, like on the Missions leaderboard.</div>
      ${error ? html`<span class="settings-row-error">${error}</span>` : nothing}
    </div>
    <div class="settings-photo">
      ${avatarTpl(name, mine, "settings-photo-avatar")}
      <label class="btn ${saving ? "disabled" : ""}">
        <span>${uploadLabel(saving, Boolean(mine))}</span>
        <input
          class="settings-photo-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          ?disabled=${saving}
          @change=${(e: Event) => {
            const input = e.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            input.value = "";
            if (file) void uploadProfilePhoto(file);
          }}
        />
      </label>
      ${
        mine
          ? html`<button class="btn" type="button" ?disabled=${saving} @click=${() => void removeProfilePhoto()}>
              Remove
            </button>`
          : nothing
      }
    </div>
  </div>`;
}
