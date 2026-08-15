/** macOS / linux skill 脚本解释器：ts/js → 内嵌 Bun，py → python3，sh → bash。 */

export function darwinInterpreter(entry: string): string[] {
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) return [process.execPath, "run"];
  if (/\.py$/.test(entry)) return ["python3"];
  if (/\.sh$/.test(entry)) return ["bash"];
  return [process.execPath, "run"];
}
