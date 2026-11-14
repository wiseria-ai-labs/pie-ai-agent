// 2.0 overlay — `propose_rewrite`.
//
// Exists because the write-back contract needs a *clean* string. Scraping a
// rewrite out of the assistant's prose ("好的，改写如下：…") is unreliable, and
// whatever ends up in the card is what gets written into the user's page
// verbatim. A tool call carries exactly the text to write.
//
// class = read: the tool itself never touches the page. The actual write
// happens when the user clicks 替换原文 — a plain user action on the content
// script (verify original → execCommand insertText), which is not a tool call
// and therefore not part of any confirm-layer discussion.

import type { Tool } from "../types";

export function buildProposeRewriteTool(): Tool {
  return {
    name: "propose_rewrite",
    description:
      "Propose a rewritten version of the user's selected text. Use ONLY when the user selected editable " +
      "text in an input, textarea or contenteditable region, and the task is to rewrite / polish / " +
      "translate / shorten it in place. The user sees a before/after card with a Replace button that " +
      "writes `text` back into the page. Pass the final text and nothing else — no quotes, no " +
      "'Here is the rewrite:', no explanation. Put any explanation in your ordinary reply instead " +
      "(a short note is welcome; it is rendered above the card). Never call this for read-only page " +
      "content: it cannot be written back.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The rewritten text exactly as it should appear in the user's editor after replacement. " +
            "Plain text only, same language/style constraints the user asked for.",
        },
      },
      required: ["text"],
    },
    handler: async (raw) => {
      const args = (raw ?? {}) as { text?: unknown };
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) {
        return {
          success: false,
          error:
            "propose_rewrite needs a non-empty `text` argument — pass the rewritten text itself.",
        };
      }
      return {
        success: true,
        observation:
          "Rewrite card shown to the user with a Replace button. The user decides whether to write it " +
          "back. Do not repeat the rewritten text in your reply unless the user asks to see it again.",
      };
    },
  };
}
