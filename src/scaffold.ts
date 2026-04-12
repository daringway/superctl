import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cwdRootUrl } from "./paths.ts";
import { writeJsonFile } from "./fs.ts";
import {
  assertValidCustomServiceName,
  assertValidModuleName,
  ensureProjectStructure,
  regenerateProjectRegistries,
  saveProjectManifest,
  serviceDirectory,
  surfaceDirectory,
  toServiceDatabaseType,
  toServiceDbSymbol,
  toServiceSchemaSymbol,
  toServiceSymbol,
  toSurfaceSymbol,
} from "./project.ts";

export async function initProject(root: URL = cwdRootUrl()): Promise<void> {
  await assertProjectNotInitialized(root);
  const projectName = resolveProjectName(root);
  const platformRoot = await resolveStarterPlatformRoot(root);

  await writeStarterDenoConfig(root, platformRoot);
  await writeStarterAgentDocs(root);
  await writeStarterQualityWorkflow(root);
  await writeStarterScripts(root, projectName, platformRoot);
  await writeStarterTests(root, projectName, platformRoot);
  await addStarterSiteSurface(projectName, root);
}

export async function addService(name: string, root: URL = cwdRootUrl()): Promise<void> {
  assertValidCustomServiceName(name);
  const manifest = await ensureProjectStructure(root);
  if (manifest.services.some((entry) => entry.name === name)) {
    throw new Error(`Service "${name}" already exists.`);
  }

  const directory = `${serviceDirectory(name)}/`;
  await Deno.mkdir(new URL(directory, root), { recursive: true });

  const symbol = toServiceSymbol(name);
  const serviceDbSymbol = toServiceDbSymbol(name);
  const databaseType = toServiceDatabaseType(name);
  const serviceSchemaSymbol = toServiceSchemaSymbol(name);
  const registerFunction = `register${
    toServiceSymbol(name).replace(/ServiceModule$/u, "ServiceRoutes")
  }`;
  await Deno.writeTextFile(
    new URL(`${directory}index.ts`, root),
    [
      "import type { ApiServiceModule } from '@daringway/superstructure-runtime';",
      "",
      `import { ${serviceDbSymbol} } from './db/index.ts';`,
      `import { ${registerFunction} } from './routes.ts';`,
      "",
      `export const ${symbol}: ApiServiceModule = {`,
      `  name: '${name}',`,
      `  serviceDb: ${serviceDbSymbol},`,
      "  registerRoutes(options) {",
      `    ${registerFunction}(options as Parameters<typeof ${registerFunction}>[0]);`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}routes.ts`, root),
    [
      "import type { Hono } from 'hono';",
      "import type { ApiEnv, EndpointRegistry } from '@daringway/superstructure-runtime';",
      "",
      `import type { ${databaseType} } from './db/index.ts';`,
      "",
      `export interface ${registerFunction[0]!.toUpperCase()}${registerFunction.slice(1)}Options {`,
      "  app: Hono<ApiEnv>;",
      "  endpointRegistry: EndpointRegistry;",
      "  env: Record<string, string | undefined>;",
      "  mode: string;",
      "  prefix: string;",
      `  serviceDb: ${databaseType} | null;`,
      "}",
      "",
      `export function ${registerFunction}(_options: ${registerFunction[0]!.toUpperCase()}${
        registerFunction.slice(1)
      }Options): void {`,
      "  // Add service endpoints here.",
      "}",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}service.ts`, root),
    [
      "export function notImplementedYet(): never {",
      "  throw new Error('Not implemented.');",
      "}",
      "",
    ].join("\n"),
  );
  await Deno.mkdir(new URL(`${directory}db/schema/`, root), { recursive: true });
  await Deno.mkdir(new URL(`${directory}db/queries/`, root), { recursive: true });
  await Deno.writeTextFile(
    new URL(`${directory}db/index.ts`, root),
    [
      "import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';",
      "import {",
      "  deriveServiceSchemaName,",
      "  type ApiServiceDbDescriptor,",
      "} from '@daringway/superstructure-runtime';",
      "",
      "import * as schema from './schema/index.ts';",
      "",
      "export * from './queries/index.ts';",
      "export * from './schema/index.ts';",
      "",
      `export const ${serviceDbSymbol}: ApiServiceDbDescriptor<typeof schema> = {`,
      `  schemaName: deriveServiceSchemaName('${name}'),`,
      "  schema,",
      "};",
      "",
      `export type ${databaseType} = PostgresJsDatabase<typeof schema>;`,
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}db/schema/index.ts`, root),
    [
      "import { pgSchema } from 'drizzle-orm/pg-core';",
      "import { deriveServiceSchemaName } from '@daringway/superstructure-runtime';",
      "",
      `export const ${serviceSchemaSymbol} = pgSchema(deriveServiceSchemaName('${name}'));`,
      "",
      "// Add service-owned tables here.",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}db/queries/index.ts`, root),
    [
      "// Add service-local query helpers here.",
      "",
    ].join("\n"),
  );

  manifest.services.push({
    name,
    directory: serviceDirectory(name),
    enabled: true,
  });
  await saveProjectManifest(root, manifest);
  await regenerateProjectRegistries(root, manifest);
}

