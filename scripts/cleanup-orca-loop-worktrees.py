#!/usr/bin/env python3
"""Remove leftover Orca worktrees created by pie loop automations.

Only touches automation checkouts (【pie】Step* / auto-pie-* / auto-pr-run-*).
Never removes main, pinned, recently-active, or live-agent worktrees.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from typing import Any

REPO_ID = "59e5f791-6640-4de6-84ff-e20524fcc6f0"
MIN_IDLE_SECONDS = 60 * 60

LOOP_NAME = re.compile(
    r"^(【pie】Step\d|【pie】清理|PR 真机验收 run\b)",
)
LOOP_PATH = re.compile(r"/(auto-pie-|auto-pr-run-)")


def run_orca(*args: str) -> dict[str, Any]:
    proc = subprocess.run(
        ["orca", *args, "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"orca {' '.join(args)} failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
        )
    data = json.loads(proc.stdout)
    if data.get("ok") is False:
        raise RuntimeError(f"orca {' '.join(args)} not ok: {data}")
    return data.get("result") or {}


def is_loop_worktree(wt: dict[str, Any]) -> bool:
    name = wt.get("displayName") or ""
    path = wt.get("path") or ""
    return bool(LOOP_NAME.search(name) or LOOP_PATH.search(path))


def live_index() -> dict[str, dict[str, Any]]:
    try:
        ps = run_orca("worktree", "ps")
    except RuntimeError:
        return {}
    rows = ps.get("worktrees") if isinstance(ps, dict) else ps
    out: dict[str, dict[str, Any]] = {}
    for row in rows or []:
        wid = row.get("worktreeId") or row.get("id")
        if wid:
            out[wid] = row
    return out


def is_busy(wt: dict[str, Any], live: dict[str, dict[str, Any]], now_ms: int) -> str | None:
    if wt.get("isMainWorktree"):
        return "main"
    if wt.get("isPinned"):
        return "pinned"
    last = wt.get("lastActivityAt")
    if isinstance(last, (int, float)) and now_ms - last < MIN_IDLE_SECONDS * 1000:
        return f"active<{MIN_IDLE_SECONDS}s"
    row = live.get(wt.get("id") or "")
    if not row:
        return None
    if row.get("isActive"):
        return "focused"
    if (row.get("liveTerminalCount") or 0) > 0:
        return "live-terminal"
    if row.get("status") in {"working", "running"}:
        return "working"
    for agent in row.get("agents") or []:
        if agent.get("state") in {"working", "running", "active"}:
            return "agent-working"
    return None


def candidates(dry: bool) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    listed = run_orca("worktree", "list", "--repo", f"id:{REPO_ID}")
    wts = listed.get("worktrees") if isinstance(listed, dict) else listed
    live = live_index()
    now_ms = int(time.time() * 1000)
    keep: list[tuple[str, str]] = []
    delete: list[dict[str, Any]] = []
    for wt in wts or []:
        name = wt.get("displayName") or wt.get("path") or "?"
        if not is_loop_worktree(wt):
            keep.append((name, "not-loop"))
            continue
        reason = is_busy(wt, live, now_ms)
        if reason:
            keep.append((name, reason))
            continue
        delete.append(wt)
    return delete, keep


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--has-work",
        action="store_true",
        help="exit 0 if there is something to delete, else 1 (for Orca precheck)",
    )
    args = parser.parse_args()

    delete, keep = candidates(args.dry_run)
    if args.has_work:
        return 0 if delete else 1

    if not delete:
        print("无可清理的 loop worktree")
        return 0

    for wt in delete:
        name = wt.get("displayName")
        path = wt.get("path")
        selector = f"path:{path}"
        print(f"{'DRY ' if args.dry_run else ''}DEL {name} ({path})")
        if args.dry_run:
            continue
        subprocess.run(
            ["orca", "worktree", "rm", "--worktree", selector, "--force", "--json"],
            check=True,
        )
    skipped = ", ".join(f"{n}[{r}]" for n, r in keep if r != "not-loop")
    if skipped:
        print(f"跳过仍在用的 loop: {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
