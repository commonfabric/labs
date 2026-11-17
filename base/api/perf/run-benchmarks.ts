#!/usr/bin/env -S deno run -A

import { tscCommand } from "./run-tsc.ts";

export const CONFIGS = [
  "tsconfig.baseline.json",
  "tsconfig.key.json",
  "tsconfig.anycell.json",
  "tsconfig.schema.json",
  "tsconfig.ikeyable-cell.json",
  "tsconfig.ikeyable-schema.json",
  "tsconfig.ikeyable-realistic.json",
] as const;

const HARNESS_DIR = new URL(".", import.meta.url);
const SEPARATOR = "----------------------------------------";

const decoder = new TextDecoder();

/**
 * The lines of `tsc --extendedDiagnostics` output that are compared across
 * scenarios: the instantiation count and the check time.
 */
export function summarizeDiagnostics(output: string): string[] {
  return output.split("\n")
    .filter((line) =>
      line.startsWith("Instantiations:") || line.startsWith("Check time:")
    )
    .map((line) => line.trim());
}

/**
 * Compiles one scenario project, named relative to this directory, and returns
 * the report to print for it: the compiler's diagnostics followed by their
 * summary. Throws when the compile fails.
 */
export async function runScenario(config: string): Promise<string> {
  const { code, stdout, stderr } = await tscCommand(
    ["--project", config, "--extendedDiagnostics", "--pretty", "false"],
    { cwd: HARNESS_DIR },
  ).output();
  const output = decoder.decode(stdout);
  if (code !== 0) {
    throw new Error(
      `Benchmark failed for ${config}\n${output}${decoder.decode(stderr)}`,
    );
  }
  const summary = summarizeDiagnostics(output);
  const summaryLine = summary.length > 0 ? `${summary.join(" | ")}\n` : "";
  return `# ${config}\n${output}\n${summaryLine}${SEPARATOR}\n`;
}

if (import.meta.main) {
  for (const config of CONFIGS) console.log(await runScenario(config));
}
