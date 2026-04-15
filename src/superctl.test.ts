import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve } from "node:path";

import { auditProject, findSecretScanIssues } from "./audit.ts";
import { doctorProject } from "./doctor.ts";
import { extractPlanStatus, gateProject } from "./gate.ts";
import { main } from "../main.ts";
import { buildProject, devProject, startProject } from "./run.ts";
import { addService, addSurface, initProject } from "./scaffold.ts";
import { testProject } from "./verify.ts";
import { SUPERCTL_VERSION } from "./version.ts";

async function captureConsoleLog(run: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(" "));
  };

  try {
    await run();
    return messages;
  } finally {
    console.log = originalConsoleLog;
  }
}

async function captureDoctorFailure(root: URL): Promise<string[]> {
  return await captureConsoleLog(async () => {
    await assertRejects(
      () => doctorProject(root),
      Error,
      "Doctor found",
    );
  });
}

async function writeProjectConfig(
  root: URL,
  fileName: "deno.json" | "deno.jsonc",
  tasks: Record<string, string> = {},
  options: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    ...options,
    ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
  };
  const source = JSON.stringify(payload, null, 2) + "\n";
  await Deno.writeTextFile(new URL(fileName, root), source);
}

async function writeProjectManifest(root: URL, manifest: unknown): Promise<void> {
  await Deno.writeTextFile(
    new URL("superstructure.project.json", root),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

async function writeQualityWorkflow(root: URL, source?: string): Promise<void> {
  await Deno.mkdir(new URL(".github/workflows/", root), { recursive: true });
  await Deno.writeTextFile(
    new URL(".github/workflows/quality.yml", root),
    source ??
      [
        "name: Quality Checks",
        "",
        "on:",
        "  pull_request:",
        "    types:",
        "      - opened",
        "      - reopened",
        "      - synchronize",
        "      - ready_for_review",
        "      - converted_to_draft",
        "  workflow_dispatch:",
        "",
        "jobs:",
        "  standards:",
        "    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno fmt --check .",
        "      - run: deno lint --config deno.json .",
        "",
        "  gate:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: superctl gate",
        "",
        "  test:",
        "    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: superctl test",
        "",
        "  audit:",
        "    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: superctl audit",
        "",
      ].join("\n"),
  );
}

async function runGit(
  root: URL,
  args: string[],
): Promise<void> {
  const child = new Deno.Command("git", {
    args,
    cwd: decodeURIComponent(root.pathname),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() || `git ${args.join(" ")} failed`,
    );
  }
}

async function initGitRepo(root: URL): Promise<void> {
  await runGit(root, ["init", "-b", "test"]);
  await runGit(root, ["config", "user.name", "Test User"]);
  await runGit(root, ["config", "user.email", "test@example.com"]);
  await Deno.mkdir(new URL(".git-hooks/", root), { recursive: true });
  await runGit(root, ["config", "core.hooksPath", ".git-hooks"]);
}

async function commitAll(root: URL, message: string): Promise<void> {
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", message]);
}

async function writeMiseTools(
  root: URL,
  toolEntries: Record<string, string>,
  fileName = ".mise.toml",
): Promise<void> {
  const lines = ["[tools]"];
  for (const [name, version] of Object.entries(toolEntries)) {
    lines.push(`${name} = "${version}"`);
  }
  lines.push("");
  await Deno.writeTextFile(new URL(fileName, root), lines.join("\n"));
}

async function writeCanonicalSuperctlPlugin(rootPath: string): Promise<void> {
  const pluginRoot = join(rootPath, "mise-plugin");
  await Deno.mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await Deno.writeTextFile(join(pluginRoot, "metadata.lua"), "PLUGIN = { name = 'superctl' }\n");
  await Deno.writeTextFile(join(pluginRoot, "hooks", "available.lua"), "return {}\n");
  await Deno.writeTextFile(join(pluginRoot, "hooks", "pre_install.lua"), "return {}\n");
  await Deno.writeTextFile(join(pluginRoot, "hooks", "post_install.lua"), "return {}\n");
  await Deno.writeTextFile(join(pluginRoot, "hooks", "env_keys.lua"), "return {}\n");
}

async function writeFakeSuperctlSourceRepo(
  path: string,
  version = SUPERCTL_VERSION,
  options: { includePlugin?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, "main.ts"), "console.log('superctl');\n");
  await Deno.writeTextFile(join(path, "deno.json"), JSON.stringify({ version }, null, 2) + "\n");

  if (options.includePlugin ?? true) {
    await writeCanonicalSuperctlPlugin(path);
  }
}

function makeFakeGitHubToken(): string {
  return ["gh", "p_", "123456789012345678901234567890123456"].join("");
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Deno.env.get(name);

  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Deno.env.delete(name);
    } else {
      Deno.env.set(name, previous);
    }
  }
}

