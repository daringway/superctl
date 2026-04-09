import { readJsonFile, writeJsonFile } from "./fs.ts";

export interface ProjectManifest {
  schemaVersion: 1;
  services: Array<{ name: string; directory: string; enabled: boolean }>;
  surfaces: Array<{
    name: string;
    directory: string;
    path: string;
    enabled: boolean;
    rootEligible: boolean;
  }>;
  deployment: {
    rootSurface: string;
  };
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MANIFEST_FILE = "superstructure.project.json";
export const BUILTIN_SERVICE_NAMES = ["auth", "users", "system", "platform"] as const;

export function assertValidModuleName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid module name "${name}". Expected kebab-case.`);
  }
}

export function assertValidCustomServiceName(name: string): void {
  assertValidModuleName(name);
  if (BUILTIN_SERVICE_NAMES.includes(name as (typeof BUILTIN_SERVICE_NAMES)[number])) {
    throw new Error(
      `Service "${name}" is built in and must not be scaffolded in a project manifest.`,
    );
  }
}

export async function loadProjectManifest(root: URL): Promise<ProjectManifest> {
  return await readJsonFile<ProjectManifest>(new URL(MANIFEST_FILE, root));
}

export async function saveProjectManifest(root: URL, manifest: ProjectManifest): Promise<void> {
  await writeJsonFile(new URL(MANIFEST_FILE, root), manifest);
}

export async function ensureProjectStructure(root: URL): Promise<ProjectManifest> {
  const manifestPath = new URL(MANIFEST_FILE, root);
  let manifest: ProjectManifest;

  try {
    manifest = await readJsonFile<ProjectManifest>(manifestPath);
  } catch {
    manifest = {
      schemaVersion: 1,
      services: [],
      surfaces: [],
      deployment: {
        rootSurface: "site",
      },
    };
    await saveProjectManifest(root, manifest);
  }

  await Deno.mkdir(new URL("superstructure/services/", root), { recursive: true });
  await Deno.mkdir(new URL("superstructure/surfaces/", root), { recursive: true });
  await Deno.mkdir(new URL("superstructure/generated/", root), { recursive: true });

  return manifest;
}

export function toServiceSymbol(name: string): string {
  return `${toPascalCase(name)}ServiceModule`;
}

export function toServiceDbSymbol(name: string): string {
  return `${toCamelCase(name)}ServiceDb`;
}

export function toServiceDatabaseType(name: string): string {
  return `${toPascalCase(name)}Database`;
}

export function toServiceSchemaSymbol(name: string): string {
  return `${toCamelCase(name)}Schema`;
}

export function toSurfaceSymbol(name: string): string {
  return `${toPascalCase(name)}SurfaceModule`;
}

export function serviceDirectory(name: string): string {
  return `superstructure/services/${name}`;
}

export function surfaceDirectory(name: string): string {
  return `superstructure/surfaces/${name}`;
}

export async function regenerateProjectRegistries(
  root: URL,
  manifest: ProjectManifest,
): Promise<void> {
  const serviceImports = manifest.services
    .map(
      (entry) =>
        `import { ${toServiceSymbol(entry.name)} } from '../services/${entry.name}/index.ts';`,
    )
    .join("\n");
  const surfaceImports = manifest.surfaces
    .map(
      (entry) =>
        `import { ${toSurfaceSymbol(entry.name)} } from '../surfaces/${entry.name}/index.ts';`,
    )
    .join("\n");

  const serviceEntries = manifest.services.map((entry) => toServiceSymbol(entry.name)).join(", ");
  const surfaceEntries = manifest.surfaces.map((entry) => toSurfaceSymbol(entry.name)).join(", ");

  await Deno.writeTextFile(
    new URL("superstructure/generated/services.ts", root),
    `${serviceImports}\n\nexport const serviceModules = [${serviceEntries}] as const;\n`,
  );
  await Deno.writeTextFile(
    new URL("superstructure/generated/service-db-schema.ts", root),
    manifest.services.length === 0 ? "// Generated service DB schema registry.\n" : [
      "// Generated service DB schema registry.",
      ...manifest.services.map((entry) =>
        `export * from '../services/${entry.name}/db/schema/index.ts';`
      ),
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL("superstructure/generated/surfaces.ts", root),
    `${surfaceImports}\n\nexport const surfaceModules = [${surfaceEntries}] as const;\n`,
  );
}

function toPascalCase(value: string): string {
  return value
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
}

function toCamelCase(value: string): string {
  const pascalCase = toPascalCase(value);
  return pascalCase.length === 0
    ? pascalCase
    : `${pascalCase[0]!.toLowerCase()}${pascalCase.slice(1)}`;
}
