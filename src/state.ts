import { api } from "./api";
import type { AppInfo, Project, Tree } from "./types";
import { debounce, showError } from "./ui";

export const S = {
  info: null as AppInfo | null,
  dir: "",
  project: null as Project | null,
  tree: { data: [], figures: [], tex: [] } as Tree,
};

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Handler[]>();

export function on(event: string, fn: Handler): void {
  handlers.set(event, [...(handlers.get(event) ?? []), fn]);
}

export function emit(event: string, payload?: unknown): void {
  for (const fn of handlers.get(event) ?? []) fn(payload);
}

export function setStatus(text: string, kind: "" | "busy" | "ok" | "error" = ""): void {
  emit("status", { text, kind });
}

const flush = debounce(() => {
  if (S.dir && S.project) api.projectSave(S.dir, S.project).catch(showError);
}, 300);

export function saveProject(): void {
  flush();
}

export async function refreshTree(): Promise<void> {
  if (!S.dir) return;
  S.tree = await api.projectTree(S.dir);
  emit("tree");
}

export function newId(prefix: string, used: string[]): string {
  for (let i = 1; ; i++) if (!used.includes(`${prefix}${i}`)) return `${prefix}${i}`;
}
