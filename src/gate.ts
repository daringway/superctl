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
  verifyAgentDocsStructure,
  verifyDenoConfig,
  verifyManifestFiles,
  verifyServiceDbBoundaries,
  verifyTestLayout,
} from "./project_checks.ts";
import { listChangedEntries, type ProjectGitChange } from "./git.ts";

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
  let denoConfigFile: string | null = null;
  const steps = [
    createSummaryStep("Project structure"),
    ...(manifestProject
      ? [createSummaryStep("Manifest files"), createSummaryStep("Service DB boundaries")]
      : []),
    createSummaryStep("Deno config"),
    createSummaryStep("Test layout"),
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

  await collectGateFailure(
    failures,
    "Deno config",
    runGateCheckStep(steps[index++], async () => {
      denoConfigFile = await verifyDenoConfig(root);
    }),
  );
  await collectGateFailure(
    failures,
    "Test layout",
    runGateCheckStep(steps[index++], () => verifyTestLayout(root)),
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
      {
        command: "deno",
        args: ["lint", "--config", denoConfigFile ?? "deno.json", "."],
        root,
        label: "lint",
      },
      runCommandFn,
    ),
  );

  const changedFiles = await listChangedEntries(root);
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
  changedFiles: readonly ProjectGitChange[],
): Promise<void> {
  if (changedFiles.length === 0) {
    return;
  }

  if (changedFiles.every((change) => change.status === "A" || change.status === "?")) {
    return;
  }

  const execPlanFiles = changedFiles
    .map((change) => change.path)
    .filter((file) => file.startsWith("agent-docs/exec-plans/") && file.endsWith(".md"));

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
