import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  denoConfigLabel,
  type DenoProjectConfig,
  findDenoProjectConfigFile,
  loadDenoProjectConfig,
  loadDenoProjectTasks,
} from "./deno_config.ts";
import { cwdRootUrl } from "./paths.ts";
import { listTestLayoutIssues } from "./project_checks.ts";
import { loadProjectManifest, ProjectManifest } from "./project.ts";
import { SUPERCTL_VERSION } from "./version.ts";

const REQUIRED_DENO_TASKS = ["build", "start", "dev", "check"] as const;
const REQUIRED_TEST_TASKS = ["test:unit", "test:coverage", "test:e2e"] as const;
const QUALITY_WORKFLOW_FILES = [
  ".github/workflows/quality.yml",
  ".github/workflows/quality.yaml",
] as const;
const STARTER_PLATFORM_ROOT_FILES = [
  "scripts/start.ts",
  "scripts/dev.ts",
  "tests/smoke/runtime_smoke_test.ts",
] as const;
const LOCAL_SUPERCTL_PLUGIN_FILES = [
  ".mise-plugins/superctl/bin/install",
  ".mise-plugins/superctl/bin/list-all",
] as const;
const EXPECTED_PLATFORM_RUNTIME_ENTRYPOINT = "packages/runtime/src/index.ts";
const LOCAL_SUPERCTL_DEFAULT_ROOT = "../../repos/superctl";

type DoctorSeverity = "error" | "warning" | "info";

interface DoctorFinding {
  severity: DoctorSeverity;
  message: string;
}

export async function doctorProject(root: URL = cwdRootUrl()): Promise<void> {
  const findings = await inspectProjectConfiguration(root);
  const errors = findings.filter((finding) => finding.severity === "error");

  for (const finding of findings) {
    console.log(`${formatStatusIcon(finding.severity)} ${finding.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Doctor found ${errors.length} configuration issue(s).`);
  }
}

function statusIcon(severity: DoctorSeverity): string {
  switch (severity) {
    case "error":
      return "✗";
    case "warning":
      return "!";
    case "info":
      return "✓";
  }
}

function formatStatusIcon(severity: DoctorSeverity): string {
  const icon = statusIcon(severity);
  if (!supportsColor()) {
    return icon;
  }

  const color = severity === "error"
    ? "\x1b[31m"
    : severity === "warning"
    ? "\x1b[33m"
    : "\x1b[32m";

  return `${color}${icon}\x1b[0m`;
}

function supportsColor(): boolean {
  if (Deno.env.get("NO_COLOR")) {
    return false;
  }

  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

async function inspectProjectConfiguration(root: URL): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const denoConfigFile = await findDenoProjectConfigFile(root);

  if (!denoConfigFile) {
    findings.push({
      severity: "error",
      message: `Missing ${denoConfigLabel()} at the project root.`,
    });
  } else {
    findings.push({
      severity: "info",
      message: `Using ${denoConfigFile} for Deno task configuration.`,
    });
    const config = await loadDenoProjectConfig(root);
    const tasks = await loadDenoProjectTasks(root);

    for (const task of [...REQUIRED_DENO_TASKS, ...REQUIRED_TEST_TASKS]) {
      if (!tasks[task]) {
        findings.push({
          severity: "error",
          message: `Missing required ${denoConfigLabel()} task "${task}".`,
        });
      }
    }

    await inspectStarterPlatformRoot(root, config, findings);
    await inspectStarterPlatformRootConsistency(root, config, findings);
  }

  await inspectQualityWorkflow(root, findings);
  await inspectTestLayout(root, findings);
  await inspectLocalSuperctlMode(root, findings);

  const manifest = await loadManifestSafely(root, findings);
  if (manifest) {
    inspectManifest(manifest, findings);
  }

  if (findings.every((finding) => finding.severity !== "error")) {
    findings.push({
      severity: "info",
      message: "Configuration looks healthy.",
    });
  }

  return findings;
}

async function inspectQualityWorkflow(root: URL, findings: DoctorFinding[]): Promise<void> {
  const workflowFile = await findFirstExistingFile(root, QUALITY_WORKFLOW_FILES);
  if (!workflowFile) {
    findings.push({
      severity: "error",
      message:
        'Missing GitHub Actions quality workflow at ".github/workflows/quality.yml" or ".github/workflows/quality.yaml".',
    });
    return;
  }

  findings.push({
    severity: "info",
    message: `Using ${workflowFile} for GitHub Actions quality checks.`,
  });

  const source = await Deno.readTextFile(new URL(workflowFile, root));
  if (!source.includes("pull_request")) {
    findings.push({
      severity: "error",
      message: `GitHub Actions quality workflow "${workflowFile}" must run on pull_request.`,
    });
  }

  const runsGateAndVerifyAndAudit = source.includes("main.ts gate") &&
    source.includes("main.ts verify") &&
    source.includes("main.ts audit");
  const runsLegacyCheck = source.includes("deno task check");
  if (!runsGateAndVerifyAndAudit && !runsLegacyCheck) {
    findings.push({
      severity: "error",
      message:
        `GitHub Actions quality workflow "${workflowFile}" must run "superctl gate", "superctl verify", and "superctl audit" or the legacy "deno task check".`,
    });
  }
}

