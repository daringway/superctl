import { cwdRootUrl } from "./paths.ts";

const QUALITY_WORKFLOW_FILES = [
  ".github/workflows/quality.yml",
  ".github/workflows/quality.yaml",
] as const;

interface GitHubRepositoryCoordinates {
  owner: string;
  repo: string;
}

interface GitHubRepoPolicyDependencies {
  fetchGraphql?: (query: string, token: string) => Promise<unknown>;
  readTextFile?: (url: URL) => Promise<string>;
  resolveGitHubToken?: (root: URL) => Promise<string | null>;
  resolveOriginUrl?: (root: URL) => Promise<string | null>;
}

interface GitHubRepoPolicySnapshot {
  allowAutoMerge: boolean;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
  deleteBranchOnMerge: boolean;
  defaultBranch: string;
  branchProtectionPatterns: readonly GitHubBranchProtectionRule[];
  expectedStatusChecks: readonly string[];
  codeownersSource: string;
}

interface GitHubBranchProtectionRule {
  pattern: string;
  requiresApprovingReviews: boolean;
  requiredApprovingReviewCount: number;
  requiresCodeOwnerReviews: boolean;
  dismissesStaleReviews: boolean;
  requiresStatusChecks: boolean;
  requiredStatusCheckContexts: readonly string[];
}

interface GitHubRepositoryGraphqlResponse {
  data?: {
    repository?: {
      autoMergeAllowed?: boolean;
      squashMergeAllowed?: boolean;
      mergeCommitAllowed?: boolean;
      rebaseMergeAllowed?: boolean;
      deleteBranchOnMerge?: boolean;
      defaultBranchRef?: { name?: string | null } | null;
      branchProtectionRules?: {
        nodes?:
          | Array<
            {
              pattern?: string | null;
              requiresApprovingReviews?: boolean | null;
              requiredApprovingReviewCount?: number | null;
              requiresCodeOwnerReviews?: boolean | null;
              dismissesStaleReviews?: boolean | null;
              requiresStatusChecks?: boolean | null;
              requiredStatusCheckContexts?: Array<string | null> | null;
            } | null
          >
          | null;
      } | null;
    } | null;
  };
}

export async function verifyGitHubRepoPolicy(
  root: URL = cwdRootUrl(),
  deps: GitHubRepoPolicyDependencies = {},
): Promise<void> {
  const resolveOriginUrl = deps.resolveOriginUrl ?? defaultResolveOriginUrl;
  const originUrl = await resolveOriginUrl(root);
  if (!originUrl) {
    return;
  }

  const coordinates = parseGitHubRepositoryCoordinates(originUrl);
  if (!coordinates) {
    return;
  }

  const readTextFile = deps.readTextFile ?? ((url: URL) => Deno.readTextFile(url));
  const codeownersSource = await readCodeowners(root, readTextFile);
  const workflowSource = await readQualityWorkflow(root, readTextFile);
  const expectedStatusChecks = extractCheckNamesFromQualityWorkflow(workflowSource);
  if (expectedStatusChecks.length === 0) {
    throw new Error(
      "GitHub repo policy check requires named jobs in the quality workflow so required status checks can be validated.",
    );
  }

  const resolveGitHubToken = deps.resolveGitHubToken ?? defaultResolveGitHubToken;
  const token = await resolveGitHubToken(root);
  if (!token) {
    throw new Error(
      "GitHub repo policy check requires GH_TOKEN, GITHUB_TOKEN, or an authenticated gh session.",
    );
  }

  const fetchGraphql = deps.fetchGraphql ?? defaultFetchGraphql;
  const response = await fetchGraphql(buildRepositoryPolicyQuery(coordinates), token);
  const snapshot = toGitHubRepoPolicySnapshot(response, expectedStatusChecks, codeownersSource);
  const issues = validateGitHubRepoPolicy(snapshot);

  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
}

export function parseGitHubRepositoryCoordinates(
  remoteUrl: string,
): GitHubRepositoryCoordinates | null {
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const sshUrlMatch = remoteUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
  }

  return null;
}

