// The overlay's LLM-facing wire text for a turn.
//
// The selection rides in the SAME untrusted wrapper the side panel uses for
// quotes (`untrusted_page_quote`, registered in UNTRUSTED_WRAPPER_TAGS and its
// inline dual-list copies), and the user's typed instruction stays outside it.
//
// Both escape families are applied to the selection body: page text must never
// close the wrapper it rides in (`</untrusted_page_quote>`), close the trusted
// task block around it (`</user_task>`), or forge a trusted runtime marker
// (`<system_notice>`). The attribute goes through the shared
// escapeWrapperAttribute. Do NOT add a new wrapper tag here — an unregistered
// tag is invisible to every escape path and becomes an injection primitive.

import {
  escapeTrustedWrappers,
  escapeUntrustedWrappers,
  escapeWrapperAttribute,
} from "@/lib/agent/untrusted-wrappers";
import type { OverlaySelection } from "./protocol";

export function buildOverlayWireContent(
  instruction: string,
  selection: OverlaySelection | null,
): string {
  if (!selection || !selection.text.trim()) return instruction;
  const body = escapeTrustedWrappers(escapeUntrustedWrappers(selection.text));
  const quote =
    `<untrusted_page_quote source_url="${escapeWrapperAttribute(selection.url)}">\n` +
    `${body}\n</untrusted_page_quote>`;
  return `${quote}\n\n${instruction}`;
}
