import { denoConfigLabel, loadDenoProjectTasks } from "./deno_config.ts";
import { cwdRootUrl } from "./paths.ts";
import { BUILTIN_SERVICE_NAMES, loadProjectManifest } from "./project.ts";

const REQUIRED_DENO_TASKS = ["build", "start", "dev", "check"] as const;
const REQUIRED_TEST_TASKS = ["test", "test:coverage", "test:e2e"] as const;

export async function verifyProject(root: URL = cwdRootUrl()): Promise<void> {
  const manifest = await loadProjectManifest(root);
  await verifyManifestFiles(root, manifest);
  await verifyServiceDbBoundaries(root, manifest);

  await verifyDenoTasks(root);
  await runCommand(root, "deno", ["task", "check"], "deno task check");
}

async function verifyManifestFiles(
  root: URL,
  manifest: Awaited<ReturnType<typeof loadProjectManifest>>,
): Promise<void> {
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

async function verifyDenoTasks(root: URL): Promise<void> {
  const tasks = await loadDenoProjectTasks(root);

  for (const task of [...REQUIRED_DENO_TASKS, ...REQUIRED_TEST_TASKS]) {
    if (!tasks[task]) {
      throw new Error(`Missing required ${denoConfigLabel()} task "${task}".`);
    }
  }
}

async function verifyServiceDbBoundaries(
  root: URL,
  manifest: Awaited<ReturnType<typeof loadProjectManifest>>,
): Promise<void> {
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

async function runCommand(
  root: URL,
  executable: string,
  args: string[],
  description: string,
): Promise<void> {
  const command = new Deno.Command(executable, {
    args,
    cwd: decodeURIComponent(root.pathname),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`Verification failed while running "${description}".`);
  }
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