async function inspectTestLayout(root: URL, findings: DoctorFinding[]): Promise<void> {
  for (const issue of await listTestLayoutIssues(root)) {
    findings.push({
      severity: "error",
      message: issue,
    });
  }
}

async function inspectStarterPlatformRoot(
  root: URL,
  config: DenoProjectConfig | null,
  findings: DoctorFinding[],
): Promise<void> {
  if (!(await isStarterStyleProject(root))) {
    return;
  }

  const platformRoot = config?.superstructure?.platformRoot?.trim();
  if (!platformRoot) {
    findings.push({
      severity: "error",
      message: `Starter projects must set ${denoConfigLabel()} superstructure.platformRoot.`,
    });
    return;
  }

  const resolvedPlatformRoot = resolveProjectPath(root, platformRoot);
  if (!(await pathExists(resolvedPlatformRoot))) {
    findings.push({
      severity: "error",
      message: `superstructure.platformRoot "${platformRoot}" does not exist.`,
    });
    return;
  }

  const runtimeEntrypoint = join(resolvedPlatformRoot, EXPECTED_PLATFORM_RUNTIME_ENTRYPOINT);
  if (!(await isFilePath(runtimeEntrypoint))) {
    findings.push({
      severity: "error",
      message:
        `superstructure.platformRoot "${platformRoot}" must contain "${EXPECTED_PLATFORM_RUNTIME_ENTRYPOINT}".`,
    });
  }
}

async function inspectStarterPlatformRootConsistency(
  root: URL,
  config: DenoProjectConfig | null,
  findings: DoctorFinding[],
): Promise<void> {
  const expectedPlatformRoot = config?.superstructure?.platformRoot?.trim();
  if (!expectedPlatformRoot) {
    return;
  }

  for (const relativePath of STARTER_PLATFORM_ROOT_FILES) {
    const source = await readTextFileIfExists(root, relativePath);
    if (!source) {
      continue;
    }

    const starterPlatformRoot = extractStarterPlatformRoot(source);
    if (!starterPlatformRoot) {
      continue;
    }

    if (starterPlatformRoot !== expectedPlatformRoot) {
      findings.push({
        severity: "error",
        message:
          `Starter file "${relativePath}" sets PLATFORM_ROOT to "${starterPlatformRoot}", but ${denoConfigLabel()} superstructure.platformRoot is "${expectedPlatformRoot}".`,
      });
    }
  }
}

async function inspectLocalSuperctlMode(root: URL, findings: DoctorFinding[]): Promise<void> {
  const superctlToolVersion = await loadMiseToolVersion(root, "superctl");
  if (superctlToolVersion !== "local") {
    return;
  }

  for (const relativePath of LOCAL_SUPERCTL_PLUGIN_FILES) {
    if (!(await isFileAtProjectPath(root, relativePath))) {
      findings.push({
        severity: "error",
        message: `Local superctl mode requires "${relativePath}".`,
      });
    }
  }

  const sourceRoot = resolveLocalSuperctlRoot(root);
  const sourceEntrypoint = join(sourceRoot, "main.ts");
  const sourceConfigPath = join(sourceRoot, "deno.json");

  if (!(await isFilePath(sourceEntrypoint)) || !(await isFilePath(sourceConfigPath))) {
    findings.push({
      severity: "error",
      message:
        `Local superctl mode requires a source repo at "${sourceRoot}" with "main.ts" and "deno.json".`,
    });
    return;
  }

  const sourceVersion = await loadSuperctlSourceVersion(sourceConfigPath);
  if (!sourceVersion) {
    findings.push({
      severity: "error",
      message: `Could not read the local superctl source version from "${sourceConfigPath}".`,
    });
    return;
  }

  if (sourceVersion !== SUPERCTL_VERSION) {
    findings.push({
      severity: "error",
      message:
        `Local superctl source version "${sourceVersion}" does not match the running superctl version "${SUPERCTL_VERSION}". Rerun "mise install -f superctl@local" and "mise reshim superctl".`,
    });
  }
}

async function loadManifestSafely(
  root: URL,
  findings: DoctorFinding[],
): Promise<ProjectManifest | null> {
  try {
    return await loadProjectManifest(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      severity: "error",
      message: `Unable to read superstructure.project.json: ${message}`,
    });
    return null;
  }
}

async function isStarterStyleProject(root: URL): Promise<boolean> {
  return (await findFirstExistingFile(root, STARTER_PLATFORM_ROOT_FILES)) !== null;
}

