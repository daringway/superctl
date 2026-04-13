import { auditProject } from "./src/audit.ts";
import { doctorProject } from "./src/doctor.ts";
import { gateProject } from "./src/gate.ts";
import { cwdRootUrl } from "./src/paths.ts";
import { buildProject, devProject, startProject } from "./src/run.ts";
import { addService, addSurface, initProject } from "./src/scaffold.ts";
import { testProject } from "./src/verify.ts";
import { SUPERCTL_VERSION } from "./src/version.ts";

function usage(): string {
  return [
    "Usage:",
    "  superctl help",
    "  superctl version",
    "  superctl init",
    "  superctl add service <name>",
    "  superctl add surface <name>",
    "  superctl build",
    "  superctl start",
    "  superctl dev",
    "  superctl audit",
    "  superctl gate",
    "  superctl test",
    "  superctl doctor",
  ].join("\n");
}

export async function main(args: string[]): Promise<void> {
  const normalizedArgs = args.filter((value) => value !== "--");
  const [command, ...rest] = normalizedArgs;
  const root = cwdRootUrl();

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      console.log(usage());
      return;
    case "version":
    case "--version":
    case "-V":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      console.log(SUPERCTL_VERSION);
      return;
    case "init":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      await initProject(root);
      return;
    case "add":
      if (rest[0] === "service" && rest.length === 2) {
        await addService(rest[1], root);
        return;
      }
      if (rest[0] === "surface" && rest.length === 2) {
        await addSurface(rest[1], root);
        return;
      }
      throw new Error(`Expected "add service <name>" or "add surface <name>".\n\n${usage()}`);
    case "build":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "build".\n\n${usage()}`);
      }
      await buildProject(root);
      return;
    case "start":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "start".\n\n${usage()}`);
      }
      await startProject(root);
      return;
    case "dev":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "dev".\n\n${usage()}`);
      }
      await devProject(root);
      return;
    case "audit":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      await auditProject(root);
      return;
    case "gate":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      await gateProject(root);
      return;
    case "test":
    case "verify":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      await testProject(root);
      return;
    case "doctor":
      if (rest.length > 0) {
        throw new Error(`Unexpected arguments for "${command}".\n\n${usage()}`);
      }
      await doctorProject(root);
      return;
    default:
      throw new Error(usage());
  }
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
