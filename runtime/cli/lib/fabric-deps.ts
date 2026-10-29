import {
  type MemorySpace,
  resolveFabricRefToIdentity,
  rewriteFabricPins,
  type Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";

export interface ProgramFabricPinRewrite {
  file: string;
  specifier: string;
  pinned: string;
  resolvedIdentity: string;
  line: number;
}

export interface PinProgramOptions {
  importSpecifier?: string;
}

export async function pinProgramFabricImports(
  runtime: Runtime,
  space: MemorySpace,
  program: RuntimeProgram,
  options: PinProgramOptions = {},
): Promise<{ program: RuntimeProgram; rewrites: ProgramFabricPinRewrite[] }> {
  const rewrites: ProgramFabricPinRewrite[] = [];
  const files = [];
  // A data file's bytes are stored exactly as authored and are never read as
  // code. Parsing one for import specifiers would rewrite text that only
  // resembles an import, so pinning skips them.
  const dataFiles = new Set(program.dataFiles ?? []);

  for (const file of program.files) {
    if (dataFiles.has(file.name)) {
      files.push(file);
      continue;
    }
    const resolvedBySpecifier = new Map<string, string>();
    const rewritten = await rewriteFabricPins(
      file.contents,
      async (ref, specifier) => {
        if (
          options.importSpecifier !== undefined &&
          specifier !== options.importSpecifier
        ) {
          return null;
        }
        const resolved = await resolveFabricRefToIdentity(runtime, space, ref);
        resolvedBySpecifier.set(specifier, resolved.entryIdentity);
        return resolved.entryIdentity;
      },
    );

    for (const rewrite of rewritten.rewrites) {
      rewrites.push({
        file: file.name,
        ...rewrite,
        resolvedIdentity: resolvedBySpecifier.get(rewrite.specifier)!,
      });
    }
    files.push({ ...file, contents: rewritten.contents });
  }

  return {
    program: { ...program, files },
    rewrites,
  };
}

export function renderPinRewrite(rewrite: ProgramFabricPinRewrite): string {
  return `pinned ${rewrite.specifier} -> @${rewrite.resolvedIdentity}`;
}
