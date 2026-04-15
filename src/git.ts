import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectGitChange {
  path: string;
  status: string;
}

export async function listChangedFiles(root: URL): Promise<string[]> {
  return (await listChangedEntries(root)).map((entry) => entry.path);
}

export async function listChangedEntries(root: URL): Promise<ProjectGitChange[]> {
  const changed = new Map<string, string>();
  const pathFilter = await resolveProjectGitPathFilter(root);
  const baseRef = await resolveBaseRef(root);
  if (baseRef) {
    for (
      const change of await runGitChanges(
        root,
        ["diff", "--name-status", `${baseRef}...HEAD`],
        pathFilter,
      )
    ) {
      changed.set(change.path, mergeChangeStatus(changed.get(change.path), change.status));
    }
  }

  for (const change of await runGitChanges(root, ["diff", "--name-status"], pathFilter)) {
    changed.set(change.path, mergeChangeStatus(changed.get(change.path), change.status));
  }
  for (
    const change of await runGitChanges(root, ["diff", "--cached", "--name-status"], pathFilter)
  ) {
    changed.set(change.path, mergeChangeStatus(changed.get(change.path), change.status));
  }
  for (
    const file of await runGitLines(
      root,
      ["ls-files", "--others", "--exclude-standard"],
      pathFilter,
    )
  ) {
    changed.set(file, mergeChangeStatus(changed.get(file), "?"));
  }

  return [...changed.entries()]
    .filter(([path]) => path.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, status]) => ({ path, status }));
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

async function resolveProjectGitPathFilter(root: URL): Promise<string[] | null> {
  const repoRoot = await runGitSingleLine(root, ["rev-parse", "--show-toplevel"], true);
  if (!repoRoot) {
    return null;
  }

  const projectRoot = resolve(fileURLToPath(root));
  const [resolvedRepoRoot, resolvedProjectRoot] = await Promise.all([
    Deno.realPath(repoRoot),
    Deno.realPath(projectRoot),
  ]);
  const relativeProjectRoot = normalizePath(relative(resolvedRepoRoot, resolvedProjectRoot));
  if (relativeProjectRoot === ".") {
    return null;
  }

  return ["--", relativeProjectRoot];
}

async function runGitLines(
  root: URL,
  args: string[],
  pathFilter: string[] | null,
): Promise<string[]> {
  const output = await runGitSingleLine(root, pathFilter ? [...args, ...pathFilter] : args, true);
  if (!output) {
    return [];
  }

  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map(normalizePath);
}

async function runGitChanges(
  root: URL,
  args: string[],
  pathFilter: string[] | null,
): Promise<ProjectGitChange[]> {
  const output = await runGitSingleLine(root, pathFilter ? [...args, ...pathFilter] : args, true);
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/u)
    .map((line) => parseGitChangeLine(line.trim()))
    .filter((change): change is ProjectGitChange => change !== null);
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

function normalizePath(path: string): string {
  return path.length === 0 ? "." : path.split(sep).join("/");
}

function parseGitChangeLine(line: string): ProjectGitChange | null {
  if (line.length === 0) {
    return null;
  }

  const parts = line.split("\t").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const rawStatus = parts[0]!;
  const path = normalizePath(parts.at(-1)!);
  return { path, status: rawStatus[0] ?? rawStatus };
}

function mergeChangeStatus(existing: string | undefined, next: string): string {
  if (!existing) {
    return next;
  }

  return changeStatusPriority(next) > changeStatusPriority(existing) ? next : existing;
}

function changeStatusPriority(status: string): number {
  switch (status) {
    case "?":
    case "A":
      return 0;
    case "M":
      return 1;
    case "R":
    case "C":
    case "T":
      return 2;
    case "D":
    case "U":
      return 3;
    default:
      return 4;
  }
}
