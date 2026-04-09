import {
  assertArrayIncludes,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve } from "node:path";

import { main } from "../main.ts";
import { doctorProject } from "../src/doctor.ts";
import { buildProject, devProject, startProject } from "../src/run.ts";
import { addService, addSurface, initProject } from "../src/scaffold.ts";
import { verifyProject } from "../src/verify.ts";
import { SUPERCTL_VERSION } from "../src/version.ts";

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
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno task check",
        "",
      ].join("\n"),
  );
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
      new URL("tests/runtime_smoke_test.ts", fixture.root),
    );
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
        "test",
        "test:coverage",
        "test:e2e",
        "typecheck",
      ],
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
    assertStringIncludes(qualityWorkflow, "pull_request");
    assertStringIncludes(qualityWorkflow, "deno task check");
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
          "deno check scripts/start.ts scripts/dev.ts superstructure/surfaces/site/index.ts superstructure/surfaces/site/surface.tsx tests/runtime_smoke_test.ts",
        test: "deno test -A tests",
        "test:coverage": "deno test -A --coverage=coverage tests",
        "test:e2e": "deno test -A tests/runtime_smoke_test.ts",
        check: "deno task lint && deno task typecheck && deno task test && deno task build",
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
          "deno check scripts/start.ts scripts/dev.ts superstructure/surfaces/site/index.ts superstructure/surfaces/site/surface.tsx tests/runtime_smoke_test.ts",
        test: "deno test -A tests",
        "test:coverage": "deno test -A --coverage=coverage tests",
        "test:e2e": "deno test -A tests/runtime_smoke_test.ts",
        check: "deno task lint && deno task typecheck && deno task test && deno task build",
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
    "tests/runtime_smoke_test.ts",
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
      test: "echo test",
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
      test: "echo test",
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
      test: "echo test",
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
      test: "echo test",
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

Deno.test("verify rejects custom services importing platform DB internals", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-verify-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.json", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
      test: "echo test",
      "test:coverage": "echo coverage",
      "test:e2e": "echo e2e",
    });

    await addService("billing-api", root);
    await Deno.writeTextFile(
      new URL("superstructure/services/billing-api/service.ts", root),
      "import '../../../apps/server/src/api/db/index.ts';\n",
    );

    await assertRejects(
      () => verifyProject(root),
      Error,
      "must not import platform DB internals",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("verify enforces required deno tasks", async () => {
  const rootPath = await Deno.makeTempDir({ prefix: "superctl-verify-fixture-" });
  const root = new URL(`file://${rootPath}/`);

  try {
    await writeProjectConfig(root, "deno.jsonc", {
      build: "echo build",
      start: "echo start",
      dev: "echo dev",
      check: "echo check",
    });

    await addSurface("site", root);

    await assertRejects(
      () => verifyProject(root),
      Error,
      'Missing required deno.json or deno.jsonc task "test".',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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
      test: "echo test",
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
