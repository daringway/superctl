export function cwdRootUrl(cwd = Deno.cwd()): URL {
  const normalized = cwd.replace(/\\/gu, "/");
  return new URL(`file://${normalized.endsWith("/") ? normalized : `${normalized}/`}`);
}
