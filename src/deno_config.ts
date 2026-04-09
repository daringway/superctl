import { parse as parseJsonc } from "@std/jsonc";

export interface DenoTaskDefinition {
  command?: string;
  dependencies?: string[];
  description?: string;
}

export interface DenoProjectConfig {
  imports?: Record<string, string>;
  superstructure?: {
    platformRoot?: string;
  };
  tasks?: Record<string, string | DenoTaskDefinition>;
}

const DENO_CONFIG_FILES = ["deno.json", "deno.jsonc"] as const;

export async function findDenoProjectConfigFile(root: URL): Promise<string | null> {
  for (const fileName of DENO_CONFIG_FILES) {
    try {
      const entry = await Deno.stat(new URL(fileName, root));
      if (entry.isFile) {
        return fileName;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function loadDenoProjectConfig(root: URL): Promise<DenoProjectConfig | null> {
  for (const fileName of DENO_CONFIG_FILES) {
    try {
      const source = await Deno.readTextFile(new URL(fileName, root));
      return parseJsonc(source) as DenoProjectConfig;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

export async function loadDenoProjectTasks(root: URL): Promise<Record<string, string>> {
  const config = await loadDenoProjectConfig(root);
  if (!config?.tasks) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(config.tasks).map(([name, task]) => [
      name,
      typeof task === "string" ? task : task.command ?? "",
    ]),
  );
}

export function denoConfigLabel(): string {
  return "deno.json or deno.jsonc";
}
