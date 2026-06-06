// src/lib/recipes/paginate.ts
import type { PaginationSpec, StopCondition } from "./types";
import { resolveOne } from "./locator";

export interface PaginationState {
  pageCount: number;
  lastPageNewRows: number;
  hasNext: boolean;
}

export function shouldContinue(state: PaginationState, stop: StopCondition): boolean {
  if (stop.maxPages != null && state.pageCount >= stop.maxPages) return false;
  if (stop.untilNoNewRows && state.lastPageNewRows === 0) return false;
  if (stop.untilNoNext && !state.hasNext) return false;
  return true;
}

export function nextUrl(urlTemplate: string, n: number): string {
  return urlTemplate.replace("{n}", String(n));
}

export function resolveNext(root: ParentNode, p: PaginationSpec): Element | null {
  if (p.mode === "url-param") return null;
  return p.next ? resolveOne(root, p.next) : null;
}