function resolveProjectPath(root: URL, candidate: string): string {
  const rootPath = resolve(fileURLToPath(root));
  return isAbsolute(candidate) ? resolve(candidate) : resolve(rootPath, candidate);
}

function extractStarterPlatformRoot(source: string): string | null {
  const match = source.match(
    /const PLATFORM_ROOT = (?:"([^"]+)"|'([^']+)');[\s\S]*?Deno\.env\.set\((["'])SUPERSTRUCTURE_PLATFORM_ROOT\3,\s*PLATFORM_ROOT\);/u,
  );

  return match?.[1] ?? match?.[2] ?? null;
}

async function loadMiseToolVersion(root: URL, toolName: string): Promise<string | null> {
  const source = await readTextFileIfExists(root, ".mise.toml");
  if (!source) {
    return null;
  }

  let inToolsSection = false;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inToolsSection = trimmed === "[tools]";
      continue;
    }

    if (!inToolsSection || trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']\s*$/u);
    if (assignment?.[1] === toolName) {
      return assignment[2] ?? null;
    }
  }

  return null;
}

function resolveLocalSuperctlRoot(root: URL): string {
  const envPath = Deno.env.get("SUPERCTL_ROOT")?.trim();
  if (envPath) {
    return resolveProjectPath(root, envPath);
  }

  return resolveProjectPath(root, LOCAL_SUPERCTL_DEFAULT_ROOT);
}

async function loadSuperctlSourceVersion(path: string): Promise<string | null> {
  try {
    const config = JSON.parse(await Deno.readTextFile(path)) as { version?: unknown };
    return typeof config.version === "string" && config.version.trim().length > 0
      ? config.version.trim()
      : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function readTextFileIfExists(root: URL, relativePath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(new URL(relativePath, root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function isFileAtProjectPath(root: URL, relativePath: string): Promise<boolean> {
  return await isFilePath(fileURLToPath(new URL(relativePath, root)));
}

async function isFilePath(path: string): Promise<boolean> {
  try {
    const entry = await Deno.stat(path);
    return entry.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
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

function inspectManifest(manifest: ProjectManifest, findings: DoctorFinding[]): void {
  if (manifest.schemaVersion !== 1) {
    findings.push({
      severity: "error",
      message: `Unsupported superstructure.project.json schemaVersion "${manifest.schemaVersion}".`,
    });
  }

  const serviceNames = new Set<string>();
  for (const service of manifest.services) {
    if (serviceNames.has(service.name)) {
      findings.push({
        severity: "error",
        message: `Duplicate service entry "${service.name}" in superstructure.project.json.`,
      });
    }
    serviceNames.add(service.name);
  }

  const surfaceNames = new Set<string>();
  const surfacePaths = new Set<string>();
  for (const surface of manifest.surfaces) {
    if (surfaceNames.has(surface.name)) {
      findings.push({
        severity: "error",
        message: `Duplicate surface entry "${surface.name}" in superstructure.project.json.`,
      });
    }
    surfaceNames.add(surface.name);

    if (surfacePaths.has(surface.path)) {
      findings.push({
        severity: "error",
        message: `Duplicate surface path "${surface.path}" in superstructure.project.json.`,
      });
    }
    surfacePaths.add(surface.path);

    if (!surface.path.startsWith("/")) {
      findings.push({
        severity: "error",
        message: `Surface "${surface.name}" must use an absolute path, got "${surface.path}".`,
      });
    }
  }

  if (manifest.surfaces.length === 0) {
    findings.push({
      severity: "warning",
      message: "No surfaces are declared in superstructure.project.json.",
    });
  }

  const rootSurfaceName = manifest.deployment.rootSurface?.trim();
  if (!rootSurfaceName) {
    findings.push({
      severity: "error",
      message: "Deployment rootSurface must be set in superstructure.project.json.",
    });
    return;
  }

  const rootSurface = manifest.surfaces.find((surface) => surface.name === rootSurfaceName);
  if (!rootSurface) {
    findings.push({
      severity: "error",
      message: `Deployment rootSurface "${rootSurfaceName}" is not declared in surfaces[].`,
    });
    return;
  }

  if (!rootSurface.enabled) {
    findings.push({
      severity: "error",
      message: `Deployment rootSurface "${rootSurfaceName}" is disabled.`,
    });
  }

  if (!rootSurface.rootEligible) {
    findings.push({
      severity: "error",
      message: `Deployment rootSurface "${rootSurfaceName}" is not marked rootEligible.`,
    });
  }
}

async function findFirstExistingFile(
  root: URL,
  relativePaths: readonly string[],
): Promise<string | null> {
  for (const relativePath of relativePaths) {
    try {
      const entry = await Deno.stat(new URL(relativePath, root));
      if (entry.isFile) {
        return relativePath;
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
