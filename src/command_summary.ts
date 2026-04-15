export interface CommandMetrics {
  passed: number;
  total: number;
}

export interface CommandRunResult {
  code: number;
  metrics: CommandMetrics | null;
}

export interface CapturedCommandOutput {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface CommandOutputWriters {
  stdout?: BinaryWriter;
  stderr?: BinaryWriter;
}

export type SummaryStepStatus = "passed" | "failed" | "not-run";

export interface SummaryStep {
  label: string;
  status: SummaryStepStatus;
  metrics: CommandMetrics | null;
  detail: string | null;
}

export class CommandStepError extends Error {
  constructor(message: string, readonly result: CommandRunResult) {
    super(message);
    this.name = "CommandStepError";
  }
}

export function createSummaryStep(label: string): SummaryStep {
  return {
    label,
    status: "not-run",
    metrics: null,
    detail: null,
  };
}

export function markStepPassed(step: SummaryStep, metrics: CommandMetrics | null = null): void {
  step.status = "passed";
  step.metrics = metrics;
  step.detail = null;
}

export function markStepFailed(
  step: SummaryStep,
  detail: string,
  metrics: CommandMetrics | null = null,
): void {
  step.status = "failed";
  step.metrics = metrics;
  step.detail = detail;
}

export function printCommandSummary(name: string, steps: readonly SummaryStep[]): void {
  const passed = steps.filter((step) => step.status === "passed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const notRun = steps.filter((step) => step.status === "not-run").length;
  const overall = failed === 0 ? "PASSED" : "FAILED";

  console.log("");
  console.log(`${name} summary`);

  for (const step of steps) {
    const icon = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "-";
    const message = step.status === "not-run"
      ? "not run"
      : formatStepMetrics(step.metrics, step.status);
    console.log(`${icon} ${step.label}: ${message}`);
    if (step.status === "failed" && step.detail) {
      console.log(`  ${step.detail}`);
    }
  }

  const overallDetails = [`${passed} passed`, `${failed} failed`];
  if (notRun > 0) {
    overallDetails.push(`${notRun} not run`);
  }
  console.log(`Overall: ${overall} (${overallDetails.join(", ")})`);
}

export function extractCommandMetrics(output: string): CommandMetrics | null {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();

  for (const line of lines) {
    const denoSummary = line.match(
      /\b(?:ok|failed)\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed\b/i,
    );
    if (denoSummary) {
      return toMetrics(Number(denoSummary[1]), Number(denoSummary[2]));
    }

    const denoSummaryReversed = line.match(
      /\b(?:ok|failed)\s*\|\s*(\d+)\s+failed\s*\|\s*(\d+)\s+passed\b/i,
    );
    if (denoSummaryReversed) {
      return toMetrics(Number(denoSummaryReversed[2]), Number(denoSummaryReversed[1]));
    }

    const labelSummary = line.match(
      /^\s*(?:tests?|test files?)\b.*?(\d+)\s+passed(?:.*?(\d+)\s+failed)?/i,
    );
    if (labelSummary) {
      return toMetrics(Number(labelSummary[1]), Number(labelSummary[2] ?? "0"));
    }

    const genericSummary = line.match(/\b(\d+)\s+passed\b.*?\b(\d+)\s+failed\b/i);
    if (genericSummary) {
      return toMetrics(Number(genericSummary[1]), Number(genericSummary[2]));
    }

    const genericSummaryReversed = line.match(/\b(\d+)\s+failed\b.*?\b(\d+)\s+passed\b/i);
    if (genericSummaryReversed) {
      return toMetrics(Number(genericSummaryReversed[2]), Number(genericSummaryReversed[1]));
    }

    const keyValueSummary = line.match(/\bpassed[:\s]+(\d+)\b.*?\bfailed[:\s]+(\d+)\b/i);
    if (keyValueSummary) {
      return toMetrics(Number(keyValueSummary[1]), Number(keyValueSummary[2]));
    }
  }

  return null;
}

export async function runCommandWithLiveOutput(
  command: string,
  args: string[],
  cwd: string,
  writers: CommandOutputWriters = {},
): Promise<CapturedCommandOutput> {
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "inherit",
  }).spawn();

  const [stdout, stderr, status] = await Promise.all([
    readAndMirror(child.stdout, writers.stdout ?? Deno.stdout),
    readAndMirror(child.stderr, writers.stderr ?? Deno.stderr),
    child.status,
  ]);

  return {
    code: status.code,
    stdout,
    stderr,
  };
}

function formatStepMetrics(
  metrics: CommandMetrics | null,
  status: Exclude<SummaryStepStatus, "not-run">,
): string {
  if (!metrics) {
    return status === "passed" ? "1 of 1 passed" : "0 of 1 passed";
  }

  return `${metrics.passed} of ${metrics.total} passed`;
}

function toMetrics(passed: number, failed: number): CommandMetrics {
  return {
    passed,
    total: passed + failed,
  };
}

export interface BinaryWriter {
  write(data: Uint8Array): Promise<number>;
}

async function readAndMirror(
  stream: ReadableStream<Uint8Array> | null,
  writer: BinaryWriter,
): Promise<Uint8Array> {
  if (!stream) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      chunks.push(value);
      totalLength += value.length;
      await writer.write(value);
    }
  } finally {
    reader.releaseLock();
  }

  return concatChunks(chunks, totalLength);
}

function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}
