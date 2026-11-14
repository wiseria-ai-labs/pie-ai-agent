import { attachSelectionListener } from "./selection-listener";
import { enterPicker, exitPicker } from "./element-picker";
import { attachOverlayContentScript } from "@/content/overlay";

attachSelectionListener();
attachOverlayContentScript();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { type?: string };
  if (m.type === "picker:enter") enterPicker();
  else if (m.type === "picker:exit") exitPicker();
});
