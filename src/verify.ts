import {
  type CommandRunResult,
  CommandStepError,
  createSummaryStep,
  extractCommandMetrics,
  markStepFailed,
  markStepPassed,
  printCommandSummary,
  writeCapturedOutput,
} from "./command_summary.ts";
import { cwdRootUrl } from "./paths.ts";
import type { CommandInvocation } from "./run.ts";
import { verifyRequiredTasks } from "./project_checks.ts";

const REQUIRED_VERIFY_TASKS = ["test:unit", "test:e2e"] as const;
const OPTIONAL_VERIFY_TASKS = ["test:bruno", "test:ai"] as const;
const VERIFY_STEP_LABELS: Record<string, string> = {
  "test:unit": "Unit tests",
  "test:bruno": "Bruno",
  "test:ai": "AI component tests",
  "test:e2e": "Playwright browser",
};

export type VerifyCommandRunner = (
  invocation: CommandInvocation,
) => Promise<void | CommandRunResult>;

export async function testProject(
  root: URL = cwdRootUrl(),
  runCommandFn: VerifyCommandRunner = defaultRunCommand,
): Promise<void> {
  const steps = [createSummaryStep("Required test tasks")];

  try {
    const tasks = await verifyRequiredTasks(root, REQUIRED_VERIFY_TASKS);
    markStepPassed(steps[0]);

    const taskQueue = [
      "test:unit",
      ...OPTIONAL_VERIFY_TASKS.filter((task) => Boolean(tasks[task])),
      "test:e2e",
    ];

    for (const task of taskQueue) {
      const step = createSummaryStep(VERIFY_STEP_LABELS[task] ?? task);
      steps.push(step);

      try {
        const result = await runCommandFn({ command: task, args: [task], root });
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
    if (steps[0].status === "not-run") {
      markStepFailed(steps[0], error instanceof Error ? error.message : String(error));
    }
    printCommandSummary("Test", steps);
    throw error;
  }

  printCommandSummary("Test", steps);
}

export const verifyProject = testProject;

async function defaultRunCommand(invocation: CommandInvocation): Promise<CommandRunResult> {
  const output = await new Deno.Command("deno", {
    args: ["task", invocation.command],
    cwd: decodeURIComponent(invocation.root.pathname),
    stdout: "piped",
    stderr: "piped",
    stdin: "inherit",
  }).output();

  await writeCapturedOutput(output.stdout, output.stderr);

  const metrics = extractCommandMetrics(
    `${new TextDecoder().decode(output.stdout)}\n${new TextDecoder().decode(output.stderr)}`,
  );
  const result = { code: output.code, metrics };
  if (output.code !== 0) {
    throw new CommandStepError(
      `Test command failed while running "deno task ${invocation.command}".`,
      result,
    );
  }

  return result;
}
