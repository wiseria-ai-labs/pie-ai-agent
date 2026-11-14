// Pie 2.0 memory — "used N memories" chip placement.
//
// The chip must sit UNDER the answer, like every other display row the panel
// appends: clients flush the accumulated assistant text into a message when a
// row arrives. So the chip is emitted exactly once, immediately BEFORE the
// turn's terminal event — never at task start (where it would land above the
// answer).

import type { PortMessageToPanel } from "@/types";

type MemoryUsed = Extract<PortMessageToPanel, { type: "memory-used" }>;

const TERMINAL = new Set(["chat-done", "agent-done-task"]);

export function wrapEmitWithMemoryChip(
  emit: (m: PortMessageToPanel) => void,
  chip: MemoryUsed | null,
): (m: PortMessageToPanel) => void {
  if (!chip) return emit;
  let sent = false;
  return (m: PortMessageToPanel): void => {
    if (!sent && TERMINAL.has(m.type)) {
      sent = true;
      emit(chip);
    }
    emit(m);
  };
}
