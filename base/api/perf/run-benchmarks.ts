#!/usr/bin/env -S deno run -A

import { tscCommand } from "./run-tsc.ts";

const CONFIGS = [
  "tsconfig.baseline.json",
  "tsconfig.key.json",
  "tsconfig.anycell.json",
  "tsconfig.schema.json",
  "tsconfig.ikeyable-cell.json",
  "tsconfig.ikeyable-schema.json",
  "tsconfig.ikeyable-realistic.json",
] as const;

const cwd = fromFileUrl(new URL(".", import.meta.url));

function fromFileUrl(url: URL): string {
  if (url.protocol !== "file:") throw new TypeError("URL must be a file URL");
  const path = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows") {
    return path.slice(1).replaceAll("/", "\\");
  }
  return path;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function runScenario(config: string) {
  console.log(`# ${config}`);

  const command = tscCommand(
    ["--project", config, "--extendedDiagnostics", "--pretty", "false"],
    {
      cwd,
    },
  );

  const { code, stdout, stderr } = await command.output();
  const output = decoder.decode(stdout);
  if (code !== 0) {
    console.error(output);
    console.error(decoder.decode(stderr));
    throw new Error(`Benchmark failed for ${config}`);
  }

  console.log(output);

  const summary: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("Instantiations:")) {
      summary.push(line.trim());
    } else if (line.startsWith("Check time:")) {
      summary.push(line.trim());
    }
  }

  if (summary.length > 0) {
    await Deno.stdout.write(
      encoder.encode(
        `${summary.join(" | ")}\n----------------------------------------\n\n`,
      ),
    );
  } else {
    console.log("----------------------------------------\n");
  }
}

for (const config of CONFIGS) {
  await runScenario(config);
}