async function assertProjectNotInitialized(root: URL): Promise<void> {
  const manifestPath = new URL("superstructure.project.json", root);

  try {
    const manifestInfo = await Deno.stat(manifestPath);
    if (manifestInfo.isFile) {
      throw new Error("Current directory is already initialized for Superstructure.");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

export async function addSurface(name: string, root: URL = cwdRootUrl()): Promise<void> {
  assertValidModuleName(name);
  const manifest = await ensureProjectStructure(root);
  if (manifest.surfaces.some((entry) => entry.name === name)) {
    throw new Error(`Surface "${name}" already exists.`);
  }

  const directory = `${surfaceDirectory(name)}/`;
  await Deno.mkdir(new URL(directory, root), { recursive: true });

  const symbol = toSurfaceSymbol(name);
  const createFunction = `create${toSurfaceSymbol(name).replace(/SurfaceModule$/u, "SurfaceApp")}`;
  await Deno.writeTextFile(
    new URL(`${directory}index.ts`, root),
    [
      "import type { SurfaceModule } from '@daringway/superstructure-runtime';",
      "",
      `import { ${createFunction} } from './surface.tsx';`,
      "",
      `export const ${symbol}: SurfaceModule = {`,
      `  name: '${name}',`,
      "  createApp(runtime) {",
      `    return ${createFunction}(runtime);`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}surface.tsx`, root),
    [
      "import { Hono } from 'hono';",
      "import type { MountedSurfaceRuntimeConfig } from '@daringway/superstructure-runtime';",
      "",
      `export function ${createFunction}(runtime: MountedSurfaceRuntimeConfig): Hono {`,
      "  const app = new Hono();",
      "  app.get('/', (context) =>",
      "    context.json({",
      `      surface: '${name}',`,
      "      mode: runtime.mode,",
      "      publicUrl: runtime.publicUrl,",
      "      apiBaseUrl: runtime.apiBaseUrl,",
      "    }),",
      "  );",
      "  return app;",
      "}",
      "",
    ].join("\n"),
  );

  manifest.surfaces.push({
    name,
    directory: surfaceDirectory(name),
    path: `/${name}`,
    enabled: true,
    rootEligible: true,
  });
  await saveProjectManifest(root, manifest);
  await regenerateProjectRegistries(root, manifest);
}

async function addStarterSiteSurface(projectName: string, root: URL): Promise<void> {
  const name = "site";
  const manifest = await ensureProjectStructure(root);
  if (manifest.surfaces.some((entry) => entry.name === name)) {
    throw new Error(`Surface "${name}" already exists.`);
  }

  const directory = `${surfaceDirectory(name)}/`;
  await Deno.mkdir(new URL(directory, root), { recursive: true });

  const symbol = toSurfaceSymbol(name);
  await Deno.writeTextFile(
    new URL(`${directory}index.ts`, root),
    [
      "import type { SurfaceModule } from '@daringway/superstructure-runtime';",
      "",
      "import { createSiteSurfaceApp } from './surface.tsx';",
      "",
      `export const ${symbol}: SurfaceModule = {`,
      `  name: '${name}',`,
      "  createApp(runtime) {",
      "    return createSiteSurfaceApp(runtime);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL(`${directory}surface.tsx`, root),
    [
      "import { Hono } from 'hono';",
      "import type { MountedSurfaceRuntimeConfig } from '@daringway/superstructure-runtime';",
      "",
      `const PROJECT_NAME = ${JSON.stringify(projectName)};`,
      "",
      "export function createSiteSurfaceApp(runtime: MountedSurfaceRuntimeConfig): Hono {",
      "  const app = new Hono();",
      "",
      "  app.get('/', (context) => context.html(renderWelcomePage(runtime)));",
      "",
      "  return app;",
      "}",
      "",
      "function renderWelcomePage(runtime: MountedSurfaceRuntimeConfig): string {",
      "  const healthUrl = `${runtime.apiBaseUrl}/system/health`;",
      "  const projectName = escapeHtml(PROJECT_NAME);",
      "  const mode = escapeHtml(runtime.mode);",
      "  const publicUrl = escapeHtml(runtime.publicUrl);",
      "  const apiBaseUrl = escapeHtml(runtime.apiBaseUrl);",
      "  const escapedHealthUrl = escapeHtml(healthUrl);",
      "",
      "  return `<!doctype html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="utf-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
      "  <title>${projectName}</title>",
      "  <style>",
      "    :root { color-scheme: light; }",
      "    * { box-sizing: border-box; }",
      '    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f1ea; color: #1e1f24; }',
      "    main { max-width: 760px; margin: 0 auto; padding: 64px 24px 80px; }",
      "    .eyebrow { display: inline-block; margin-bottom: 16px; padding: 6px 10px; border-radius: 999px; background: #1e1f24; color: #f4f1ea; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }",
      "    h1 { margin: 0 0 12px; font-size: clamp(2.5rem, 8vw, 4.5rem); line-height: 0.95; }",
      "    p { margin: 0 0 18px; font-size: 1.05rem; line-height: 1.6; }",
      "    dl { display: grid; grid-template-columns: max-content 1fr; gap: 10px 16px; margin: 32px 0; padding: 24px; border: 1px solid #d8d2c4; border-radius: 24px; background: rgba(255, 255, 255, 0.7); }",
      "    dt { font-weight: 700; }",
      "    dd { margin: 0; overflow-wrap: anywhere; }",
      "    a { color: #0b57d0; text-underline-offset: 2px; }",
      "  </style>",
      "</head>",
      "<body>",
      "  <main>",
      '    <div class="eyebrow">Superstructure Starter</div>',
      "    <h1>Welcome to ${projectName}</h1>",
      "    <p>Your Superstructure project is running. This starter is intentionally small so you can validate the runtime, then build the actual product surface on top of it.</p>",
      "    <dl>",
      "      <dt>Mode</dt>",
      "      <dd>${mode}</dd>",
      "      <dt>Public URL</dt>",
      "      <dd>${publicUrl}</dd>",
      "      <dt>API Base URL</dt>",
      "      <dd>${apiBaseUrl}</dd>",
      "      <dt>Health Check</dt>",
      '      <dd><a href="${escapedHealthUrl}">${escapedHealthUrl}</a></dd>',
      "    </dl>",
      "  </main>",
      "</body>",
      "</html>`;",
      "}",
      "",
      "function escapeHtml(value: string): string {",
      "  return value",
      "    .replaceAll('&', '&amp;')",
      "    .replaceAll('<', '&lt;')",
      "    .replaceAll('>', '&gt;')",
      "    .replaceAll('\"', '&quot;')",
      "    .replaceAll(\"'\", '&#39;');",
      "}",
      "",
    ].join("\n"),
  );

  manifest.surfaces.push({
    name,
    directory: surfaceDirectory(name),
    path: `/${name}`,
    enabled: true,
    rootEligible: true,
  });
  await saveProjectManifest(root, manifest);
  await regenerateProjectRegistries(root, manifest);
}

async function writeStarterDenoConfig(root: URL, platformRoot: string): Promise<void> {
  await writeJsonFile(new URL("deno.json", root), {
    nodeModulesDir: "auto",
    imports: {
      "@daringway/superstructure-auth-core": `${platformRoot}/packages/auth-core/src/index.ts`,
      "@daringway/superstructure-config": `${platformRoot}/packages/config/src/index.ts`,
      "@daringway/superstructure-contracts": `${platformRoot}/packages/contracts/src/index.ts`,
      "@daringway/superstructure-observability":
        `${platformRoot}/packages/observability/src/index.ts`,
      "@daringway/superstructure-permissions": `${platformRoot}/packages/permissions/src/index.ts`,
      "@daringway/superstructure-runtime": `${platformRoot}/packages/runtime/src/index.ts`,
      "drizzle-orm": "npm:drizzle-orm@^0.44.7",
      "drizzle-orm/pg-core": "npm:drizzle-orm@^0.44.7/pg-core",
      "drizzle-orm/postgres-js": "npm:drizzle-orm@^0.44.7/postgres-js",
      "drizzle-zod": "npm:drizzle-zod@^0.8.3",
      hono: "npm:hono@^4.12.10",
      "hono/cors": "npm:hono@^4.12.10/cors",
      postgres: "npm:postgres@^3.4.8",
      resend: "npm:resend@^4.8.0",
      zod: "npm:zod@^4.3.6",
    },
    superstructure: {
      platformRoot,
    },
    tasks: {
      build: "deno task typecheck",
      start: "deno run -A scripts/start.ts",
      dev: "deno run -A scripts/dev.ts",
      lint: "deno lint scripts tests superstructure",
      typecheck: [
        "deno check",
        "scripts/start.ts",
        "scripts/dev.ts",
        "superstructure/surfaces/site/index.ts",
        "superstructure/surfaces/site/surface.tsx",
        "tests/runtime_smoke_test.ts",
      ].join(" "),
      "test:unit": "deno test -A tests",
      "test:coverage": "deno test -A --coverage=coverage tests",
      "test:e2e": "deno test -A tests/runtime_smoke_test.ts",
      check: "deno task lint && deno task typecheck && deno task test:unit && deno task build",
    },
    fmt: {
      lineWidth: 100,
    },
  });
}

async function writeStarterAgentDocs(root: URL): Promise<void> {
  await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
  await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
  await Deno.writeTextFile(
    new URL("AGENTS.md", root),
    [
      "# AGENTS.md",
      "",
      "## Purpose",
      "",
      "This repository is a downstream Superstructure project.",
      "",
      "Read this file first, then read the local `agent-docs/` guidance before making substantial",
      "changes.",
      "",
      "## Read Order",
      "",
      "1. `README.md`",
      "2. `agent-docs/README.md`",
      "3. active exec plans in `agent-docs/exec-plans/active/`",
      "",
      "## Required Local Structure",
      "",
      "- `agent-docs/` is the canonical project-local guidance folder",
      "- track substantial work in `agent-docs/exec-plans/active/` and move completed work to",
      "  `agent-docs/exec-plans/completed/`",
      "- use `superctl gate` for business/policy checks, `superctl verify` for app tests, and",
      "  `superctl audit` for security checks",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    new URL("agent-docs/README.md", root),
    [
      "# Agent Docs",
      "",
      "Project-local implementation guidance and execution-plan tracking live here.",
      "",
      "## Required Subdirectories",
      "",
      "- `exec-plans/active/` for proposed and in-flight work",
      "- `exec-plans/completed/` for finished work",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(new URL("agent-docs/exec-plans/active/.gitkeep", root), "");
  await Deno.writeTextFile(new URL("agent-docs/exec-plans/completed/.gitkeep", root), "");
}

async function writeStarterQualityWorkflow(root: URL): Promise<void> {
  await Deno.mkdir(new URL(".github/workflows/", root), { recursive: true });
  await Deno.writeTextFile(
    new URL(".github/workflows/quality.yml", root),
    [
      "name: Quality Checks",
      "",
      "on:",
      "  pull_request:",
      "  workflow_dispatch:",
      "",
      "env:",
      '  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"',
      "",
      "jobs:",
      "  gate:",
      "    name: Superctl Gate",
      "    runs-on: ubuntu-latest",
      "",
      "    steps:",
      "      - name: Checkout project",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Checkout superctl",
      "        uses: actions/checkout@v6",
      "        with:",
      "          repository: daringway/superctl",
      "          ref: main",
      "          path: .github/tools/superctl",
      "",
      "      - name: Setup mise toolchain",
      "        uses: jdx/mise-action@v4",
      "        with:",
      "          version: 2026.3.10",
      "          install: true",
      "          cache: true",
      "",
      "      - name: Run superctl gate",
      `        run: deno run -A .github/tools/superctl/main.ts gate`,
      "",
      "  verify:",
      "    name: Superctl Verify",
      "    runs-on: ubuntu-latest",
      "",
      "    steps:",
      "      - name: Checkout project",
      "        uses: actions/checkout@v6",
      "",
      "      - name: Checkout superctl",
      "        uses: actions/checkout@v6",
      "        with:",
      "          repository: daringway/superctl",
      "          ref: main",
      "          path: .github/tools/superctl",
      "",
      "      - name: Setup mise toolchain",
      "        uses: jdx/mise-action@v4",
      "        with:",
      "          version: 2026.3.10",
      "          install: true",
      "          cache: true",
      "",
      "      - name: Run superctl verify",
      "        run: deno run -A .github/tools/superctl/main.ts verify",
      "",
      "  audit:",
      "    name: Superctl Audit",
      "    runs-on: ubuntu-latest",
      "",
      "    steps:",
      "      - name: Checkout project",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Checkout superctl",
      "        uses: actions/checkout@v6",
      "        with:",
      "          repository: daringway/superctl",
      "          ref: main",
      "          path: .github/tools/superctl",
      "",
      "      - name: Setup mise toolchain",
      "        uses: jdx/mise-action@v4",
      "        with:",
      "          version: 2026.3.10",
      "          install: true",
      "          cache: true",
      "",
      "      - name: Run superctl audit",
      "        run: deno run -A .github/tools/superctl/main.ts audit",
      "",
    ].join("\n"),
  );
}

async function writeStarterScripts(
  root: URL,
  projectName: string,
  platformRoot: string,
): Promise<void> {
  await Deno.mkdir(new URL("scripts/", root), { recursive: true });

  const source = [
    "import { startServer } from '@daringway/superstructure-runtime';",
    "",
    `const APPLICATION_NAME = ${JSON.stringify(projectName)};`,
    "const APPLICATION_VERSION = '0.1.0';",
    `const PLATFORM_ROOT = ${JSON.stringify(platformRoot)};`,
    "",
    "Deno.env.set('SUPERSTRUCTURE_PLATFORM_ROOT', PLATFORM_ROOT);",
    "",
    "await startServer({",
    "  applicationName: APPLICATION_NAME,",
    "  applicationVersion: APPLICATION_VERSION,",
    "  serviceName: 'site',",
    "  enabledServices: ['system'],",
    "});",
    "",
  ].join("\n");

  await Deno.writeTextFile(new URL("scripts/start.ts", root), source);
  await Deno.writeTextFile(new URL("scripts/dev.ts", root), source);
}

async function writeStarterTests(
  root: URL,
  projectName: string,
  platformRoot: string,
): Promise<void> {
  await Deno.mkdir(new URL("tests/", root), { recursive: true });

  await Deno.writeTextFile(
    new URL("tests/runtime_smoke_test.ts", root),
    [
      "import { createServerApp } from '@daringway/superstructure-runtime';",
      "",
      `const PROJECT_NAME = ${JSON.stringify(projectName)};`,
      "const BASE_URL = 'http://localhost:15000';",
      `const PLATFORM_ROOT = ${JSON.stringify(platformRoot)};`,
      "",
      "Deno.env.set('SUPERSTRUCTURE_PLATFORM_ROOT', PLATFORM_ROOT);",
      "",
      "Deno.test({",
      "  name: 'starter site renders a welcome page at root and /site',",
      "  sanitizeOps: false,",
      "  sanitizeResources: false,",
      "  fn: async () => {",
      "  const app = await createServerApp({",
      "    env: {",
      "      APP_BASE_URL: BASE_URL,",
      "      STACK_SERVER_PUBLIC_URL: BASE_URL,",
      "      NODE_ENV: 'test',",
      "    },",
      "    enabledServices: ['system'],",
      "  });",
      "",
      "  for (const path of ['/', '/site']) {",
      "    const response = await app.request(`${BASE_URL}${path}`);",
      "    if (response.status !== 200) {",
      "      throw new Error(`Expected ${path} to return 200, got ${response.status}.`);",
      "    }",
      "",
      "    const contentType = response.headers.get('content-type') ?? '';",
      "    if (!contentType.includes('text/html')) {",
      "      throw new Error(`Expected ${path} to return text/html, got ${contentType}.`);",
      "    }",
      "",
      "    const html = await response.text();",
      "    if (!html.includes(`Welcome to ${PROJECT_NAME}`)) {",
      "      throw new Error(`Expected ${path} to include the welcome heading.`);",
      "    }",
      "    if (!html.includes(`${BASE_URL}/api/system/health`)) {",
      "      throw new Error(`Expected ${path} to include the system health link.`);",
      "    }",
      "  }",
      "  },",
      "});",
      "",
      "Deno.test({",
      "  name: 'starter system health endpoint responds',",
      "  sanitizeOps: false,",
      "  sanitizeResources: false,",
      "  fn: async () => {",
      "  const app = await createServerApp({",
      "    env: {",
      "      APP_BASE_URL: BASE_URL,",
      "      STACK_SERVER_PUBLIC_URL: BASE_URL,",
      "      NODE_ENV: 'test',",
      "    },",
      "    enabledServices: ['system'],",
      "  });",
      "",
      "  const response = await app.request(`${BASE_URL}/api/system/health`);",
      "  if (response.status !== 200) {",
      "    throw new Error(`Expected /api/system/health to return 200, got ${response.status}.`);",
      "  }",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

async function resolveStarterPlatformRoot(root: URL): Promise<string> {
  const rootPath = resolve(fileURLToPath(root));
  const envPlatformRoot = Deno.env.get("SUPERSTRUCTURE_PLATFORM_ROOT")?.trim();
  const candidates = [
    ...(envPlatformRoot ? [envPlatformRoot] : []),
    "../../repos/superstructure",
    "../superstructure",
    "../platform",
  ];
  const attemptedPaths: string[] = [];

  for (const candidate of candidates) {
    const resolvedCandidate = envPlatformRoot === candidate
      ? resolve(candidate)
      : resolve(rootPath, candidate);
    attemptedPaths.push(resolvedCandidate);

    if (await isValidPlatformRoot(resolvedCandidate)) {
      return normalizePath(relative(rootPath, resolvedCandidate));
    }
  }

  throw new Error(
    [
      "Unable to resolve the Superstructure platform root for this project.",
      "Set SUPERSTRUCTURE_PLATFORM_ROOT or place the platform repo at one of these paths:",
      "  ../../repos/superstructure",
      "  ../superstructure",
      "  ../platform",
      "Attempted:",
      ...attemptedPaths.map((path) => `  ${path}`),
    ].join("\n"),
  );
}

async function isValidPlatformRoot(path: string): Promise<boolean> {
  try {
    const entry = await Deno.stat(join(path, "packages", "runtime", "src", "index.ts"));
    return entry.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function normalizePath(path: string): string {
  return path.length === 0 ? "." : path.split(sep).join("/");
}

function resolveProjectName(root: URL): string {
  return basename(resolve(fileURLToPath(root)));
}
