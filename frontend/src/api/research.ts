import { api } from "./client";

export interface ResearchOptions {
  sentiment: string[]; events: string[]; severity: string[]; scope: string[]; sectors: string[];
}
export interface ResearchStatus {
  role: "A" | "B"; total: number; done: number; prefilled_todo: number; flagged_todo: number;
  today: number; avg_seconds: number | null; options: ResearchOptions;
}
export interface ResearchRow {
  id: string; headline: string; source: string; published_at: string;
  done: boolean; prefilled: boolean; flagged: boolean; sentiment: string | null;
}
export interface Label {
  sentiment: string; events: string[]; severity: string; scope: string;
  companies: string[]; sectors: string[]; notes: string | null;
}
export interface Prelabel {
  sentiment: string; events: string[]; severity: string; scope: string;
  companies?: string[]; sectors?: string[]; model?: string;
}
export interface ReviewFlag { field: keyof Prelabel; suggest: string; level: "rule" | "consider"; reason: string }
export interface ResearchItem {
  item: { id: string; headline: string; source: string; published_at: string };
  index: number; total: number; label: Label | null; prelabel: Prelabel | null; review: ReviewFlag[];
  prev_id: string | null; next_id: string | null; next_todo_id: string | null;
}
export type View = "todo" | "done" | "prefilled" | "flagged" | "all";

export const getResearchStatus = () => api.get<ResearchStatus>("/api/research/status").then((r) => r.data);
export const getResearchItems = (view: View, q: string, offset = 0, limit = 100) =>
  api.get<{ total: number; items: ResearchRow[] }>("/api/research/items", { params: { view, q, offset, limit } })
    .then((r) => r.data);
export const getResearchItem = (id: string) =>
  api.get<ResearchItem>(`/api/research/items/${encodeURIComponent(id)}`).then((r) => r.data);
export const getResearchItemsBatch = (ids: string[]) =>
  api.get<{ items: Record<string, ResearchItem> }>("/api/research/items/batch", { params: { ids: ids.join(",") } })
    .then((r) => r.data.items);
export const saveResearchItem =(id: string, body: Label & { seconds: number; prelabel_shown: boolean }) =>
  api.put(`/api/research/items/${encodeURIComponent(id)}`, body).then((r) => r.data);
export const clearResearchItem = (id: string) =>
  api.delete(`/api/research/items/${encodeURIComponent(id)}`).then((r) => r.data);
export const searchCompanies = (q: string) =>
  api.get<{ results: { symbol: string; name: string }[] }>("/api/research/companies", { params: { q } })
    .then((r) => r.data.results);

export interface AnnotatorUser { id: number; username: string; display_name: string | null; role: "A" | "B" | null }
export const getAnnotators = () =>
  api.get<{ users: AnnotatorUser[]; progress: Record<"A" | "B", { done: number; total: number }> }>(
    "/api/research/annotators").then((r) => r.data);
export const setAnnotator = (user_id: number, role: "A" | "B" | null) =>
  api.put("/api/research/annotators", { user_id, role }).then((r) => r.data);
