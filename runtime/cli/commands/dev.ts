import { isAbsolute, join } from "@std/path";

import { Command } from "@cliffy/command";

import { cliText } from "../lib/cli-name.ts";
import { process } from "../lib/dev.ts";
import { render } from "../lib/render.ts";

const description = cliText(`Compile and execute patterns for debugging.

The pattern is processed through ts-transformers, which converts reactive
constructs (computed, handler, JSX) into runtime-compatible code.

By default, produces no output on success (like deno check). Use --json to
compile without evaluating and print the compiled module bodies in a structured
result, or --pattern-json to print the evaluated pattern export.

COMMON USAGE:
  cf check ./pattern.tsx                   # Compile, transform, and execute (quiet)
  cf check ./a.tsx ./b.tsx                 # Process multiple patterns
  cf check ./pattern.tsx --json            # Print compiled output as JSON
  cf check ./pattern.tsx --pattern-json    # Print the evaluated pattern export
  cf check ./pattern.tsx --no-run          # Type-check only (fast validation)
  cf check ./pattern.tsx --show-transformed   # See transformed output

TIPS:
  • Use --no-run for quick type-checking during development
  • Use --show-transformed to debug transformation issues - shows how
    ts-transformers converts your code (e.g., .map() → .mapWithPattern())
  • Transformation errors often stem from reactive constructs the compiler
    doesn't recognize; inspecting transformed output helps identify these`);

async function checkAction(
  options: {
    check: boolean;
    run: boolean;
    output?: string;
    showTransformed?: boolean;
    mainExport?: string;
    verboseErrors?: boolean;
    patternJson?: boolean;
    json?: boolean;
    root?: string;
    space?: string;
    datafile?: string[];
  },
  ...files: string[]
) {
  let hasError = false;
  const results: Array<{
    file: string;
    output: string;
    transformed?: string;
    patternJson?: string;
  }> = [];

  const rootPath = options.root
    ? (isAbsolute(options.root) ? options.root : join(Deno.cwd(), options.root))
    : Deno.cwd();

  for (const file of files) {
    const mainPath = isAbsolute(file) ? file : join(Deno.cwd(), file);

    try {
      const { output, transformed, patternJson } = await process({
        main: mainPath,
        rootPath,
        check: options.check,
        run: options.json || options.showTransformed ? false : options.run,
        output: files.length === 1 ? options.output : undefined,
        showTransformed: options.showTransformed,
        mainExport: options.mainExport,
        verboseErrors: options.verboseErrors,
        space: options.space,
        dataFilePaths: options.datafile?.map((path) =>
          isAbsolute(path) ? path : join(Deno.cwd(), path)
        ),
        patternJson: options.patternJson,
      });
      results.push({ file, output, transformed, patternJson });
    } catch (error) {
      hasError = true;
      // The runtime reports that a data file is not attached; it does not know
      // how this caller would attach one. `cf check` does, so it names its own
      // flag here rather than leaving the reader to find it.
      if (
        error instanceof Error &&
        error.message.includes("No attached data file") &&
        options.datafile === undefined
      ) {
        console.error(
          "Attach it with --datafile <path>, repeating the flag per file.",
        );
      }
      // Re-throw for single file, continue for multiple files
      if (files.length === 1) {
        throw error;
      }
      console.error(error);
    }
  }

  if (hasError) {
    Deno.exit(1);
  }

  if (options.showTransformed) {
    for (const result of results) {
      if (result.transformed !== undefined) {
        render(result.transformed);
      }
    }
    return;
  }

  if (options.patternJson) {
    for (const result of results) {
      if (result.patternJson !== undefined) {
        render(result.patternJson);
      }
    }
    return;
  }

  if (options.json) {
    render(
      {
        files: results.map(({ file, output }) => ({ path: file, output })),
      },
      { json: true },
    );
  }
}

// deno-lint-ignore no-explicit-any
function createCheckCommand(): Command<any> {
  return new Command()
    .name("check")
    .description(description)
    .example(
      cliText(`cf check ./pattern.tsx`),
      "Compile and evaluate a pattern (quiet on success).",
    )
    .example(
      cliText(`cf check ./a.tsx ./b.tsx ./c.tsx`),
      "Compile and evaluate multiple patterns.",
    )
    .example(
      cliText(`cf check ./pattern.tsx --json`),
      "Compile a pattern, printing its compiled module bodies as JSON.",
    )
    .example(
      cliText(`cf check ./pattern.tsx --pattern-json`),
      "Compile and evaluate a pattern, printing export default as JSON.",
    )
    .example(
      cliText(`cf check ./pattern.tsx --no-run --output out.js`),
      "Compile a pattern, storing the compiled per-module JavaScript to out.js without evaluating.",
    )
    .example(
      cliText(`cf check ./pattern.tsx --no-check`),
      "Compile and evaluate pattern without typechecking.",
    )
    .example(
      cliText(`cf check ./pattern.tsx --datafile ./data/cities.json`),
      "Check a pattern, attaching a data file its source cannot name.",
    )
    .option("--no-run", "Do not execute input, only type check.")
    .option("--no-check", "Do not type check input.")
    .option(
      "--output <value:string>",
      "Store the compiled pattern at $output.",
    )
    .option(
      "--show-transformed",
      "Show only the transformed TypeScript source code without executing the pattern.",
      { conflicts: ["json", "pattern-json"] },
    )
    .option(
      "--main-export <export:string>",
      'Named export from entry for pattern definition. Defaults to "default".',
    )
    .option(
      "--verbose-errors",
      "Show original TypeScript error messages in addition to simplified hints.",
    )
    .option(
      "--pattern-json",
      "Print the evaluated pattern export as JSON.",
      { conflicts: ["json", "show-transformed"] },
    )
    .option(
      "--json",
      "Compile without evaluating and print the compiled module bodies in a JSON result.",
      { conflicts: ["show-transformed", "pattern-json"] },
    )
    .option(
      "--root <path:string>",
      "Root directory for resolving imports. Allows imports from parent directories within this root.",
    )
    .option(
      "--datafile <path:string>",
      "Attach a data file the pattern's source cannot name. Repeatable.",
      { collect: true },
    )
    .option(
      "--space <did:string>",
      "Space DID for resolving fabric imports.",
    )
    .arguments("<files...:string>")
    .action(checkAction);
}

export const check = createCheckCommand();
