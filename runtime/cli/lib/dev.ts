import {
  assertImportInsideProgramRoot,
  collectImportSpecifiers,
  type Program,
  type ProgramResolver,
  resolveImportSpecifier,
  type Source,
} from "@commonfabric/js-compiler";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { TARGET } from "@commonfabric/js-compiler/typescript";
import { Identity } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  type MemorySpace,
  parseFabricRef,
  Runtime,
  runtimePresets,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { stderrConsoleHandler } from "./json-output.ts";

const FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE =
  "fabric imports require a space context (options.fabricImports)";

export async function createRuntime(
  options: { consoleToStderr?: boolean } = {},
) {
  // The Deno storage cache opens SQLite as it loads, and a caller that never
  // builds a runtime should not pay for that.
  // deno-lint-ignore cf-imports/no-inline-module-import
  const { StorageManager } = await import(
    "@commonfabric/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  // Shared first-party posture (CT-1814); emulated storage is the local-dev
  // delta and stays visible here.
  const runtimeOptions = runtimePresets.localDev({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get),
  });
  return new Runtime({
    ...runtimeOptions,
    ...(options.consoleToStderr
      ? { consoleHandler: stderrConsoleHandler }
      : {}),
  });
}

export interface ProcessOptions {
  main: string;
  rootPath?: string;
  run: boolean;
  check: boolean;
  output?: string;
  showTransformed?: boolean;
  mainExport?: string;
  verboseErrors?: boolean;
  space?: string;
  patternJson?: boolean;

  /** Data file paths to attach, so a pattern that reads one can run here. */
  dataFilePaths?: string[];
}

export interface ProcessResult {
  output: string;
  main?: Record<string, unknown>;
  transformed?: string;
  patternJson?: string;
}

export async function process(
  options: ProcessOptions,
): Promise<ProcessResult> {
  const runtime = await createRuntime({
    consoleToStderr: options.patternJson,
  });
  // Compile/evaluate through the runtime's OWN harness, not a second Engine.
  // Verified-load registration, source maps, and module hashes all live on the
  // engine that evaluates the bundle; the runner and the builder's source-
  // location annotation consult `runtime.harness`. A separate Engine splits
  // that state, so `fn.src` stays a raw bundle coordinate and CFC verified-
  // binding identities (writeAuthorizedBy) fail under enforcement.
  const engine = runtime.harness;
  const localOptions = {
    main: options.main,
    ...(options.rootPath === undefined ? {} : { root: options.rootPath }),
    ...(options.dataFilePaths === undefined
      ? {}
      : { dataFilePaths: options.dataFilePaths }),
  };
  let program: RuntimeProgram;
  if (options.space) {
    program = await resolveLocalProgram(
      (resolver) => collectLocalProgram(resolver, { fabricImports: "allow" }),
      localOptions,
    );
  } else {
    // engine.resolve fails fabric specifiers as generic unresolved modules;
    // scan first so they get the friendlier requires-a-space message. The
    // scan's program is discarded — only its refusal matters.
    await resolveLocalProgram(
      (resolver) => collectLocalProgram(resolver, { fabricImports: "reject" }),
      localOptions,
    );
    program = await resolveLocalProgram(
      (resolver) => engine.resolve(resolver),
      localOptions,
    );
  }
  if (options.mainExport) {
    program.mainExport = options.mainExport;
  }
  let transformed: string | undefined;
  const getTransformedProgram = options.showTransformed
    ? (program: Program) => {
      transformed = formatTransformed(program);
    }
    : undefined;
  const { id, graph, mainSpecifier, resolvedPins } = await engine
    .compileToRecordGraph(
      program,
      {
        noCheck: !options.check,
        getTransformedProgram,
        verboseErrors: options.verboseErrors,
        fabricImports: options.space
          ? {
            space: options.space as MemorySpace,
            allowUnpinned: true,
          }
          : undefined,
      },
    );
  for (const pin of resolvedPins) {
    console.error(
      `resolved ${pin.specifier} -> @${pin.resolvedIdentity} (not pinned; run cf deps update to pin)`,
    );
  }

  // Concatenated per-module compiled bodies (the same composition the SES
  // loader evaluates), for inspection via --output.
  const output = [...graph.compiledBodies.entries()]
    .map(([specifier, body]) => `// ${specifier}\n${body}`)
    .join("\n");
  if (options.output) {
    await Deno.writeTextFile(options.output, output);
  }

  if (!options.run) {
    return { output, transformed };
  }

  const { main } = engine.evaluateRecordGraph(
    id,
    graph,
    mainSpecifier,
    program,
  );
  const patternJson = options.patternJson && main
    ? serializeMainExport(main, options.mainExport)
    : undefined;
  return { output, main, transformed, patternJson };
}

export function serializeMainExport(
  exports: Record<string, unknown>,
  mainExportName?: string,
): string {
  const exportName = mainExportName ?? "default";
  const mainExport = exportName in exports ? exports[exportName] : exports;
  try {
    const value = JSON.stringify(mainExport, null, 2);
    if (value === undefined) {
      throw new Error("Main export not serializable.");
    }
    return value;
  } catch (_) {
    throw new Error("Main export not serializable.");
  }
}

function formatTransformed(program: Program): string {
  return program.files
    .map(({ contents, name }) => `// transformed: ${name}\n${contents}`)
    .join("\n");
}

/**
 * Walk a local resolver's import graph into a Program, leaving fabric (cf:)
 * specifiers to the engine's FabricAwareResolver. Malformed cf: specifiers
 * fail here with their parse error; valid ones either pass through
 * (`"allow"`) or trigger the requires-a-space error (`"reject"`, for compiles
 * with no fabric context). Shared by `cf check` and `cf deps`.
 */
export async function collectLocalProgram(
  resolver: ProgramResolver,
  options: { fabricImports: "allow" | "reject" },
): Promise<Program> {
  const main = await resolver.main();
  const pending = [main];
  const seen = new Set<string>();
  const files: Source[] = [];

  while (pending.length > 0) {
    const source = pending.shift()!;
    if (seen.has(source.name)) continue;
    seen.add(source.name);
    files.push(source);

    for (const specifier of collectImportSpecifiers(source, TARGET)) {
      if (specifier.startsWith("cf:")) {
        parseFabricRef(specifier); // malformed → FabricRefError, here
        if (options.fabricImports === "reject") {
          throw new Error(FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE);
        }
        continue;
      }

      // This walk feeds `cf check` and `cf deps` with no compile behind it,
      // so an escape unrefused here is a silently collected wrong file.
      assertImportInsideProgramRoot(specifier, source);
      const identifier = resolveImportSpecifier(specifier, source);
      if (!isFileSystemSourceIdentifier(identifier) || seen.has(identifier)) {
        continue;
      }
      const resolved = await resolver.resolveSource(identifier);
      if (resolved !== undefined) pending.push(resolved);
    }
  }

  return { main: main.name, files };
}

function isFileSystemSourceIdentifier(
  identifier: string,
): identifier is Source["name"] {
  return identifier.startsWith("/");
}
