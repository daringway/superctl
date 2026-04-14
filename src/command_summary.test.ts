import { assertEquals } from "@std/assert";

import {
  type BinaryWriter,
  extractCommandMetrics,
  runCommandWithLiveOutput,
} from "./command_summary.ts";

const decoder = new TextDecoder();

class MemoryWriter implements BinaryWriter {
  #chunks: Uint8Array[] = [];

  async write(data: Uint8Array): Promise<number> {
    this.#chunks.push(new Uint8Array(data));
    return data.length;
  }

  text(): string {
    return decoder.decode(joinChunks(this.#chunks));
  }
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

Deno.test("runCommandWithLiveOutput mirrors and captures child output", async () => {
  const stdoutWriter = new MemoryWriter();
  const stderrWriter = new MemoryWriter();
  const program = [
    "const encoder = new TextEncoder();",
    'await Deno.stdout.write(encoder.encode("stdout line 1\\n"));',
    "await new Promise((resolve) => setTimeout(resolve, 20));",
    'await Deno.stderr.write(encoder.encode("stderr line 1\\n"));',
    "await new Promise((resolve) => setTimeout(resolve, 20));",
    'await Deno.stdout.write(encoder.encode("ok | 2 passed | 0 failed\\n"));',
  ].join(" ");

  const output = await runCommandWithLiveOutput(
    Deno.execPath(),
    ["eval", program],
    Deno.cwd(),
    { stdout: stdoutWriter, stderr: stderrWriter },
  );

  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);

  assertEquals(output.code, 0);
  assertEquals(stdout, "stdout line 1\nok | 2 passed | 0 failed\n");
  assertEquals(stderr, "stderr line 1\n");
  assertEquals(stdoutWriter.text(), stdout);
  assertEquals(stderrWriter.text(), stderr);
  assertEquals(extractCommandMetrics(`${stdout}\n${stderr}`), {
    passed: 2,
    total: 2,
  });
});