export function extractCheckNamesFromQualityWorkflow(source: string): string[] {
  const lines = source.split(/\r?\n/u);
  const names: string[] = [];
  let inJobs = false;
  let currentJobId: string | null = null;
  let currentJobName: string | null = null;

  const flushJob = () => {
    if (!currentJobId) {
      return;
    }
    names.push(currentJobName ?? currentJobId);
    currentJobId = null;
    currentJobName = null;
  };

  for (const line of lines) {
    if (!inJobs) {
      if (line.trim() === "jobs:") {
        inJobs = true;
      }
      continue;
    }

    if (/^\S/u.test(line)) {
      flushJob();
      break;
    }

    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/u);
    if (jobMatch) {
      flushJob();
      currentJobId = jobMatch[1];
      continue;
    }

    if (!currentJobId) {
      continue;
    }

    const nameMatch = line.match(/^ {4}name:\s*(.+?)\s*$/u);
    if (nameMatch) {
      currentJobName = normalizeYamlScalar(nameMatch[1]);
    }
  }

  flushJob();
  return names;
}

export function validateGitHubRepoPolicy(snapshot: GitHubRepoPolicySnapshot): string[] {
  const issues: string[] = [];
  const protectedBranch = "main";

  if (!hasAutopilotCodeownersBaseline(snapshot.codeownersSource)) {
    issues.push('CODEOWNERS must include a catch-all "*" rule for "@daringway/autopilot".');
  }

  if (snapshot.allowAutoMerge) {
    issues.push("GitHub repository setting allow_auto_merge must be disabled.");
  }
  if (!snapshot.allowSquashMerge) {
    issues.push("GitHub repository setting allow_squash_merge must be enabled.");
  }
  if (snapshot.allowMergeCommit) {
    issues.push("GitHub repository setting allow_merge_commit must be disabled.");
  }
  if (snapshot.allowRebaseMerge) {
    issues.push("GitHub repository setting allow_rebase_merge must be disabled.");
  }
  if (!snapshot.deleteBranchOnMerge) {
    issues.push("GitHub repository setting delete_branch_on_merge must be enabled.");
  }

  if (snapshot.defaultBranch !== protectedBranch) {
    issues.push(`GitHub repository default branch must be "${protectedBranch}".`);
  }

  const branchRule = snapshot.branchProtectionPatterns.find((rule) =>
    rule.pattern === protectedBranch
  );

  if (!branchRule) {
    issues.push(
      `Branch "${protectedBranch}" must have an exact branch protection rule.`,
    );
    return issues;
  }

  if (!branchRule.requiresStatusChecks) {
    issues.push(`Branch protection for "${protectedBranch}" must require status checks.`);
  }
  if (branchRule.requiresApprovingReviews) {
    issues.push(`Branch protection for "${protectedBranch}" must not require approvals.`);
  }
  if (branchRule.requiredApprovingReviewCount !== 0) {
    issues.push(
      `Branch protection for "${protectedBranch}" must require exactly 0 approving reviews.`,
    );
  }
  if (branchRule.dismissesStaleReviews) {
    issues.push(`Branch protection for "${protectedBranch}" must not dismiss stale reviews.`);
  }
  if (branchRule.requiresCodeOwnerReviews) {
    issues.push(`Branch protection for "${protectedBranch}" must not require CODEOWNERS reviews.`);
  }

  const actualChecks = [...branchRule.requiredStatusCheckContexts].sort();
  const expectedChecks = [...snapshot.expectedStatusChecks].sort();
  if (
    actualChecks.length !== expectedChecks.length ||
    actualChecks.some((value, index) => value !== expectedChecks[index])
  ) {
    issues.push(
      `Branch protection for "${protectedBranch}" must require exactly these status checks: ${
        expectedChecks.join(", ")
      }. Found: ${actualChecks.join(", ") || "(none)"}.`,
    );
  }

  return issues;
}

function hasAutopilotCodeownersBaseline(source: string): boolean {
  return /^\*\s+.*@daringway\/autopilot\b/mu.test(source);
}

