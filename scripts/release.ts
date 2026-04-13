import { bumpReleaseVersion, type ReleaseBumpKind } from "../src/release.ts";
import { cwdRootUrl } from "../src/paths.ts";

function usage(): string {
  return [
    "Usage:",
    "  deno run -A scripts/release.ts bump <major|minor|patch> [--rc] [--tag]",
    "",
    "Examples:",
    "  deno run -A scripts/release.ts bump patch",
    "  deno run -A scripts/release.ts bump minor --rc",
    "  deno run -A scripts/release.ts bump patch --tag",
  ].join("\n");
}

async function main(args: string[]): Promise<void> {
  const normalizedArgs = args.filter((value) => value !== "--");
  const [command, kindArg, ...rest] = normalizedArgs;
  if (command !== "bump") {
    throw new Error(usage());
  }

  if (!isReleaseBumpKind(kindArg)) {
    throw new Error(`Expected a release bump kind after "bump".\n\n${usage()}`);
  }

  const prerelease = rest.includes("--rc");
  const createTag = rest.includes("--tag");
  const unexpected = rest.filter((value) => value !== "--rc" && value !== "--tag");
  if (unexpected.length > 0) {
    throw new Error(`Unexpected arguments: ${unexpected.join(", ")}.\n\n${usage()}`);
  }

  const result = await bumpReleaseVersion(cwdRootUrl(), kindArg, { prerelease, createTag });
  console.log(`Updated deno.json version: ${result.previousVersion} -> ${result.nextVersion}`);
  console.log(`Release tag: ${result.tag}`);
  if (createTag) {
    console.log(`Created git tag "${result.tag}".`);
  } else {
    console.log(`Create the git tag with: git tag ${result.tag}`);
  }
}

function isReleaseBumpKind(value: string | undefined): value is ReleaseBumpKind {
  return value === "major" || value === "minor" || value === "patch";
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    Deno.exit(1);
  }
}
