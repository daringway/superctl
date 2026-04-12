import {
  type CommandRunResult,
  CommandStepError,
  createSummaryStep,
  markStepFailed,
  markStepPassed,
  printCommandSummary,
  type SummaryStep,
} from "./command_summary.ts";
import { cwdRootUrl } from "./paths.ts";
import {
  hasProjectManifest,
  REQUIRED_GATE_TASKS,
  verifyAgentDocsStructure,
  verifyManifestFiles,
  verifyRequiredTasks,
  verifyServiceDbBoundaries,
} from "./project_checks.ts";

export interface GateCommandInvocation {
  command: string;
  args: string[];
  root: URL;
  label: string;
}

export type GateCommandRunner = (
  invocation: GateCommandInvocation,
) => Promise<void | CommandRunResult>;

export async function gateProject(
  root: URL = cwdRootUrl(),
  runCommandFn: GateCommandRunner = defaultRunCommand,
): Promise<void> {
  const manifestProject = await hasProjectManifest(root);
  const steps = [
    createSummaryStep("Project structure"),
    ...(manifestProject
      ? [createSummaryStep("Manifest files"), createSummaryStep("Service DB boundaries")]
      : []),
    createSummaryStep("Required tasks"),
    createSummaryStep("Format check"),
    createSummaryStep("Lint"),
    createSummaryStep("Exec plan completion"),
  ];
  const failures: string[] = [];

  let index = 0;
  await collectGateFailure(
    failures,
    "Project structure",
    runGateCheckStep(steps[index++], () => verifyAgentDocsStructure(root)),
  );
  if (manifestProject) {
    await collectGateFailure(
      failures,
      "Manifest files",
      runGateCheckStep(steps[index++], () => verifyManifestFiles(root)),
    );
    await collectGateFailure(
      failures,
      "Service DB boundaries",
      runGateCheckStep(steps[index++], () => verifyServiceDbBoundaries(root)),
    );
  }

  const requiredTasks = manifestProject ? REQUIRED_GATE_TASKS : ["lint"];
  await collectGateFailure(
    failures,
    "Required tasks",
    runGateCheckStep(steps[index++], () => verifyRequiredTasks(root, requiredTasks)),
  );

  await collectGateFailure(
    failures,
    "Format check",
    runGateCommandStep(
      steps[index++],
      { command: "deno", args: ["fmt", "--check", "."], root, label: "format check" },
      runCommandFn,
    ),
  );
  await collectGateFailure(
    failures,
    "Lint",
    runGateCommandStep(
      steps[index++],
      { command: "deno", args: ["task", "lint"], root, label: "lint" },
      runCommandFn,
    ),
  );

  const changedFiles = await listChangedFiles(root);
  await collectGateFailure(
    failures,
    "Exec plan completion",
    runGateCheckStep(steps[index], () => verifyCompletedExecPlan(root, changedFiles)),
  );

  printCommandSummary("Gate", steps);
  if (failures.length > 0) {
    throw new Error(`Gate failed:\n- ${failures.join("\n- ")}`);
  }
}

export async function verifyCompletedExecPlan(
  root: URL,
  changedFiles: readonly string[],
): Promise<void> {
  if (changedFiles.length === 0) {
    return;
  }

  const execPlanFiles = changedFiles.filter((file) =>
    file.startsWith("agent-docs/exec-plans/") && file.endsWith(".md")
  );

  for (const relativePath of execPlanFiles) {
    if (relativePath.startsWith("agent-docs/exec-plans/completed/")) {
      return;
    }

    try {
      const source = await Deno.readTextFile(new URL(relativePath, root));
      if (extractPlanStatus(source) === "Completed") {
        return;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    "superctl gate requires at least one changed exec-plan marked Completed under agent-docs/exec-plans/.",
  );
}

export function extractPlanStatus(source: string): string | null {
  const lines = source.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "## Status") {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const value = lines[nextIndex].trim();
      if (!value) {
        continue;
      }
      return value.replace(/\.$/u, "");
    }
  }

  return null;
}

async function listChangedFiles(root: URL): Promise<string[]> {
  const changed = new Set<string>();
  const baseRef = await resolveBaseRef(root);
  if (baseRef) {
    for (const file of await runGitLines(root, ["diff", "--name-only", `${baseRef}...HEAD`])) {
      changed.add(file);
    }
  }

  for (const file of await runGitLines(root, ["diff", "--name-only"])) {
    changed.add(file);
  }
  for (const file of await runGitLines(root, ["diff", "--cached", "--name-only"])) {
    changed.add(file);
  }
  for (const file of await runGitLines(root, ["ls-files", "--others", "--exclude-standard"])) {
    changed.add(file);
  }

  return [...changed].filter((file) => file.length > 0).sort();
}

async function resolveBaseRef(root: URL): Promise<string | null> {
  const githubBaseRef = Deno.env.get("GITHUB_BASE_REF");
  if (githubBaseRef && await gitRefExists(root, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  const remoteHead = await runGitSingleLine(
    root,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    true,
  );
  if (remoteHead && await gitRefExists(root, remoteHead)) {
    return remoteHead;
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await gitRefExists(root, candidate)) {
      return candidate;
    }
  }

  if (await gitRefExists(root, "HEAD~1")) {
    return "HEAD~1";
  }

  return null;
}

async function gitRefExists(root: URL, ref: string): Promise<boolean> {
  const status = await runGit(root, ["rev-parse", "--verify", ref], true);
  return status.success;
}

async function runGitLines(root: URL, args: string[]): Promise<string[]> {
  const output = await runGitSingleLine(root, args, true);
  if (!output) {
    return [];
  }

  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function runGitSingleLine(
  root: URL,
  args: string[],
  allowFailure = false,
): Promise<string | null> {
  const status = await runGit(root, args, allowFailure);
  if (!status.success) {
    return null;
  }
  return status.stdout.trim() || null;
}

async function runGit(
  root: URL,
  args: string[],
  allowFailure = false,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", {
    args,
    cwd: decodeURIComponent(root.pathname),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();

  if (!output.success && !allowFailure) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    const stdout = new TextDecoder().decode(output.stdout).trim();
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed.`);
  }

  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function defaultRunCommand(invocation: GateCommandInvocation): Promise<CommandRunResult> {
  const child = new Deno.Command(invocation.command, {
    args: invocation.args,
    cwd: decodeURIComponent(invocation.root.pathname),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).spawn();
  const status = await child.status;
  if (status.code !== 0) {
    throw new CommandStepError(`Gate failed while running ${invocation.label}.`, {
      code: status.code,
      metrics: null,
    });
  }

  return { code: status.code, metrics: null };
}

async function runGateCheckStep(
  step: SummaryStep,
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

async function runGateCommandStep(
  step: SummaryStep,
  invocation: GateCommandInvocation,
  runCommandFn: GateCommandRunner,
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

async function collectGateFailure(
  failures: string[],
  label: string,
  outcome: Promise<string | null>,
): Promise<void> {
  const message = await outcome;
  if (message) {
    failures.push(`${label}: ${message}`);
  }
}
