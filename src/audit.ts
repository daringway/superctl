import {
  type CommandRunResult,
  CommandStepError,
  createSummaryStep,
  extractCommandMetrics,
  markStepFailed,
  markStepPassed,
  printCommandSummary,
  runCommandWithLiveOutput,
} from "./command_summary.ts";
import { cwdRootUrl } from "./paths.ts";
import { listChangedFiles } from "./git.ts";

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/mu },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u },
  { label: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
];
const SECRET_SCAN_IGNORED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".tgz",
  ".mp4",
  ".mov",
  ".avif",
]);

export interface AuditCommandInvocation {
  command: string;
  args: string[];
  root: URL;
  label: string;
}

export type AuditCommandRunner = (
  invocation: AuditCommandInvocation,
) => Promise<void | CommandRunResult>;

export async function auditProject(
  root: URL = cwdRootUrl(),
  runCommandFn: AuditCommandRunner = defaultRunCommand,
): Promise<void> {
  const steps = [createSummaryStep("Secret scan")];
  const dependencyAudit = await resolveDependencyAuditInvocation(root);
  if (dependencyAudit) {
    steps.push(createSummaryStep("Dependency audit"));
  }
  const failures: string[] = [];

  const changedFiles = await listChangedFiles(root);
  await collectAuditFailure(
    failures,
    "Secret scan",
    runAuditCheckStep(steps[0], () => runSecretScan(root, changedFiles)),
  );

  if (dependencyAudit) {
    await collectAuditFailure(
      failures,
      "Dependency audit",
      runAuditCommandStep(steps[1], dependencyAudit, runCommandFn),
    );
  }

  printCommandSummary("Audit", steps);
  if (failures.length > 0) {
    throw new Error(`Audit failed:\n- ${failures.join("\n- ")}`);
  }
}

export async function runSecretScan(root: URL, changedFiles: readonly string[]): Promise<void> {
  const issues = await findSecretScanIssues(root, changedFiles);
  if (issues.length === 0) {
    return;
  }

  throw new Error(
    `Secret scan failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
  );
}

export async function findSecretScanIssues(
  root: URL,
  changedFiles: readonly string[],
): Promise<string[]> {
  const issues: string[] = [];

  for (const relativePath of changedFiles) {
    if (shouldSkipSecretScanPath(relativePath)) {
      continue;
    }

    const fileUrl = new URL(relativePath, root);
    let source: string;
    try {
      source = await Deno.readTextFile(fileUrl);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound || error instanceof Deno.errors.InvalidData
      ) {
        continue;
      }
      throw error;
    }

    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        issues.push(`${relativePath}: matched ${label}`);
      }
    }
  }

  return issues;
}

function shouldSkipSecretScanPath(relativePath: string): boolean {
  if (
    relativePath.startsWith(".git/") ||
    relativePath.startsWith("node_modules/") ||
    relativePath.startsWith("coverage/") ||
    relativePath.startsWith("dist/")
  ) {
    return true;
  }

  const extension = relativePath.includes(".")
    ? relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase()
    : "";
  return SECRET_SCAN_IGNORED_EXTENSIONS.has(extension);
}

async function resolveDependencyAuditInvocation(
  root: URL,
): Promise<AuditCommandInvocation | null> {
  if (await pathExists(new URL("deno.lock", root))) {
    return {
      command: "deno",
      args: ["audit", "--level=high", "--ignore-registry-errors"],
      root,
      label: "dependency audit",
    };
  }

  if (!(await pathExists(new URL("package.json", root)))) {
    return null;
  }

  return {
    command: "npm",
    args: ["audit", "--audit-level=high", "--omit=dev"],
    root,
    label: "dependency audit",
  };
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

async function defaultRunCommand(invocation: AuditCommandInvocation): Promise<CommandRunResult> {
  const output = await runCommandWithLiveOutput(
    invocation.command,
    invocation.args,
    decodeURIComponent(invocation.root.pathname),
  );

  const metrics = extractCommandMetrics(
    `${new TextDecoder().decode(output.stdout)}\n${new TextDecoder().decode(output.stderr)}`,
  );
  const result = { code: output.code, metrics };
  if (output.code !== 0) {
    throw new CommandStepError(`Audit failed while running ${invocation.label}.`, result);
  }

  return result;
}

async function runAuditCheckStep(
  step: ReturnType<typeof createSummaryStep>,
  check: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await check();
    markStepPassed(step);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markStepFailed(step, message);
    return message;
  }
}

async function runAuditCommandStep(
  step: ReturnType<typeof createSummaryStep>,
  invocation: AuditCommandInvocation,
  runCommandFn: AuditCommandRunner,
): Promise<string | null> {
  try {
    const result = await runCommandFn(invocation);
    markStepPassed(step, result?.metrics ?? null);
    return null;
  } catch (error) {
    if (error instanceof CommandStepError) {
      markStepFailed(step, error.message, error.result.metrics);
      return error.message;
    }
    const message = error instanceof Error ? error.message : String(error);
    markStepFailed(step, message);
    return message;
  }
}

async function collectAuditFailure(
  failures: string[],
  label: string,
  outcome: Promise<string | null>,
): Promise<void> {
  const message = await outcome;
  if (message) {
    failures.push(`${label}: ${message}`);
  }
}
