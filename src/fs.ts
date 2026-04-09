export async function readJsonFile<T>(path: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

export async function writeJsonFile(path: URL, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