async function createInitFixture(options: { createDefaultPlatform?: boolean } = {}): Promise<{
  root: URL;
  cleanup: () => Promise<void>;
  workspacePath: string;
}> {
  const workspacePath = await Deno.makeTempDir({ prefix: "superctl-init-workspace-" });
  const rootPath = join(workspacePath, "apps", "sample-app");
  await Deno.mkdir(rootPath, { recursive: true });

  if (options.createDefaultPlatform ?? true) {
    await writeFakePlatformRoot(join(workspacePath, "repos", "superstructure"));
  }

  return {
    root: new URL(`file://${resolve(rootPath)}/`),
    workspacePath,
    cleanup: async () => {
      await Deno.remove(workspacePath, { recursive: true });
    },
  };
}

async function writeFakePlatformRoot(platformRootPath: string): Promise<void> {
  const authEntryPath = join(platformRootPath, "superstructure", "services", "auth", "index.ts");
  const runtimeEntryPath = join(platformRootPath, "packages", "runtime", "src", "index.ts");
  const workspaceConfigPath = join(platformRootPath, "deno.json");
  await Deno.mkdir(join(platformRootPath, "superstructure", "services", "auth"), {
    recursive: true,
  });
  await Deno.mkdir(join(platformRootPath, "packages", "runtime", "src"), {
    recursive: true,
  });
  await Deno.writeTextFile(workspaceConfigPath, '{\n  "workspace": ["./packages/*"]\n}\n');
  await Deno.writeTextFile(authEntryPath, "export {};\n");
  await Deno.writeTextFile(runtimeEntryPath, "export {};\n");
}

Deno.test("usage rejects unknown commands", async () => {
  await assertRejects(
    () => main(["nope"]),
    Error,
    "Usage:\n  superctl help\n  superctl version",
  );
});

Deno.test("version commands print the current superctl version", async () => {
  for (const command of [["version"], ["--version"], ["-V"]]) {
    const messages = await captureConsoleLog(() => main(command));
    assertEquals(messages, [SUPERCTL_VERSION]);
  }
});

Deno.test("help lists audit alongside gate and test", async () => {
  const messages = await captureConsoleLog(() => main(["help"]));
  const output = messages.join("\n");
  assertStringIncludes(output, "superctl gate");
  assertStringIncludes(output, "superctl test");
  assertStringIncludes(output, "superctl audit");
});

