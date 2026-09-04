/** True only for absolute http(s) URLs. Model-sourced hrefs must pass this before becoming <a>. */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
