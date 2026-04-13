import {
  assertArrayIncludes,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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
  tasks: Record<string, string>,
  options: Record<string, unknown> = {},
): Promise<void> {
  const source = JSON.stringify({ ...options, tasks }, null, 2) + "\n";
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
        "  workflow_dispatch:",
        "",
        "jobs:",
        "  gate:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno run -A .github/tools/superctl/main.ts gate",
        "",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno run -A .github/tools/superctl/main.ts test",
        "",
        "  audit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno run -A .github/tools/superctl/main.ts audit",
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

async function writeMiseTools(root: URL, toolEntries: Record<string, string>): Promise<void> {
  const lines = ["[tools]"];
  for (const [name, version] of Object.entries(toolEntries)) {
    lines.push(`${name} = "${version}"`);
  }
  lines.push("");
  await Deno.writeTextFile(new URL(".mise.toml", root), lines.join("\n"));
}

async function writeLocalSuperctlPlugin(root: URL): Promise<void> {
  await Deno.mkdir(new URL(".mise-plugins/superctl/bin/", root), { recursive: true });
  await Deno.writeTextFile(
    new URL(".mise-plugins/superctl/bin/install", root),
    "#!/usr/bin/env bash\n",
  );
  await Deno.writeTextFile(
    new URL(".mise-plugins/superctl/bin/list-all", root),
    "#!/usr/bin/env bash\necho local\n",
  );
}

async function writeFakeSuperctlSourceRepo(
  path: string,
  version = SUPERCTL_VERSION,
): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, "main.ts"), "console.log('superctl');\n");
  await Deno.writeTextFile(join(path, "deno.json"), JSON.stringify({ version }, null, 2) + "\n");
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
  await Deno.mkdir(join(platformRootPath, "superstructure", "services", "auth"), {
    recursive: true,
  });
  await Deno.mkdir(join(platformRootPath, "packages", "runtime", "src"), {
    recursive: true,
  });
  await Deno.writeTextFile(authEntryPath, "export {};\n");
  await Deno.writeTextFile(runtimeEntryPath, "export {};\n");
}

