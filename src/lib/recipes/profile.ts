// src/lib/recipes/profile.ts
import type { PageProfile } from "./types";

const HASH_CLASS = [/^css-[a-z0-9]{5,}$/i, /^sc-[a-zA-Z0-9]{5,}$/, /^[a-z][\w]*_[a-z0-9]{5,}$/i];

export function detectPageProfile(root: ParentNode): PageProfile {
  if (root.querySelector('[role="grid"],[role="row"],[role="gridcell"],[aria-colindex]')) {
    return "spa-grid";
  }
  const sample = [...root.querySelectorAll("[class]")].slice(0, 50);
  if (sample.length) {
    const hashed = sample.filter((el) =>
      [...el.classList].some((c) => HASH_CLASS.some((re) => re.test(c))),
    );
    if (hashed.length / sample.length > 0.3) return "spa-grid";
  }
  return "classic";
}
