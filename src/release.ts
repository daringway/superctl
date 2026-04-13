import { fileURLToPath } from "node:url";

import { readJsonFile, writeJsonFile } from "./fs.ts";

export type ReleaseBumpKind = "major" | "minor" | "patch";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  rc: number | null;
}

interface ReleaseConfig {
  version?: unknown;
  [key: string]: unknown;
}

interface ReleaseDependencies {
  createGitTag: (root: URL, tag: string) => Promise<void>;
}

const defaultReleaseDependencies: ReleaseDependencies = {
  createGitTag,
};

export interface ReleaseBumpOptions {
  createTag?: boolean;
  prerelease?: boolean;
}

export interface ReleaseBumpResult {
  previousVersion: string;
  nextVersion: string;
  tag: string;
}

export function formatReleaseTag(version: string): string {
  return `v${version}`;
}

export async function bumpReleaseVersion(
  root: URL,
  kind: ReleaseBumpKind,
  options: ReleaseBumpOptions = {},
  dependencies: Partial<ReleaseDependencies> = {},
): Promise<ReleaseBumpResult> {
  const configPath = new URL("deno.json", root);
  const config = await readJsonFile<ReleaseConfig>(configPath);
  const currentVersion = readCurrentVersion(config);
  const nextVersion = bumpVersion(currentVersion, kind, options.prerelease ?? false);

  await writeJsonFile(configPath, { ...config, version: nextVersion });

  const resolvedDependencies = { ...defaultReleaseDependencies, ...dependencies };
  if (options.createTag ?? false) {
    await resolvedDependencies.createGitTag(root, formatReleaseTag(nextVersion));
  }

  return {
    previousVersion: currentVersion,
    nextVersion,
    tag: formatReleaseTag(nextVersion),
  };
}

export function bumpVersion(
  currentVersion: string,
  kind: ReleaseBumpKind,
  prerelease = false,
): string {
  const parsed = parseVersion(currentVersion);
  const next = prerelease ? nextPrereleaseVersion(parsed, kind) : nextStableVersion(parsed, kind);
  return formatVersion(next);
}

export function parseVersion(version: string): ParsedVersion {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/u);
  if (!match) {
    throw new Error(
      `Unsupported superctl version "${version}". Expected "x.y.z" or "x.y.z-rcN".`,
    );
  }

  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
    rc: match[4] ? Number.parseInt(match[4], 10) : null,
  };
}

function nextStableVersion(current: ParsedVersion, kind: ReleaseBumpKind): ParsedVersion {
  if (current.rc !== null && inferredReleaseKind(current) === kind) {
    return { ...current, rc: null };
  }

  return { ...bumpStableVersion(stripPrerelease(current), kind), rc: null };
}

function nextPrereleaseVersion(current: ParsedVersion, kind: ReleaseBumpKind): ParsedVersion {
  if (current.rc !== null && inferredReleaseKind(current) === kind) {
    return { ...current, rc: current.rc + 1 };
  }

  return { ...bumpStableVersion(stripPrerelease(current), kind), rc: 1 };
}

function bumpStableVersion(current: ParsedVersion, kind: ReleaseBumpKind): ParsedVersion {
  switch (kind) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0, rc: null };
    case "minor":
      return { major: current.major, minor: current.minor + 1, patch: 0, rc: null };
    case "patch":
      return { major: current.major, minor: current.minor, patch: current.patch + 1, rc: null };
  }
}

function inferredReleaseKind(current: ParsedVersion): ReleaseBumpKind {
  if (current.patch > 0) {
    return "patch";
  }
  if (current.minor > 0) {
    return "minor";
  }
  return "major";
}

function stripPrerelease(current: ParsedVersion): ParsedVersion {
  return { major: current.major, minor: current.minor, patch: current.patch, rc: null };
}

function formatVersion(current: ParsedVersion): string {
  const base = `${current.major}.${current.minor}.${current.patch}`;
  return current.rc === null ? base : `${base}-rc${current.rc}`;
}

function readCurrentVersion(config: ReleaseConfig): string {
  const version = config.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error('deno.json must define a non-empty string "version".');
  }
  return version.trim();
}

async function createGitTag(root: URL, tag: string): Promise<void> {
  const output = await new Deno.Command("git", {
    args: ["tag", tag],
    cwd: fileURLToPath(root),
    stdout: "null",
    stderr: "piped",
  }).output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(stderr || `Could not create git tag "${tag}".`);
  }
}
