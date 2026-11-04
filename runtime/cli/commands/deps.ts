import { dirname, join } from "@std/path";

import { Command } from "@cliffy/command";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";

import { cliText } from "../lib/cli-name.ts";
import { collectLocalProgram } from "../lib/dev.ts";
import {
  pinProgramFabricImports,
  renderPinRewrite,
} from "../lib/fabric-deps.ts";
import { loadPieces } from "../lib/piece.ts";
import { render } from "../lib/render.ts";
import { absPath } from "../lib/utils.ts";
import { parseSpaceOptions } from "./piece.ts";

// Typed as Command<any> because cliffy's accumulated option generics don't
// survive registration in main.ts (the same idiom as the check command).
// deno-lint-ignore no-explicit-any
export const deps: Command<any> = new Command()
  .name("deps")
  .description("Manage fabric import dependencies.")
  .default("help")
  .globalOption(
    "-u,--url <url:string>",
    "URL representing a host, space, and piece.",
  )
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
    prefix: "CF_",
  })
  .globalOption(
    "-a,--api-url <url:string>",
    "URL of the fabric server instance.",
  )
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalEnv("CF_SPACE=<space:string>", "The space name or DID.", {
    prefix: "CF_",
  })
  .globalOption("-s,--space <space:string>", "The space name or DID")
  .command("update", "Pin mutable fabric imports in a local source file.")
  .arguments("<file:string>")
  .option(
    "--import <specifier:string>",
    "Only update one matching import specifier.",
  )
  .option(
    "--check",
    "Exit non-zero if any pin would change without writing the file.",
  )
  .action(async (options, file) => {
    const config = parseSpaceOptions(options);
    const pieces = await loadPieces(config);
    const filePath = absPath(file);
    // Walk the whole local program (the same walk cf check uses), so pins
    // in sibling files the entry imports are updated too, not just the entry.
    const fsRoot = dirname(filePath);
    const resolver = new FileSystemProgramResolver(filePath);
    const program = await collectLocalProgram(resolver, {
      fabricImports: "allow",
    });
    const originals = new Map(
      program.files.map(({ name, contents }) => [name, contents]),
    );
    const result = await pinProgramFabricImports(
      pieces.runtime,
      pieces.getSpace(),
      program,
      { importSpecifier: options.import },
    );

    for (const rewrite of result.rewrites) {
      render(
        `${join(fsRoot, rewrite.file.slice(1))}:${rewrite.line} ${
          renderPinRewrite(rewrite)
        }`,
      );
    }

    if (options.check && result.rewrites.length > 0) {
      throw new Error(
        cliText("fabric dependencies are not pinned; run cf deps update"),
      );
    }

    if (!options.check) {
      for (const { name, contents } of result.program.files) {
        if (originals.get(name) !== contents) {
          await Deno.writeTextFile(join(fsRoot, name.slice(1)), contents);
        }
      }
    }
  });
