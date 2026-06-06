// src/lib/recipes/recipe-types.ts
import type { MultiSignalLocator, ExtractionSpec } from "./types";

export interface ActionStep {
  type: "click" | "type" | "select" | "navigate" | "submit";
  /** click/type/select/submit: target element locator. */
  locator?: MultiSignalLocator;
  /** type/select value; may contain {{paramName}} (V1c). */
  value?: string;
  /** navigate target URL; may contain {{paramName}} (V1c). */
  url?: string;
}

export interface RecipeParam {
  name: string;
  type: "string";
  default?: string;
}

export interface Recipe {
  id: string;
  name: string;
  createdAt: number;
  author: "llm" | "recording" | "conversational";
  /** Glob/substring match against the current tab URL at run time. */
  targetUrlPattern: string;
  /** V1b: ordered deterministic pre-extraction action sequence. */
  actionPrelude?: ActionStep[];
  /** V1c: parameterized values for actionPrelude steps. */
  parameters?: RecipeParam[];
  extraction: ExtractionSpec;
  outputSchema: { name: string; type: string }[];
}