Deno.test("init bootstraps a new project with the default site surface", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    const manifest = await Deno.readTextFile(
      new URL("superstructure.project.json", fixture.root),
    );
    const denoConfig = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", fixture.root)),
    ) as {
      imports?: Record<string, string>;
      links?: string[];
      tasks?: Record<string, string>;
    };
    const surfacesRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/surfaces.ts", fixture.root),
    );
    const siteIndex = await Deno.readTextFile(
      new URL("superstructure/surfaces/site/index.ts", fixture.root),
    );
    const siteSurface = await Deno.readTextFile(
      new URL("superstructure/surfaces/site/surface.tsx", fixture.root),
    );
    const siteSurfaceTest = await Deno.readTextFile(
      new URL("superstructure/surfaces/site/surface.test.ts", fixture.root),
    );
    const runtimeSmokeTest = await Deno.readTextFile(
      new URL("tests/smoke/runtime_smoke_test.ts", fixture.root),
    );
    const agents = await Deno.readTextFile(new URL("AGENTS.md", fixture.root));
    const agentDocsReadme = await Deno.readTextFile(new URL("agent-docs/README.md", fixture.root));
    const qualityWorkflow = await Deno.readTextFile(
      new URL(".github/workflows/quality.yml", fixture.root),
    );

    assertStringIncludes(manifest, '"rootSurface": "site"');
    assertStringIncludes(manifest, '"builtInServices": [');
    assertStringIncludes(manifest, '"system"');
    assertStringIncludes(manifest, '"serverPort": 15000');
    assertStringIncludes(manifest, '"name": "site"');
    assertEquals(
      denoConfig.imports?.["@daringway/superstructure-runtime"],
      "jsr:@daringway/superstructure-runtime@^0.2.0",
    );
    assertEquals(denoConfig.links, ["../../repos/superstructure"]);
    assertEquals(denoConfig.tasks, undefined);
    assertStringIncludes(surfacesRegistry, "SiteSurfaceModule");
    assertStringIncludes(siteIndex, "export const SiteSurfaceModule");
    assertStringIncludes(siteSurface, "context.html(renderWelcomePage(runtime))");
    assertStringIncludes(siteSurface, "Welcome to ${projectName}");
    assertStringIncludes(siteSurface, "system/health");
    assertStringIncludes(siteSurfaceTest, "starter site surface renders the welcome page");
    assertStringIncludes(siteSurfaceTest, "resolveServerRuntimeConfig");
    assertStringIncludes(runtimeSmokeTest, "starter site renders a welcome page at root and /site");
    assertStringIncludes(runtimeSmokeTest, "/api/system/health");
    assertStringIncludes(runtimeSmokeTest, "resolveServerRuntimeConfig");
    assertStringIncludes(agents, "agent-docs/exec-plans/active/");
    assertStringIncludes(agentDocsReadme, "exec-plans/completed/");
    await Deno.stat(new URL("agent-docs/exec-plans/active/.gitkeep", fixture.root));
    await Deno.stat(new URL("agent-docs/exec-plans/completed/.gitkeep", fixture.root));
    assertStringIncludes(qualityWorkflow, "pull_request");
    assertStringIncludes(qualityWorkflow, "ready_for_review");
    assertStringIncludes(qualityWorkflow, "converted_to_draft");
    assertStringIncludes(qualityWorkflow, "Quality Standards");
    assertStringIncludes(
      qualityWorkflow,
      "if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
    );
    assertStringIncludes(qualityWorkflow, "deno fmt --check .");
    assertStringIncludes(qualityWorkflow, "deno lint --config deno.json .");
    assertStringIncludes(qualityWorkflow, "Superctl Gate");
    assertStringIncludes(qualityWorkflow, "main.ts gate");
    assertStringIncludes(qualityWorkflow, "main.ts test");
    assertStringIncludes(qualityWorkflow, "deno audit --level=high");
    assertStringIncludes(qualityWorkflow, "main.ts audit");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("init rejects already initialized projects", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    await assertRejects(
      () => withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root)),
      Error,
      "Current directory is already initialized for Superstructure.",
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports a fresh init as healthy", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    const messages = await captureConsoleLog(() => doctorProject(fixture.root));
    assertStringIncludes(messages.join("\n"), "Using deno.json for project configuration.");
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("init records the configured starter server port in the manifest", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("STACK_SERVER_PORT", "16100", () => initProject(fixture.root));

    const manifest = await Deno.readTextFile(new URL("superstructure.project.json", fixture.root));
    assertStringIncludes(manifest, '"serverPort": 16100');
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor validates healthy local superctl mode", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await writeMiseTools(fixture.root, {
      deno: "2.7.10",
      node: "25.4.0",
      superctl: "main",
    });
    await writeMiseTools(
      fixture.root,
      { superctl: "local" },
      "mise.local.toml",
    );
    await writeFakeSuperctlSourceRepo(join(fixture.workspacePath, "repos", "superctl"));

    const messages = await withEnv(
      "SUPERCTL_ROOT",
      undefined,
      () => captureConsoleLog(() => doctorProject(fixture.root)),
    );
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports missing local superctl plugin files", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await writeMiseTools(fixture.root, {
      deno: "2.7.10",
      node: "25.4.0",
      superctl: "main",
    });
    await writeMiseTools(
      fixture.root,
      { superctl: "local" },
      "mise.local.toml",
    );
    await writeFakeSuperctlSourceRepo(
      join(fixture.workspacePath, "repos", "superctl"),
      SUPERCTL_VERSION,
      {
        includePlugin: false,
      },
    );

    const messages = await withEnv(
      "SUPERCTL_ROOT",
      undefined,
      () => captureDoctorFailure(fixture.root),
    );
    const output = messages.join("\n");
    assertStringIncludes(
      output,
      "mise-plugin/metadata.lua",
    );
    assertStringIncludes(
      output,
      "mise-plugin/hooks/pre_install.lua",
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports missing local superctl source repos", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await writeMiseTools(fixture.root, {
      deno: "2.7.10",
      node: "25.4.0",
      superctl: "main",
    });
    await writeMiseTools(
      fixture.root,
      { superctl: "local" },
      "mise.local.toml",
    );

    const messages = await withEnv(
      "SUPERCTL_ROOT",
      undefined,
      () => captureDoctorFailure(fixture.root),
    );
    assertStringIncludes(
      messages.join("\n"),
      'Local superctl mode requires a source repo at "',
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports stale local superctl binaries", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await writeMiseTools(fixture.root, {
      deno: "2.7.10",
      node: "25.4.0",
      superctl: "main",
    });
    await writeMiseTools(
      fixture.root,
      { superctl: "local" },
      "mise.local.toml",
    );
    await writeFakeSuperctlSourceRepo(join(fixture.workspacePath, "repos", "superctl"), "9.9.9");

    const messages = await withEnv(
      "SUPERCTL_ROOT",
      undefined,
      () => captureDoctorFailure(fixture.root),
    );
    const output = messages.join("\n");
    assertStringIncludes(
      output,
      `Local superctl source version "9.9.9" does not match the running superctl version "${SUPERCTL_VERSION}".`,
    );
    assertStringIncludes(
      output,
      'Rerun "mise install -f superctl@local" and "mise reshim superctl".',
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("init does not require a local platform root", async () => {
  const fixture = await createInitFixture({ createDefaultPlatform: false });

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    const denoConfig = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", fixture.root)),
    ) as {
      imports?: Record<string, string>;
      links?: string[];
    };

    assertEquals(
      denoConfig.imports?.["@daringway/superstructure-runtime"],
      "jsr:@daringway/superstructure-runtime@^0.2.0",
    );
    assertEquals(denoConfig.links, undefined);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports healthy configuration without running verification", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");
    await writeQualityWorkflow(root);
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
      },
    });

    const messages = await captureConsoleLog(() => doctorProject(root));
    assertStringIncludes(messages.join("\n"), "Using deno.json for project configuration.");
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor accepts repo-local ci tasks in the quality workflow", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");
    await writeQualityWorkflow(
      root,
      [
        "name: Quality Checks",
        "",
        "on:",
        "  pull_request:",
        "  workflow_dispatch:",
        "",
        "jobs:",
        "  gate:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno task ci:gate",
        "",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno task ci:test",
        "",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno task ci:audit",
        "",
      ].join("\n"),
    );
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
      },
    });

    const messages = await captureConsoleLog(() => doctorProject(root));
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports root surface misconfiguration", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.jsonc");
    await writeQualityWorkflow(root);
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [],
      deployment: {
        rootSurface: "site",
      },
    });

    await assertRejects(
      () => doctorProject(root),
      Error,
      "Doctor found 1 configuration issue(s).",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports missing quality workflow", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
      },
    });

    await assertRejects(
      () => doctorProject(root),
      Error,
      "Doctor found 1 configuration issue(s).",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build, start, and dev use native project commands", async () => {
  const invocations: string[] = [];
  const runCommand = ({ label }: { label: string }) => {
    invocations.push(label);
    return Promise.resolve(0);
  };

  const rootPath = await Deno.makeTempDir({ prefix: "superctl-run-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
        builtInServices: ["system"],
      },
    });
    await Deno.mkdir(new URL("superstructure/surfaces/site/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("superstructure/surfaces/site/index.ts", root),
      "export {};\n",
    );

    await buildProject(root, runCommand);
    await startProject(root, runCommand);
    await devProject(root, runCommand);

    assertEquals(
      invocations,
      ["typecheck", "build validation", "start", "typecheck", "build validation", "start"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("add service and surface scaffold manifest entries and generated registries", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-project-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");

    await addService("billing-api", root);
    await addSurface("marketing-site", root);

    const manifest = await Deno.readTextFile(new URL("superstructure.project.json", root));
    assertStringIncludes(manifest, '"name": "billing-api"');
    assertStringIncludes(manifest, '"name": "marketing-site"');

    const servicesRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/services.ts", root),
    );
    const serviceDbSchemaRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/service-db-schema.ts", root),
    );
    const surfacesRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/surfaces.ts", root),
    );
    const serviceDbIndex = await Deno.readTextFile(
      new URL("superstructure/services/billing-api/db/index.ts", root),
    );
    const serviceDbSchema = await Deno.readTextFile(
      new URL("superstructure/services/billing-api/db/schema/index.ts", root),
    );
    const serviceRoutes = await Deno.readTextFile(
      new URL("superstructure/services/billing-api/routes.ts", root),
    );

    assertStringIncludes(servicesRegistry, "BillingApiServiceModule");
    assertStringIncludes(serviceDbSchemaRegistry, "../services/billing-api/db/schema/index.ts");
    assertStringIncludes(surfacesRegistry, "MarketingSiteSurfaceModule");
    assertStringIncludes(serviceDbIndex, 'deriveServiceSchemaName("billing-api")');
    assertStringIncludes(serviceDbSchema, "billingApiSchema");
    assertStringIncludes(serviceRoutes, "registerBillingApiServiceRoutes");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate rejects custom services importing platform DB internals", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      lint: "echo lint",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("agent-docs/exec-plans/completed/0001-test.md", root),
      "# Test Plan\n\n## Status\n\nCompleted.\n",
    );
    await initGitRepo(root);
    await commitAll(root, "baseline");

    await addService("billing-api", root);
    await Deno.writeTextFile(
      new URL("superstructure/services/billing-api/service.ts", root),
      "import '../../../apps/server/src/api/db/index.ts';\n",
    );

    await assertRejects(
      () => gateProject(root, () => Promise.resolve()),
      Error,
      "must not import platform DB internals",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test command skips empty buckets", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.jsonc");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
        builtInServices: ["system"],
      },
    });

    const messages = await captureConsoleLog(() => testProject(root, "unit"));
    assertStringIncludes(messages.join("\n"), "Test (unit) summary");
    assertStringIncludes(messages.join("\n"), "No tests found for this bucket.");
    assertStringIncludes(messages.join("\n"), "Overall: PASSED (0 passed, 0 failed, 1 skipped)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test command runs buckets in smoke, unit, api, ui, app order", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.json");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [
        {
          name: "billing",
          directory: "superstructure/services/billing",
          enabled: true,
        },
      ],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
        builtInServices: ["system"],
      },
    });

    await Deno.mkdir(new URL("tests/smoke/", root), { recursive: true });
    await Deno.mkdir(new URL("tests/e2e/", root), { recursive: true });
    await Deno.mkdir(new URL("superstructure/services/billing/", root), { recursive: true });
    await Deno.mkdir(new URL("superstructure/surfaces/site/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("tests/smoke/runtime_smoke_test.ts", root),
      'Deno.test("smoke", () => {});\n',
    );
    await Deno.writeTextFile(
      new URL("superstructure/services/billing/service.test.ts", root),
      'Deno.test("unit", () => {});\n',
    );
    await Deno.writeTextFile(
      new URL("superstructure/surfaces/site/surface.test.ts", root),
      'Deno.test("ui", () => {});\n',
    );
    await Deno.writeTextFile(
      new URL("tests/e2e/app.test.ts", root),
      'Deno.test("app", () => {});\n',
    );

    await testProject(root, null, ({ label }) => {
      invocations.push(label);
      return Promise.resolve({ code: 0, metrics: { passed: 1, total: 1 } });
    });

    assertEquals(invocations, [
      "Deno smoke tests",
      "Deno unit tests",
      "Deno UI tests",
      "Deno app tests",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test command prints bucketed and overall summaries", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
        builtInServices: ["system"],
      },
    });
    await Deno.mkdir(new URL("tests/smoke/", root), { recursive: true });
    await Deno.mkdir(new URL("superstructure/surfaces/site/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("tests/smoke/runtime_smoke_test.ts", root),
      'Deno.test("smoke", () => {});\n',
    );
    await Deno.writeTextFile(
      new URL("superstructure/surfaces/site/surface.test.ts", root),
      'Deno.test("ui", () => {});\n',
    );

    const messages = await captureConsoleLog(() =>
      testProject(root, null, ({ label }) => {
        if (label === "Deno smoke tests") {
          return Promise.resolve({ code: 0, metrics: { passed: 2, total: 2 } });
        }
        if (label === "Deno UI tests") {
          return Promise.resolve({ code: 0, metrics: { passed: 1, total: 1 } });
        }
        return Promise.resolve({ code: 0, metrics: { passed: 1, total: 1 } });
      })
    );

    const output = messages.join("\n");
    assertStringIncludes(output, "Test (smoke) summary");
    assertStringIncludes(output, "✓ Deno smoke tests: 2 of 2 passed");
    assertStringIncludes(output, "Test (ui) summary");
    assertStringIncludes(output, "✓ Deno UI tests: 1 of 1 passed");
    assertStringIncludes(output, "Test summary");
    assertStringIncludes(output, "✓ Smoke tests: 2 of 2 passed");
    assertStringIncludes(output, "- Unit tests: skipped");
    assertStringIncludes(output, "- API tests: skipped");
    assertStringIncludes(output, "✓ UI tests: 1 of 1 passed");
    assertStringIncludes(output, "- App tests: skipped");
    assertStringIncludes(output, "Overall: PASSED (2 passed, 0 failed, 3 skipped)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate requires a changed completed exec plan", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.json", {
      lint: "echo lint",
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
    await Deno.writeTextFile(new URL("src.ts", root), "export const value = 1;\n");
    await initGitRepo(root);
    await commitAll(root, "baseline");
    await Deno.writeTextFile(new URL("src.ts", root), "export const value = 2;\n");

    await assertRejects(
      () =>
        gateProject(root, ({ label }) => {
          invocations.push(label);
          return Promise.resolve();
        }),
      Error,
      "changed exec-plan marked Completed",
    );

    assertEquals(invocations, ["format check", "lint"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate skips exec plan requirement for all-added files", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.json", {
      lint: "echo lint",
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
    await initGitRepo(root);
    await commitAll(root, "baseline");
    await Deno.writeTextFile(new URL("new-file.ts", root), "export const value = 1;\n");

    await gateProject(root, ({ label }) => {
      invocations.push(label);
      return Promise.resolve();
    });

    assertEquals(invocations, ["format check", "lint"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate prints a summary when a step fails", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      lint: "echo lint",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });

    const messages = await captureConsoleLog(async () => {
      await assertRejects(
        () =>
          gateProject(root, ({ label }) => {
            if (label === "lint") {
              return Promise.reject(new Error("lint failed"));
            }
            return Promise.resolve();
          }),
        Error,
        "lint failed",
      );
    });

    const output = messages.join("\n");
    assertStringIncludes(output, "Gate summary");
    assertStringIncludes(output, "✓ Project structure: 1 of 1 passed");
    assertStringIncludes(output, "✓ Deno config: 1 of 1 passed");
    assertStringIncludes(output, "✓ Test layout: 1 of 1 passed");
    assertStringIncludes(output, "✓ Format check: 1 of 1 passed");
    assertStringIncludes(output, "✗ Lint: 0 of 1 passed");
    assertStringIncludes(output, "✓ Exec plan completion: 1 of 1 passed");
    assertStringIncludes(output, "Overall: FAILED (5 passed, 1 failed)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor rejects repo-root tests files outside allowed subdirectories", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await writeQualityWorkflow(root);
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
      },
    });
    await Deno.mkdir(new URL("tests/", root), { recursive: true });
    await Deno.writeTextFile(new URL("tests/site-contract.test.ts", root), "export {};\n");

    const messages = await captureDoctorFailure(root);
    assertStringIncludes(
      messages.join("\n"),
      'Repo-root tests must organize files under tests/{e2e,db,bruno,smoke,fixtures,harness}/. Found "tests/site-contract.test.ts".',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate rejects repo-root ad hoc test directories", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      lint: "echo lint",
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("agent-docs/exec-plans/completed/0001-gate.md", root),
      "# Gate\n\n## Status\n\nCompleted.\n",
    );
    await Deno.mkdir(new URL("bruno/", root), { recursive: true });

    await assertRejects(
      () => gateProject(root, () => Promise.resolve()),
      Error,
      'Repo-root "bruno/" is not allowed.',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate accepts a changed completed exec plan file", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-gate-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.json", {
      lint: "echo lint",
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
    await Deno.writeTextFile(new URL("AGENTS.md", root), "# AGENTS\n");
    await Deno.mkdir(new URL("agent-docs/exec-plans/active/", root), { recursive: true });
    await Deno.mkdir(new URL("agent-docs/exec-plans/completed/", root), { recursive: true });
    await Deno.writeTextFile(new URL("src.ts", root), "export const value = 1;\n");
    await initGitRepo(root);
    await commitAll(root, "baseline");
    await Deno.writeTextFile(
      new URL("agent-docs/exec-plans/completed/0001-gate.md", root),
      "# Gate\n\n## Status\n\nCompleted.\n",
    );

    await gateProject(root, ({ label }) => {
      invocations.push(label);
      return Promise.resolve();
    });

    assertEquals(invocations, ["format check", "lint"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audit runs deno dependency audit when deno.lock is present", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-audit-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await Deno.writeTextFile(new URL("deno.lock", root), '{\n  "version": "5"\n}\n');
    await initGitRepo(root);
    await commitAll(root, "baseline");

    await auditProject(root, ({ label }) => {
      invocations.push(label);
      return Promise.resolve();
    });

    assertEquals(invocations, ["dependency audit"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("audit prints a summary when a step fails", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-audit-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await Deno.writeTextFile(
      new URL("secrets.txt", root),
      `token=${makeFakeGitHubToken()}\n`,
    );
    await Deno.writeTextFile(new URL("deno.lock", root), '{\n  "version": "5"\n}\n');
    await initGitRepo(root);
    await commitAll(root, "baseline");
    await Deno.writeTextFile(
      new URL("secrets.txt", root),
      `token=${makeFakeGitHubToken()}\nchanged=true\n`,
    );

    const messages = await captureConsoleLog(async () => {
      await assertRejects(
        () =>
          auditProject(root, ({ label }) => {
            if (label === "dependency audit") {
              return Promise.reject(new Error("dependency audit failed"));
            }
            return Promise.resolve();
          }),
        Error,
        "Audit failed",
      );
    });

    const output = messages.join("\n");
    assertStringIncludes(output, "Audit summary");
    assertStringIncludes(output, "✗ Secret scan: 0 of 1 passed");
    assertStringIncludes(output, "✗ Dependency audit: 0 of 1 passed");
    assertStringIncludes(output, "Overall: FAILED (0 passed, 2 failed)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("secret scan flags obvious credential material in changed files", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-audit-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await Deno.writeTextFile(
      new URL("secrets.txt", root),
      `token=${makeFakeGitHubToken()}\n`,
    );
    const issues = await findSecretScanIssues(root, ["secrets.txt"]);
    assertEquals(issues, ["secrets.txt: matched GitHub token"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("extractPlanStatus reads completed plan status blocks", () => {
  assertEquals(
    extractPlanStatus("# Example\n\n## Status\n\nCompleted.\n"),
    "Completed",
  );
});

Deno.test("usage for invalid add command stays explicit", async () => {
  await assertRejects(
    () => main(["add", "api", "billing"]),
    Error,
    'Expected "add service <name>" or "add surface <name>".',
  );
});

Deno.test("registry exports include service order once added", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-registry-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json");

    await addService("billing-api", root);
    await addService("analytics-api", root);

    const servicesRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/services.ts", root),
    );
    assertStringIncludes(servicesRegistry, "BillingApiServiceModule");
    assertStringIncludes(servicesRegistry, "AnalyticsApiServiceModule");
    assertStringIncludes(servicesRegistry, "export const serviceModules = [");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build uses manifest files from deno.jsonc projects", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-jsonc-run-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.jsonc");
    await writeProjectManifest(root, {
      schemaVersion: 1,
      services: [],
      surfaces: [
        {
          name: "site",
          directory: "superstructure/surfaces/site",
          path: "/site",
          enabled: true,
          rootEligible: true,
        },
      ],
      deployment: {
        rootSurface: "site",
        builtInServices: ["system"],
      },
    });
    await Deno.mkdir(new URL("superstructure/surfaces/site/", root), { recursive: true });
    await Deno.writeTextFile(
      new URL("superstructure/surfaces/site/index.ts", root),
      "export {};\n",
    );

    await buildProject(root, ({ label }) => {
      invocations.push(label);
      return Promise.resolve(0);
    });

    assertEquals(invocations, ["typecheck", "build validation"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
