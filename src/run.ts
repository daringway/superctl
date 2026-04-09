import { denoConfigLabel, loadDenoProjectTasks } from "./deno_config.ts";
import { cwdRootUrl } from "./paths.ts";

export interface CommandInvocation {
  command: string;
  args: string[];
  root: URL;
}

export type RunExternalCommand = (invocation: CommandInvocation) => Promise<number>;

export async function buildProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  await runRequired(invocation(root, "build"), runCommand);
}

export async function startProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  await runRequired(invocation(root, "start"), runCommand);
}

export async function devProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  await runRequired(invocation(root, "dev"), runCommand);
}

function invocation(root: URL, command: string): CommandInvocation {
  return { command, args: [command], root };
}

async function runRequired(
  command: CommandInvocation,
  runCommand: RunExternalCommand,
): Promise<void> {
  const code = await runCommand(command);
  if (code !== 0) {
    throw new Error(`Command failed: ${command.args.join(" ")}`);
  }
}

async function defaultRunCommand(invocation: CommandInvocation): Promise<number> {
  const cwd = decodeURIComponent(invocation.root.pathname);
  const denoTasks = await loadDenoProjectTasks(invocation.root);
  if (denoTasks[invocation.command]) {
    const child = new Deno.Command("deno", {
      args: ["task", invocation.command],
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }).spawn();
    const status = await child.status;
    return status.code;
  }

  throw new Error(
    `Missing execution entry for "${invocation.command}". Define ${denoConfigLabel()} task "${invocation.command}".`,
  );
}
