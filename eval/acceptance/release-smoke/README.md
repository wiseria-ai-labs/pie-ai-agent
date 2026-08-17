# 发版真机冒烟

打 tag 之前跑。清单权威源：`docs/specs/2026-08-17-release-smoke-checklist.md`。
配方坑（扩展 ID、seed 时序、socket 路径、locale）见 `docs/agents/auto-acceptance.md`。

## 跑

```bash
# 1. 构建
pnpm build:eval    # F / L 批
pnpm build         # P 批（生产包、无 eval bridge）

# 2. 短工作目录（daemon unix socket 受 macOS sun_path 104 字节上限）
export PIE_ACCEPT_BASE=/tmp/piesmoke

# 3. 冒烟模型（F07+ / L / P02 需要）。缺 key 时这些项记 ERROR（环境），不挡 tag
#    文件 chmod 600，键名与 eval harness 相同：
#    PIE_EVAL_PROVIDER / PIE_EVAL_MODEL / PIE_EVAL_API_KEY
#    也可直接 export 这三项。

pnpm smoke:release
```

报告：`$PIE_ACCEPT_BASE/report/report.md` + `results.json` + 截图。

## 闸

- F / P 的 FAIL 或非环境 ERROR → 退出码 1，不能打 tag
- 缺 key / daemon 没起来 / 没 build → ERROR（环境），报告里分开写
- L 失败人看 trace：产品坏了才挡

不要把这套东西挂进 GitHub Actions，也不要挡日常功能 PR 的 CI。
