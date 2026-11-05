#!/usr/bin/env -S deno run --allow-read --allow-write
import * as path from "@std/path";
import { stripWithheldGlobals } from "./strip-withheld-globals.ts";

/**
 * We compile TypeScript in Deno/browser environments.
 * Typescript relies heavily on Node/FS during compilation,
 * looking for its type libraries on disk e.g. `es2023.d.ts`, `dom.d.ts`.
 *
 * This script "compiles" a `.d.ts` file, resolving its imports,
 * and creates a single `.d.ts` output file for use in browser and Deno environments.
 *
 * The output describes the sandbox the patterns run in, not stock TypeScript,
 * so the declaration of each global in `SANDBOX_WITHHELD_GLOBALS` is dropped on
 * the way out.
 */

function help() {
  const message = `
compile-type-lib /path/to/typescript/src/lib/ lib.d.ts
`;
  Deno.stdout.writeSync(new TextEncoder().encode(message));
}

interface CompileOptions {
  // Path to a typescript repo's library of .d.ts files.
  libDir: string;
  // Target type lib e.g. "es2023"
  target: string;
  // File to output the compiled .d.ts file
  outFile: string;
}

function parseArgs(libDir?: string, outFile?: string): CompileOptions {
  if (
    typeof libDir !== "string" || libDir === "" ||
    typeof outFile !== "string" || outFile === ""
  ) {
    help();
    Deno.exit(1);
  }
  return {
    target: "es2023", // Target used in js-compiler
    libDir,
    outFile,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EXTRACTOR = /\/\/\/ \<reference lib="([a-z0-9\.\-]+)"/;

async function compile(
  libDir: string,
  name: string,
  included: string[],
): Promise<string> {
  const filePath = path.join(libDir, `${name}.d.ts`);
  const src = decoder.decode(await Deno.readFile(filePath));
  let out = "";
  for (const line of src.split("\r\n")) {
    const result = line.match(EXTRACTOR);
    if (result && result[1]) {
      const dependent = result[1];
      if (included.includes(dependent)) {
        continue;
      }
      out += await compile(libDir, dependent, included);
      included.push(dependent);
    } else {
      out += `${line}\r\n`;
    }
  }
  return out;
}

export async function compileMain(options: CompileOptions) {
  const { target, libDir, outFile } = options;

  const out = await compile(libDir, target, []);
  const { text } = stripWithheldGlobals(out);
  await Deno.writeFile(outFile, encoder.encode(text));
}

export type { CompileOptions };

if (import.meta.main) {
  compileMain(parseArgs(Deno.args[0], Deno.args[1]));
}
