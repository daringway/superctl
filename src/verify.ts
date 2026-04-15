import { relative } from "node:path";

import {
  type CommandMetrics,
  type CommandRunResult,
  CommandStepError,
  createSummaryStep,
  extractCommandMetrics,
  markStepFailed,
  markStepPassed,
  markStepSkipped,
  printCommandSummary,
  runCommandWithLiveOutput,
} from "./command_summary.ts";
import { cwdRootUrl } from "./paths.ts";
import { loadProjectManifest } from "./project.ts";

export const TEST_BUCKETS = ["smoke", "unit", "api", "ui", "app"] as const;

export type TestBucket = (typeof TEST_BUCKETS)[number];

const TEST_FILE_PATTERN = /(?:\.browser\.test|\.test|\.spec|_test)\.(?:[cm]?[jt]sx?)$/u;
const BRUNO_ENVIRONMENT_FILES = [
  "tests/bruno/environments/test.yml",
  "tests/bruno/environments/local.yml",
];
const TEST_SCAN_SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const TEST_SERVER_STARTUP_WAIT_MS = 30_000;
const TEST_SERVER_POLL_INTERVAL_MS = 500;

const BUCKET_LABELS: Record<TestBucket, string> = {
  smoke: "Smoke tests",
  unit: "Unit tests",
  api: "API tests",
  ui: "UI tests",
  app: "App tests",
};

type TestRunnerKind = "deno" | "vitest-node" | "vitest-browser" | "playwright" | "bruno";

interface DiscoveredTestFile {
  bucket: TestBucket;
  path: string;
  runner: Exclude<TestRunnerKind, "bruno">;
}

interface TestCommandInvocation {
  args: string[];
  command: string;
  env?: Record<string, string>;
  label: string;
  root: URL;
}

interface TestCommandPlan {
  commands: TestCommandInvocation[];
  label: string;
  requiresServer: boolean;
}

interface BucketRunOutcome {
  metrics: CommandMetrics | null;
  status: "passed" | "failed" | "skipped";
}

interface BackgroundServer {
  publicUrl: string;
  stop(): Promise<void>;
}

export type VerifyCommandRunner = (
  invocation: TestCommandInvocation,
) => Promise<void | CommandRunResult>;