const STARTER_UNIT_TEST_IGNORE =
  "tests/e2e,tests/smoke,tests/db,tests/bruno,tests/fixtures,tests/harness,node_modules,dist,coverage";

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
      superstructure?: { platformRoot?: string };
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
    const startScript = await Deno.readTextFile(new URL("scripts/start.ts", fixture.root));
    const devScript = await Deno.readTextFile(new URL("scripts/dev.ts", fixture.root));
    const runtimeSmokeTest = await Deno.readTextFile(
      new URL("tests/smoke/runtime_smoke_test.ts", fixture.root),
    );
    const agents = await Deno.readTextFile(new URL("AGENTS.md", fixture.root));
    const agentDocsReadme = await Deno.readTextFile(new URL("agent-docs/README.md", fixture.root));
    const qualityWorkflow = await Deno.readTextFile(
      new URL(".github/workflows/quality.yml", fixture.root),
    );

    assertStringIncludes(manifest, '"rootSurface": "site"');
    assertStringIncludes(manifest, '"name": "site"');
    assertEquals(denoConfig.superstructure?.platformRoot, "../../repos/superstructure");
    assertEquals(
      denoConfig.tasks ? Object.keys(denoConfig.tasks).sort() : [],
      [
        "build",
        "check",
        "dev",
        "lint",
        "start",
        "test:unit",
        "test:coverage",
        "test:e2e",
        "typecheck",
      ].sort(),
    );
    assertStringIncludes(surfacesRegistry, "SiteSurfaceModule");
    assertStringIncludes(siteIndex, "export const SiteSurfaceModule");
    assertStringIncludes(siteSurface, "context.html(renderWelcomePage(runtime))");
    assertStringIncludes(siteSurface, "Welcome to ${projectName}");
    assertStringIncludes(siteSurface, "system/health");
    assertStringIncludes(startScript, "enabledServices: ['system']");
    assertStringIncludes(startScript, "applicationVersion: APPLICATION_VERSION");
    assertEquals(startScript, devScript);
    assertStringIncludes(runtimeSmokeTest, "starter site renders a welcome page at root and /site");
    assertStringIncludes(runtimeSmokeTest, "/api/system/health");
    assertStringIncludes(agents, "agent-docs/exec-plans/active/");
    assertStringIncludes(agentDocsReadme, "exec-plans/completed/");
    await Deno.stat(new URL("agent-docs/exec-plans/active/.gitkeep", fixture.root));
    await Deno.stat(new URL("agent-docs/exec-plans/completed/.gitkeep", fixture.root));
    assertStringIncludes(qualityWorkflow, "pull_request");
    assertStringIncludes(qualityWorkflow, "Superctl Gate");
    assertStringIncludes(qualityWorkflow, "main.ts gate");
    assertStringIncludes(qualityWorkflow, "main.ts test");
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
    assertStringIncludes(messages.join("\n"), "Using deno.json for Deno task configuration.");
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor requires superstructure.platformRoot for starter projects", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    const denoConfigPath = new URL("deno.json", fixture.root);
    const denoConfig = JSON.parse(await Deno.readTextFile(denoConfigPath)) as {
      superstructure?: { platformRoot?: string };
    };
    delete denoConfig.superstructure;
    await Deno.writeTextFile(denoConfigPath, JSON.stringify(denoConfig, null, 2) + "\n");

    const messages = await captureDoctorFailure(fixture.root);
    assertStringIncludes(
      messages.join("\n"),
      "Starter projects must set deno.json or deno.jsonc superstructure.platformRoot.",
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor rejects missing starter platform roots", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

    await writeProjectConfig(
      fixture.root,
      "deno.json",
      {
        build: "deno task typecheck",
        start: "deno run -A scripts/start.ts",
        dev: "deno run -A scripts/dev.ts",
        lint: "deno lint scripts tests superstructure",
        typecheck:
          "deno check scripts/start.ts scripts/dev.ts superstructure/surfaces/site/index.ts superstructure/surfaces/site/surface.tsx tests/smoke/runtime_smoke_test.ts",
        "test:unit": `deno test -A . --ignore=${STARTER_UNIT_TEST_IGNORE}`,
        "test:coverage": `deno test -A --coverage=coverage . --ignore=${STARTER_UNIT_TEST_IGNORE}`,
        "test:e2e": "deno test -A tests/smoke/runtime_smoke_test.ts",
        check: "deno task lint && deno task typecheck && deno task test:unit && deno task build",
      },
      {
        superstructure: {
          platformRoot: "../../repos/missing-superstructure",
        },
      },
    );

    const messages = await captureDoctorFailure(fixture.root);
    assertStringIncludes(
      messages.join("\n"),
      'superstructure.platformRoot "../../repos/missing-superstructure" does not exist.',
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor rejects platform roots without the runtime entrypoint", async () => {
  const fixture = await createInitFixture();
  const invalidPlatformRoot = join(fixture.workspacePath, "repos", "broken-superstructure");

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await Deno.mkdir(invalidPlatformRoot, { recursive: true });
    await Deno.writeTextFile(join(invalidPlatformRoot, "README.md"), "# broken\n");

    await writeProjectConfig(
      fixture.root,
      "deno.json",
      {
        build: "deno task typecheck",
        start: "deno run -A scripts/start.ts",
        dev: "deno run -A scripts/dev.ts",
        lint: "deno lint scripts tests superstructure",
        typecheck:
          "deno check scripts/start.ts scripts/dev.ts superstructure/surfaces/site/index.ts superstructure/surfaces/site/surface.tsx tests/smoke/runtime_smoke_test.ts",
        "test:unit": `deno test -A . --ignore=${STARTER_UNIT_TEST_IGNORE}`,
        "test:coverage": `deno test -A --coverage=coverage . --ignore=${STARTER_UNIT_TEST_IGNORE}`,
        "test:e2e": "deno test -A tests/smoke/runtime_smoke_test.ts",
        check: "deno task lint && deno task typecheck && deno task test:unit && deno task build",
      },
      {
        superstructure: {
          platformRoot: "../../repos/broken-superstructure",
        },
      },
    );

    const messages = await captureDoctorFailure(fixture.root);
    assertStringIncludes(
      messages.join("\n"),
      'superstructure.platformRoot "../../repos/broken-superstructure" must contain "packages/runtime/src/index.ts".',
    );
  } finally {
    await fixture.cleanup();
  }
});

for (
  const relativePath of [
    "scripts/start.ts",
    "scripts/dev.ts",
    "tests/smoke/runtime_smoke_test.ts",
  ] as const
) {
  Deno.test(`doctor catches PLATFORM_ROOT drift in ${relativePath}`, async () => {
    const fixture = await createInitFixture();

    try {
      await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));

      const fileUrl = new URL(relativePath, fixture.root);
      const source = await Deno.readTextFile(fileUrl);
      await Deno.writeTextFile(
        fileUrl,
        source.replace(
          'const PLATFORM_ROOT = "../../repos/superstructure";',
          'const PLATFORM_ROOT = "../platform";',
        ),
      );

      const messages = await captureDoctorFailure(fixture.root);
      assertStringIncludes(
        messages.join("\n"),
        `Starter file "${relativePath}" sets PLATFORM_ROOT to "../platform", but deno.json or deno.jsonc superstructure.platformRoot is "../../repos/superstructure".`,
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

Deno.test("doctor validates healthy local superctl mode", async () => {
  const fixture = await createInitFixture();

  try {
    await withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root));
    await writeMiseTools(fixture.root, {
      deno: "2.7.10",
      node: "25.4.0",
      superctl: "local",
    });
    await writeLocalSuperctlPlugin(fixture.root);
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
      superctl: "local",
    });
    await writeFakeSuperctlSourceRepo(join(fixture.workspacePath, "repos", "superctl"));

    const messages = await withEnv(
      "SUPERCTL_ROOT",
      undefined,
      () => captureDoctorFailure(fixture.root),
    );
    const output = messages.join("\n");
    assertStringIncludes(
      output,
      'Local superctl mode requires ".mise-plugins/superctl/bin/install".',
    );
    assertStringIncludes(
      output,
      'Local superctl mode requires ".mise-plugins/superctl/bin/list-all".',
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
      superctl: "local",
    });
    await writeLocalSuperctlPlugin(fixture.root);

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
      superctl: "local",
    });
    await writeLocalSuperctlPlugin(fixture.root);
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

