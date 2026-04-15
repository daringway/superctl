import { relative } from "node:path";

import { cwdRootUrl } from "./paths.ts";
import { loadProjectManifest } from "./project.ts";

export interface CommandInvocation {
  args: string[];
  command: string;
  env?: Record<string, string>;
  label: string;
  root: URL;
}

export type RunExternalCommand = (invocation: CommandInvocation) => Promise<number>;

const PROJECT_SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[cm]?[jt]sx)$/u;
const WALK_SKIP_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export async function buildProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  const typecheckTargets = await collectTypecheckTargets(root);

  await runRequired({
    command: "deno",
    args: ["check", ...typecheckTargets],
    label: "typecheck",
    root,
  }, runCommand);

  await runRequired({
    command: "deno",
    args: [
      "eval",
      BUILD_VALIDATION_SCRIPT,
    ],
    env: {
      NODE_ENV: Deno.env.get("NODE_ENV") ?? "test",
      STACK_ENV: Deno.env.get("STACK_ENV") ?? "test",
    },
    label: "build validation",
    root,
  }, runCommand);
}

export async function startProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  await runRequired({
    command: "deno",
    args: ["eval", START_SERVER_SCRIPT],
    label: "start",
    root,
  }, runCommand);
}

export async function devProject(
  root: URL = cwdRootUrl(),
  runCommand: RunExternalCommand = defaultRunCommand,
): Promise<void> {
  await buildProject(root, runCommand);
  await startProject(root, runCommand);
}

async function runRequired(
  invocation: CommandInvocation,
  runCommand: RunExternalCommand,
): Promise<void> {
  const code = await runCommand(invocation);
  if (code !== 0) {
    throw new Error(`Command failed while running ${invocation.label}.`);
  }
}

async function defaultRunCommand(invocation: CommandInvocation): Promise<number> {
  const child = new Deno.Command(invocation.command, {
    args: invocation.args,
    cwd: decodeURIComponent(invocation.root.pathname),
    env: invocation.env ? { ...Deno.env.toObject(), ...invocation.env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).spawn();
  const status = await child.status;
  return status.code;
}

async function collectTypecheckTargets(root: URL): Promise<string[]> {
  const manifest = await loadProjectManifest(root);
  const targets = new Set<string>();

  for (const service of manifest.services) {
    for (const file of await collectSourceFiles(new URL(`${service.directory}/`, root), root)) {
      targets.add(file);
    }
  }

  for (const surface of manifest.surfaces) {
    for (const file of await collectSourceFiles(new URL(`${surface.directory}/`, root), root)) {
      targets.add(file);
    }
  }

  for (const directory of ["superstructure/generated/", "tests/smoke/"]) {
    try {
      for (const file of await collectSourceFiles(new URL(directory, root), root)) {
        targets.add(file);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  if (targets.size === 0) {
    throw new Error(
      "No typecheck targets were discovered. Ensure superstructure.project.json declares surfaces or services.",
    );
  }

  return [...targets].sort();
}

async function collectSourceFiles(directory: URL, root: URL): Promise<string[]> {
  const collected: string[] = [];

  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith(".") || WALK_SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory) {
      collected.push(...await collectSourceFiles(new URL(`${entry.name}/`, directory), root));
      continue;
    }

    if (!entry.isFile || !PROJECT_SOURCE_EXTENSIONS.test(entry.name)) {
      continue;
    }

    collected.push(pathRelativeToRoot(root, entryUrl));
  }

  return collected;
}

function pathRelativeToRoot(root: URL, file: URL): string {
  return relative(decodeURIComponent(root.pathname), decodeURIComponent(file.pathname))
    .replaceAll("\\", "/");
}

const BUILD_VALIDATION_SCRIPT = [
  'import { createServerApp } from "@daringway/superstructure-runtime";',
  "const env = Deno.env.toObject();",
  'env.NODE_ENV ??= "test";',
  'env.STACK_ENV ??= "test";',
  "await createServerApp({ cwd: Deno.cwd(), env });",
].join("\n");

const START_SERVER_SCRIPT = [
  'import { startServer } from "@daringway/superstructure-runtime";',
  "await startServer({ cwd: Deno.cwd() });",
].join("\n");