export async function testProject(
  root: URL = cwdRootUrl(),
  bucket: TestBucket | null = null,
  runCommandFn: VerifyCommandRunner = defaultRunCommand,
): Promise<void> {
  if (bucket) {
    const outcome = await runTestBucket(root, bucket, runCommandFn);
    if (outcome.status === "failed") {
      throw new Error(`${BUCKET_LABELS[bucket]} failed.`);
    }
    return;
  }

  const steps = TEST_BUCKETS.map((entry) => createSummaryStep(BUCKET_LABELS[entry]));
  let failureMessage: string | null = null;

  for (const [index, entry] of TEST_BUCKETS.entries()) {
    try {
      const outcome = await runTestBucket(root, entry, runCommandFn);
      if (outcome.status === "skipped") {
        markStepSkipped(steps[index], "No tests found for this bucket.");
        continue;
      }

      markStepPassed(steps[index], outcome.metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markStepFailed(steps[index], message);
      failureMessage = message;
      break;
    }
  }

  printCommandSummary("Test", steps);
  if (failureMessage) {
    throw new Error(failureMessage);
  }
}

export const verifyProject = testProject;

async function runTestBucket(
  root: URL,
  bucket: TestBucket,
  runCommandFn: VerifyCommandRunner,
): Promise<BucketRunOutcome> {
  const plan = await createTestCommandPlan(root, bucket);
  const steps = plan.commands.length > 0
    ? plan.commands.map((command) => createSummaryStep(command.label))
    : [createSummaryStep(plan.label)];

  if (plan.commands.length === 0) {
    markStepSkipped(steps[0], "No tests found for this bucket.");
    printCommandSummary(`Test (${bucket})`, steps);
    return { status: "skipped", metrics: null };
  }

  let server: BackgroundServer | null = null;

  try {
    if (plan.requiresServer) {
      server = await startBackgroundTestServer(root);
    }

    for (const [index, command] of plan.commands.entries()) {
      const step = steps[index];

      try {
        const result = await runCommandFn(command);
        markStepPassed(step, result?.metrics ?? null);
      } catch (error) {
        if (error instanceof CommandStepError) {
          markStepFailed(step, error.message, error.result.metrics);
        } else {
          markStepFailed(step, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    }
  } catch (error) {
    printCommandSummary(`Test (${bucket})`, steps);
    throw error;
  } finally {
    await server?.stop();
  }

  printCommandSummary(`Test (${bucket})`, steps);
  return {
    status: "passed",
    metrics: sumMetrics(steps.map((step) => step.metrics)),
  };
}

async function createTestCommandPlan(root: URL, bucket: TestBucket): Promise<TestCommandPlan> {
  const hasVitestConfig = await findFirstExistingPath(root, [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.cts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.cjs",
  ]) !== null;
  const hasPlaywrightConfig = await findFirstExistingPath(root, [
    "playwright.config.ts",
    "playwright.config.mts",
    "playwright.config.cts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs",
  ]) !== null;
  const hasBrowserRunner = await pathExists(new URL("scripts/vitest-browser-runner.mjs", root));
  const files = (await discoverTestFiles(root, hasVitestConfig, hasPlaywrightConfig))
    .filter((entry) => entry.bucket === bucket);

  const byRunner = new Map<TestRunnerKind, string[]>();
  for (const file of files) {
    const paths = byRunner.get(file.runner) ?? [];
    paths.push(file.path);
    byRunner.set(file.runner, paths);
  }

  const commands: TestCommandInvocation[] = [];

  if ((byRunner.get("deno")?.length ?? 0) > 0) {
    commands.push({
      command: "deno",
      args: ["test", "-A", ...sortPaths(byRunner.get("deno")!)],
      label: denoLabelForBucket(bucket),
      root,
    });
  }

  if ((byRunner.get("vitest-node")?.length ?? 0) > 0) {
    commands.push({
      command: "deno",
      args: [
        "run",
        "-A",
        "npm:vitest",
        "run",
        "--project",
        "node",
        ...sortPaths(byRunner.get("vitest-node")!),
      ],
      env: {
        NODE_ENV: "test",
        STACK_ENV: "test",
      },
      label: vitestNodeLabelForBucket(bucket),
      root,
    });
  }

  if ((byRunner.get("vitest-browser")?.length ?? 0) > 0) {
    const browserFiles = sortPaths(byRunner.get("vitest-browser")!);
    commands.push({
      command: "deno",
      args: hasBrowserRunner
        ? ["run", "-A", "scripts/vitest-browser-runner.mjs", ...browserFiles]
        : ["run", "-A", "npm:vitest", "run", "--project", "browser", ...browserFiles],
      env: {
        NODE_ENV: "test",
        STACK_ENV: "test",
      },
      label: "Vitest browser",
      root,
    });
  }

  if ((byRunner.get("playwright")?.length ?? 0) > 0) {
    const configFile = await findFirstExistingPath(root, [
      "playwright.config.ts",
      "playwright.config.mts",
      "playwright.config.cts",
      "playwright.config.js",
      "playwright.config.mjs",
      "playwright.config.cjs",
    ]);
    commands.push({
      command: "deno",
      args: [
        "run",
        "-A",
        "npm:playwright",
        "test",
        ...(configFile ? ["--config", configFile] : []),
        ...sortPaths(byRunner.get("playwright")!),
      ],
      label: "Playwright browser",
      root,
    });
  }

  if (bucket === "api") {
    const brunoEnvironment = await resolveBrunoEnvironment(root);
    if (await pathExists(new URL("tests/bruno/", root))) {
      commands.push({
        command: "npx",
        args: [
          "-y",
          "@usebruno/cli@latest",
          "run",
          "tests/bruno",
          ...(brunoEnvironment ? ["--env", brunoEnvironment] : []),
        ],
        label: "Bruno API collection",
        root,
      });
    }
  }

  return {
    commands,
    label: BUCKET_LABELS[bucket],
    requiresServer: bucket === "api" &&
      commands.some((entry) => entry.label === "Bruno API collection"),
  };
}

async function discoverTestFiles(
  root: URL,
  hasVitestConfig: boolean,
  hasPlaywrightConfig: boolean,
): Promise<DiscoveredTestFile[]> {
  const files: DiscoveredTestFile[] = [];

  await walkFiles(root, root, async (relativePath, fileUrl) => {
    if (!TEST_FILE_PATTERN.test(relativePath)) {
      return;
    }

    const bucket = classifyBucket(relativePath);
    if (!bucket) {
      return;
    }

    const source = await Deno.readTextFile(fileUrl);
    const runner = classifyRunner(relativePath, source, bucket, {
      hasPlaywrightConfig,
      hasVitestConfig,
    });

    files.push({
      bucket,
      path: relativePath,
      runner,
    });
  });

  return files;
}

function classifyBucket(relativePath: string): TestBucket | null {
  if (relativePath.startsWith("tests/fixtures/") || relativePath.startsWith("tests/harness/")) {
    return null;
  }
  if (relativePath.startsWith("tests/smoke/")) {
    return "smoke";
  }
  if (relativePath.startsWith("tests/db/")) {
    return "api";
  }
  if (relativePath.startsWith("tests/e2e/")) {
    return "app";
  }
  if (relativePath.startsWith("superstructure/surfaces/")) {
    return "ui";
  }
  return "unit";
}

function classifyRunner(
  relativePath: string,
  source: string,
  bucket: TestBucket,
  options: {
    hasPlaywrightConfig: boolean;
    hasVitestConfig: boolean;
  },
): Exclude<TestRunnerKind, "bruno"> {
  if (/\.browser\.test\.[cm]?[jt]sx?$/u.test(relativePath) && options.hasVitestConfig) {
    return "vitest-browser";
  }
  if (source.includes("@playwright/test")) {
    return options.hasPlaywrightConfig ? "playwright" : "deno";
  }
  if (source.includes("Deno.test")) {
    return "deno";
  }
  if (bucket === "app" && options.hasPlaywrightConfig) {
    return "playwright";
  }
  return options.hasVitestConfig ? "vitest-node" : "deno";
}

async function walkFiles(
  root: URL,
  directory: URL,
  visit: (relativePath: string, fileUrl: URL) => Promise<void>,
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith(".") || TEST_SCAN_SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory) {
      await walkFiles(root, new URL(`${entry.name}/`, directory), visit);
      continue;
    }

    if (!entry.isFile) {
      continue;
    }

    await visit(pathRelativeToRoot(root, entryUrl), entryUrl);
  }
}

async function defaultRunCommand(invocation: TestCommandInvocation): Promise<CommandRunResult> {
  const output = await runCommandWithLiveOutput(
    invocation.command,
    invocation.args,
    decodeURIComponent(invocation.root.pathname),
    invocation.env,
    {},
  );

  const metrics = extractCommandMetrics(
    `${new TextDecoder().decode(output.stdout)}\n${new TextDecoder().decode(output.stderr)}`,
  );
  const result = { code: output.code, metrics };
  if (output.code !== 0) {
    throw new CommandStepError(
      `Test command failed while running "${invocation.command} ${invocation.args.join(" ")}".`,
      result,
    );
  }

  return result;
}

async function startBackgroundTestServer(root: URL): Promise<BackgroundServer> {
  const runtime = await resolveTestServerRuntime(root);
  const child = new Deno.Command("deno", {
    args: ["eval", START_TEST_SERVER_SCRIPT],
    cwd: decodeURIComponent(root.pathname),
    env: {
      ...Deno.env.toObject(),
      ...runtime.env,
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  let exitCode: number | null = null;
  const statusPromise = child.status.then((status) => {
    exitCode = status.code;
    return status;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < TEST_SERVER_STARTUP_WAIT_MS) {
    if (exitCode !== null) {
      throw new Error(`Background test server exited before it became ready (code ${exitCode}).`);
    }

    try {
      const response = await fetch(`${runtime.publicUrl}/api/system/health`);
      if (response.ok) {
        return {
          publicUrl: runtime.publicUrl,
          async stop() {
            try {
              child.kill("SIGTERM");
            } catch {
              // Process already exited.
            }
            await statusPromise;
          },
        };
      }
    } catch {
      // Keep polling until the server is ready or times out.
    }

    await sleep(TEST_SERVER_POLL_INTERVAL_MS);
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Process already exited.
  }
  await statusPromise;
  throw new Error(`Timed out waiting for the background test server at ${runtime.publicUrl}.`);
}

async function resolveTestServerRuntime(root: URL): Promise<{
  env: Record<string, string>;
  publicUrl: string;
}> {
  const manifest = await loadProjectManifest(root);
  const brunoBaseUrl = await resolveBrunoBaseUrl(root);
  const parsedBaseUrl = brunoBaseUrl ? new URL(brunoBaseUrl) : null;
  const publicUrl = parsedBaseUrl
    ? `${parsedBaseUrl.protocol}//${parsedBaseUrl.host}`
    : `http://127.0.0.1:${manifest.deployment.serverPort ?? 15000}`;
  const serverUrl = new URL(publicUrl);

  return {
    env: {
      APP_BASE_URL: publicUrl,
      NODE_ENV: "test",
      RESEND_API_KEY: Deno.env.get("RESEND_API_KEY") ?? "re_test_signup",
      RESEND_FROM_EMAIL: Deno.env.get("RESEND_FROM_EMAIL") ?? "onboarding@superstructure.dev",
      STACK_ENV: "test",
      STACK_SERVER_HOST: serverUrl.hostname,
      STACK_SERVER_PORT: serverUrl.port || "80",
      STACK_SERVER_PUBLIC_URL: publicUrl,
      STACK_TEST_SECRET: Deno.env.get("STACK_TEST_SECRET") ?? "platform-test-secret",
    },
    publicUrl,
  };
}

async function resolveBrunoEnvironment(root: URL): Promise<string | null> {
  for (const relativePath of BRUNO_ENVIRONMENT_FILES) {
    if (!(await pathExists(new URL(relativePath, root)))) {
      continue;
    }

    return relativePath.includes("/test.") ? "test" : "local";
  }

  return null;
}

async function resolveBrunoBaseUrl(root: URL): Promise<string | null> {
  for (const relativePath of BRUNO_ENVIRONMENT_FILES) {
    try {
      const source = await Deno.readTextFile(new URL(relativePath, root));
      const match = source.match(/name:\s*baseUrl[\s\S]*?value:\s*([^\s]+)/u);
      if (match?.[1]) {
        return match[1].trim();
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

async function findFirstExistingPath(
  root: URL,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(new URL(candidate, root))) {
      return candidate;
    }
  }

  return null;
}

async function pathExists(path: URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function pathRelativeToRoot(root: URL, file: URL): string {
  return relative(decodeURIComponent(root.pathname), decodeURIComponent(file.pathname))
    .replaceAll("\\", "/");
}

function sumMetrics(metrics: Array<CommandMetrics | null>): CommandMetrics | null {
  const defined = metrics.filter((entry): entry is CommandMetrics => entry !== null);
  if (defined.length === 0) {
    return null;
  }

  return defined.reduce(
    (sum, entry) => ({
      passed: sum.passed + entry.passed,
      total: sum.total + entry.total,
    }),
    { passed: 0, total: 0 },
  );
}

function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort();
}

function denoLabelForBucket(bucket: TestBucket): string {
  switch (bucket) {
    case "smoke":
      return "Deno smoke tests";
    case "unit":
      return "Deno unit tests";
    case "api":
      return "Deno API tests";
    case "ui":
      return "Deno UI tests";
    case "app":
      return "Deno app tests";
  }
}

function vitestNodeLabelForBucket(bucket: TestBucket): string {
  switch (bucket) {
    case "unit":
      return "Vitest node";
    case "api":
      return "Vitest API integration";
    case "ui":
      return "Vitest UI";
    case "smoke":
      return "Vitest smoke";
    case "app":
      return "Vitest app";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const START_TEST_SERVER_SCRIPT = [
  'import { startServer } from "@daringway/superstructure-runtime";',
  "const env = Deno.env.toObject();",
  'env.NODE_ENV ??= "test";',
  'env.STACK_ENV ??= "test";',
  "await startServer({ cwd: Deno.cwd(), env });",
].join("\n");
