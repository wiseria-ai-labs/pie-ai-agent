/** Windows skill 脚本解释器：ts/js → 内嵌 Bun，py → 全局 python（排 Store stub），sh 不支持。 */
import { isWindowsAppsStub } from "./user-path-win32";

export const PY_NOT_FOUND_MSG =
  '未找到全局安装的 Python（已排除 Microsoft Store 执行别名）。请从 python.org 安装 Python 时勾选 "Install for all users"（全局安装），沙箱账户才能访问它。';

export const SH_UNSUPPORTED_MSG =
  "Windows 上不支持执行 .sh 脚本；请让该 skill 的作者提供跨平台的 .ts 版本。";

export function pickWindowsPython(candidates: string[]): string | null {
  const real = candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !isWindowsAppsStub(c));
  return real[0] ?? null;
}

export function findWindowsPython(): string | null {
  try {
    const r = Bun.spawnSync(["where.exe", "python"], { windowsHide: true });
    if (r.exitCode !== 0) return null;
    return pickWindowsPython(r.stdout.toString().split(/\r?\n/));
  } catch {
    return null;
  }
}

export function win32Interpreter(
  entry: string,
  findPython: () => string | null = findWindowsPython,
): string[] {
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"];
  if (/\.py$/.test(entry)) {
    const py = findPython();
    if (!py) throw Object.assign(new Error(PY_NOT_FOUND_MSG), { code: "no_python" });
    return [py];
  }
  if (/\.sh$/.test(entry)) {
    throw Object.assign(new Error(SH_UNSUPPORTED_MSG), { code: "unsupported_script" });
  }
  return [process.execPath, "run"];
}
