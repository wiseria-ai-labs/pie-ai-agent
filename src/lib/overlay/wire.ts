// The overlay's LLM-facing wire text for a turn.
//
// The selection rides in an untrusted wrapper (page text is data, never
// instructions) and the user's typed instruction stays outside it. Mirrors the
// side panel's quote-wrapping order.

import type { OverlaySelection } from "./protocol";

export function escapeWrapperAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function buildOverlayWireContent(
  instruction: string,
  selection: OverlaySelection | null,
): string {
  if (!selection || !selection.text) return instruction;
  const attrs = `source_url="${escapeWrapperAttribute(selection.url)}" editable="${selection.editable}"`;
  return `<untrusted_page_selection ${attrs}>\n${selection.text}\n</untrusted_page_selection>\n\n${instruction}`;
}
