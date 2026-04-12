import { assertEquals, assertStringIncludes } from "@std/assert";

import { SUPERCTL_VERSION } from "../../src/version.ts";

const CLI_ENTRYPOINT = new URL("../../main.ts", import.meta.url);

interface CliResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI_ENTRYPOINT.pathname, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("cli smoke help prints usage", async () => {
  const result = await runCli(["help"]);

  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "Usage:");
  assertStringIncludes(result.stdout, "superctl verify");
  assertEquals(result.stderr, "");
});

Deno.test("cli smoke version prints the current release", async () => {
  const result = await runCli(["version"]);

  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), SUPERCTL_VERSION);
  assertEquals(result.stderr, "");
});