Deno.test("init uses SUPERSTRUCTURE_PLATFORM_ROOT when provided", async () => {
  const fixture = await createInitFixture({ createDefaultPlatform: false });
  const platformRootPath = join(fixture.workspacePath, "external", "platform-source");

  try {
    await writeFakePlatformRoot(platformRootPath);

    await withEnv(
      "SUPERSTRUCTURE_PLATFORM_ROOT",
      platformRootPath,
      () => initProject(fixture.root),
    );

    const denoConfig = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", fixture.root)),
    ) as {
      superstructure?: { platformRoot?: string };
    };

    assertEquals(denoConfig.superstructure?.platformRoot, "../../external/platform-source");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("init fails clearly when no platform root can be resolved", async () => {
  const fixture = await createInitFixture({ createDefaultPlatform: false });

  try {
    await assertRejects(
      () => withEnv("SUPERSTRUCTURE_PLATFORM_ROOT", undefined, () => initProject(fixture.root)),
      Error,
      "Unable to resolve the Superstructure platform root for this project.",
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("doctor reports healthy configuration without running verification", async () => {
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

    const messages = await captureConsoleLog(() => doctorProject(root));
    assertStringIncludes(messages.join("\n"), "Using deno.json for Deno task configuration.");
    assertStringIncludes(messages.join("\n"), "Configuration looks healthy.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("doctor reports root surface misconfiguration", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-doctor-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.jsonc", {
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
    await writeProjectConfig(root, "deno.json", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });
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

Deno.test("build, start, and dev delegate to required deno tasks", async () => {
  const invocations: string[] = [];
  const runCommand = ({ command }: { command: string }) => {
    invocations.push(command);
    return Promise.resolve(0);
  };

  await buildProject(new URL("file:///tmp/"), runCommand);
  await startProject(new URL("file:///tmp/"), runCommand);
  await devProject(new URL("file:///tmp/"), runCommand);

  assertEquals(invocations, ["build", "start", "dev"]);
});

Deno.test("add service and surface scaffold manifest entries and generated registries", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-project-fixture-" });
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
    assertStringIncludes(serviceDbIndex, "deriveServiceSchemaName('billing-api')");
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

Deno.test("test command enforces required test tasks", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.jsonc", {
      "test:e2e": "echo e2e",
    });

    await addSurface("site", root);

    await assertRejects(
      () => testProject(root),
      Error,
      'Missing required deno.json or deno.jsonc task "test:unit".',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test command runs test tasks in test-only order", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.json", {
      "test:unit": "echo test",
      "test:bruno": "echo bruno",
      "test:ai": "echo ai",
      "test:e2e": "echo e2e",
    });

    await testProject(root, ({ command }) => {
      invocations.push(command);
      return Promise.resolve();
    });

    assertEquals(invocations, ["test:unit", "test:bruno", "test:ai", "test:e2e"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("test command prints a summary at the end", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-test-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      "test:unit": "echo test",
      "test:bruno": "echo bruno",
      "test:e2e": "echo e2e",
    });

    const messages = await captureConsoleLog(() =>
      testProject(root, ({ command }) => {
        switch (command) {
          case "test:unit":
            return Promise.resolve({ code: 0, metrics: { passed: 7, total: 7 } });
          case "test:bruno":
            return Promise.resolve({ code: 0, metrics: { passed: 2, total: 2 } });
          case "test:e2e":
            return Promise.resolve({ code: 0, metrics: { passed: 3, total: 3 } });
          default:
            return Promise.resolve();
        }
      })
    );

    const output = messages.join("\n");
    assertStringIncludes(output, "Test summary");
    assertStringIncludes(output, "✓ Unit tests: 7 of 7 passed");
    assertStringIncludes(output, "✓ Bruno: 2 of 2 passed");
    assertStringIncludes(output, "✓ Playwright browser: 3 of 3 passed");
    assertStringIncludes(output, "Overall: PASSED (4 passed, 0 failed)");
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
    assertStringIncludes(output, "✓ Required tasks: 1 of 1 passed");
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
    await writeProjectConfig(root, "deno.json", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      "test:unit": "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });

    await addService("billing-api", root);
    await addService("analytics-api", root);

    const servicesRegistry = await Deno.readTextFile(
      new URL("superstructure/generated/services.ts", root),
    );
    assertArrayIncludes(servicesRegistry.split("\n"), [
      "export const serviceModules = [BillingApiServiceModule, AnalyticsApiServiceModule] as const;",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build reads tasks from deno.jsonc projects", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-jsonc-run-fixture-" });
  const root = new URL(`file://${rootPath}/`);
  const invocations: string[] = [];

  try {
    await writeProjectConfig(root, "deno.jsonc", {
      build: "echo build",
    });

    await buildProject(root, ({ command }) => {
      invocations.push(command);
      return Promise.resolve(0);
    });

    assertEquals(invocations, ["build"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
