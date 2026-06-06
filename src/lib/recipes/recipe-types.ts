// src/lib/recipes/recipe-types.ts
import type { ExtractionSpec } from "./types";

export interface Recipe {
  id: string;
  name: string;
  createdAt: number;
  author: "llm" | "recording" | "conversational";
  /** Glob/substring match against the current tab URL at run time. */
  targetUrlPattern: string;
  extraction: ExtractionSpec;
  outputSchema: { name: string; type: string }[];
}