async function readCodeowners(
  root: URL,
  readTextFile: (url: URL) => Promise<string>,
): Promise<string> {
  try {
    return await readTextFile(new URL(".github/CODEOWNERS", root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error('GitHub repo policy check requires ".github/CODEOWNERS".');
    }
    throw error;
  }
}

async function readQualityWorkflow(
  root: URL,
  readTextFile: (url: URL) => Promise<string>,
): Promise<string> {
  for (const relativePath of QUALITY_WORKFLOW_FILES) {
    try {
      return await readTextFile(new URL(relativePath, root));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    'GitHub repo policy check requires ".github/workflows/quality.yml" or ".github/workflows/quality.yaml".',
  );
}

function buildRepositoryPolicyQuery(coordinates: GitHubRepositoryCoordinates): string {
  return [
    "query RepoPolicy {",
    `  repository(owner: ${JSON.stringify(coordinates.owner)}, name: ${
      JSON.stringify(coordinates.repo)
    }) {`,
    "    autoMergeAllowed",
    "    squashMergeAllowed",
    "    mergeCommitAllowed",
    "    rebaseMergeAllowed",
    "    deleteBranchOnMerge",
    "    defaultBranchRef {",
    "      name",
    "    }",
    "    branchProtectionRules(first: 20) {",
    "      nodes {",
    "        pattern",
    "        requiresApprovingReviews",
    "        requiredApprovingReviewCount",
    "        requiresCodeOwnerReviews",
    "        dismissesStaleReviews",
    "        requiresStatusChecks",
    "        requiredStatusCheckContexts",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

function toGitHubRepoPolicySnapshot(
  response: unknown,
  expectedStatusChecks: readonly string[],
  codeownersSource: string,
): GitHubRepoPolicySnapshot {
  const repository = (response as GitHubRepositoryGraphqlResponse).data?.repository;
  if (!repository?.defaultBranchRef?.name) {
    throw new Error("GitHub repo policy check could not resolve the repository default branch.");
  }

  return {
    allowAutoMerge: repository.autoMergeAllowed === true,
    allowSquashMerge: repository.squashMergeAllowed === true,
    allowMergeCommit: repository.mergeCommitAllowed === true,
    allowRebaseMerge: repository.rebaseMergeAllowed === true,
    deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
    defaultBranch: repository.defaultBranchRef.name,
    branchProtectionPatterns: (repository.branchProtectionRules?.nodes ?? []).flatMap((node) =>
      node?.pattern
        ? [{
          pattern: node.pattern,
          requiresApprovingReviews: node.requiresApprovingReviews === true,
          requiredApprovingReviewCount: node.requiredApprovingReviewCount ?? 0,
          requiresCodeOwnerReviews: node.requiresCodeOwnerReviews === true,
          dismissesStaleReviews: node.dismissesStaleReviews === true,
          requiresStatusChecks: node.requiresStatusChecks === true,
          requiredStatusCheckContexts: (node.requiredStatusCheckContexts ?? []).filter(
            (value): value is string => Boolean(value),
          ),
        }]
        : []
    ),
    expectedStatusChecks,
    codeownersSource,
  };
}

async function defaultResolveOriginUrl(root: URL): Promise<string | null> {
  try {
    const output = await runCommand(
      "git",
      ["remote", "get-url", "origin"],
      root,
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function defaultResolveGitHubToken(root: URL): Promise<string | null> {
  for (const key of ["SUPERCTL_GITHUB_POLICY_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = Deno.env.get(key)?.trim();
    if (value) {
      return value;
    }
  }

  try {
    const output = await runCommand("gh", ["auth", "token"], root);
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function defaultFetchGraphql(query: string, token: string): Promise<unknown> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/vnd.github+json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub repo policy check failed to query GraphQL: ${response.status} ${body}`.trim(),
    );
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `GitHub repo policy check failed to query GraphQL: ${
        payload.errors.map((entry: { message?: string }) => entry.message ?? "unknown error").join(
          "; ",
        )
      }`,
    );
  }

  return payload;
}

async function runCommand(command: string, args: string[], root: URL): Promise<string> {
  const output = await new Deno.Command(command, {
    args,
    cwd: decodeURIComponent(root.pathname),
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    const stdout = new TextDecoder().decode(output.stdout).trim();
    throw new Error(stderr || stdout || `${command} ${args.join(" ")} failed.`);
  }

  return new TextDecoder().decode(output.stdout);
}

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
