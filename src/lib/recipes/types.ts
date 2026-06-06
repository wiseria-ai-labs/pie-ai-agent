// src/lib/recipes/types.ts
export type SignalKind =
  | "testid" | "id" | "name" | "aria-label"
  | "role+name" | "text"
  | "class" | "column" | "nth";

export interface LocatorSignal {
  kind: SignalKind;
  /** CSS selector for selector-kinds; text for "text"; "role|name" for "role+name"; header name for "column". */
  value: string;
  stable: boolean;
}

export interface MultiSignalLocator {
  /** ranked; resolve tries in order until one hits. */
  signals: LocatorSignal[];
}

export type PageProfile = "classic" | "spa-grid";

export interface FieldSpec {
  name: string;
  /** resolved RELATIVE to a row element */
  locator: MultiSignalLocator;
  /** if set, read this attribute instead of textContent */
  attr?: string;
}

export interface PaginationSpec {
  mode: "next-button" | "load-more" | "infinite-scroll" | "url-param";
  next?: MultiSignalLocator;   // next-button / load-more
  urlTemplate?: string;        // url-param, contains "{n}"
}

export interface StopCondition {
  maxPages?: number;
  untilNoNext?: boolean;
  untilNoNewRows?: boolean;
}

export interface RowValidity {
  minCells?: number;
  requireFields?: string[];
}

export interface ExtractionSpec {
  container: MultiSignalLocator;
  rowLocator: MultiSignalLocator;   // resolved within container
  fields: FieldSpec[];
  rowValidity?: RowValidity;
  pagination: PaginationSpec;
  stopCondition: StopCondition;
}

export type RecordRow = Record<string, string>;

export interface RunResult {
  recipeId: string;
  runAt: number;
  params: Record<string, string>;
  sourceUrl: string;
  pageCount: number;
  schema: { name: string; type: string }[];
  records: RecordRow[];
}
