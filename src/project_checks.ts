import { denoConfigLabel, findDenoProjectConfigFile } from "./deno_config.ts";
import { BUILTIN_SERVICE_NAMES, loadProjectManifest } from "./project.ts";

export const REQUIRED_AGENT_DOCS_PATHS = [
  "AGENTS.md",
  "agent-docs",
  "agent-docs/exec-plans/active",
  "agent-docs/exec-plans/completed",
] as const;
const ALLOWED_ROOT_TEST_DIRS = [
  "e2e",
  "db",
  "bruno",
  "smoke",
  "fixtures",
  "harness",
] as const;
const DISALLOWED_ROOT_TEST_DIRS = ["bruno", "e2e", "test", "integration", "__tests__"] as const;

export async function hasProjectManifest(root: URL): Promise<boolean> {
  try {
    const entry = await Deno.stat(new URL("superstructure.project.json", root));
    return entry.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export async function verifyAgentDocsStructure(root: URL): Promise<void> {
  await requireFile(root, REQUIRED_AGENT_DOCS_PATHS[0]);
  for (const path of REQUIRED_AGENT_DOCS_PATHS.slice(1)) {
    await requireDirectory(root, path);
  }
}

export async function verifyDenoConfig(root: URL): Promise<string> {
  const configFile = await findDenoProjectConfigFile(root);
  if (!configFile) {
    throw new Error(`Missing required ${denoConfigLabel()} at the project root.`);
  }
  return configFile;
}

export async function verifyManifestFiles(root: URL): Promise<void> {
  if (!(await hasProjectManifest(root))) {
    return;
  }

  const manifest = await loadProjectManifest(root);

  for (const service of manifest.services) {
    if (BUILTIN_SERVICE_NAMES.includes(service.name as (typeof BUILTIN_SERVICE_NAMES)[number])) {
      throw new Error(
        `Built-in service "${service.name}" must not be declared in superstructure.project.json.`,
      );
    }
    await requireDirectory(root, service.directory);
    await requireFile(root, `${service.directory}/index.ts`);
    await requireDirectory(root, `${service.directory}/db`);
    await requireDirectory(root, `${service.directory}/db/queries`);
    await requireDirectory(root, `${service.directory}/db/schema`);
    await requireFile(root, `${service.directory}/db/index.ts`);
    await requireFile(root, `${service.directory}/db/queries/index.ts`);
    await requireFile(root, `${service.directory}/db/schema/index.ts`);
  }

  for (const surface of manifest.surfaces) {
    await requireDirectory(root, surface.directory);
    await requireFile(root, `${surface.directory}/index.ts`);
  }
}

export async function verifyServiceDbBoundaries(root: URL): Promise<void> {
  if (!(await hasProjectManifest(root))) {
    return;
  }

  const manifest = await loadProjectManifest(root);
  const platformDbRoot = new URL("apps/server/src/api/db/", root).pathname;

  for (const service of manifest.services) {
    const serviceRoot = new URL(`${service.directory}/`, root);
    const serviceDbRoot = new URL(`${service.directory}/db/`, root).pathname;
    const sourceFiles = await collectSourceFiles(serviceRoot);

    for (const file of sourceFiles) {
      const specifiers = extractModuleSpecifiers(await Deno.readTextFile(file));

      for (const specifier of specifiers) {
        if (specifier.includes("apps/server/src/api/db/")) {
          throw new Error(
            `Custom service "${service.name}" must not import platform DB internals: ${specifier}`,
          );
        }

        if (!specifier.startsWith(".")) {
          continue;
        }

        const resolvedPath = new URL(specifier, file).pathname;
        if (resolvedPath.startsWith(platformDbRoot)) {
          throw new Error(
            `Custom service "${service.name}" must not import platform DB internals from "${
              pathRelativeToRoot(root, file)
            }".`,
          );
        }

        if (resolvedPath.startsWith(serviceDbRoot)) {
          continue;
        }

        const foreignService = manifest.services.find((entry) =>
          entry.name !== service.name &&
          resolvedPath.startsWith(new URL(`${entry.directory}/db/`, root).pathname)
        );
        if (foreignService) {
          throw new Error(
            `Custom service "${service.name}" must not import DB modules from service "${foreignService.name}".`,
          );
        }
      }
    }
  }
}

export async function verifyTestLayout(root: URL): Promise<void> {
  const issues = await listTestLayoutIssues(root);
  if (issues.length > 0) {
    throw new Error(issues[0]);
  }
}

export async function listTestLayoutIssues(root: URL): Promise<string[]> {
  const issues: string[] = [];

  for (const relativePath of DISALLOWED_ROOT_TEST_DIRS) {
    const entry = await statPathIfExists(root, relativePath);
    if (entry?.isDirectory) {
      issues.push(
        `Repo-root "${relativePath}/" is not allowed. Move it under "tests/" and use one of tests/{${
          ALLOWED_ROOT_TEST_DIRS.join(",")
        }}/.`,
      );
    }
  }

  const testsEntry = await statPathIfExists(root, "tests");
  if (!testsEntry) {
    return issues;
  }
  if (!testsEntry.isDirectory) {
    issues.push('Expected "tests" to be a directory.');
    return issues;
  }

  for await (const entry of Deno.readDir(new URL("tests/", root))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (!entry.isDirectory) {
      issues.push(
        `Repo-root tests must organize files under tests/{${
          ALLOWED_ROOT_TEST_DIRS.join(",")
        }}/. Found "tests/${entry.name}".`,
      );
      continue;
    }

    if (!ALLOWED_ROOT_TEST_DIRS.includes(entry.name as (typeof ALLOWED_ROOT_TEST_DIRS)[number])) {
      issues.push(
        `Repo-root "tests/${entry.name}/" is not allowed. Use one of tests/{${
          ALLOWED_ROOT_TEST_DIRS.join(",")
        }}/.`,
      );
    }
  }

  return issues;
}

async function requireFile(root: URL, relativePath: string): Promise<void> {
  const entry = await statPath(root, relativePath);
  if (!entry.isFile) {
    throw new Error(`Expected file at "${relativePath}".`);
  }
}

async function requireDirectory(root: URL, relativePath: string): Promise<void> {
  const entry = await statPath(root, relativePath);
  if (!entry.isDirectory) {
    throw new Error(`Expected directory at "${relativePath}".`);
  }
}

async function statPath(root: URL, relativePath: string): Promise<Deno.FileInfo> {
  try {
    return await Deno.stat(new URL(relativePath, root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing required path "${relativePath}".`);
    }
    throw error;
  }
}

async function statPathIfExists(root: URL, relativePath: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(new URL(relativePath, root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function collectSourceFiles(root: URL): Promise<URL[]> {
  const files: URL[] = [];

  for await (const entry of Deno.readDir(root)) {
    const entryUrl = new URL(entry.name, root);
    if (entry.isDirectory) {
      files.push(...await collectSourceFiles(new URL(`${entry.name}/`, root)));
      continue;
    }

    if (entry.isFile && /\.(?:[cm]?ts|tsx)$/u.test(entry.name)) {
      files.push(entryUrl);
    }
  }

  return files;
}

function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function pathRelativeToRoot(root: URL, file: URL): string {
  const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  return decodeURIComponent(file.pathname.slice(rootPath.length));
}
