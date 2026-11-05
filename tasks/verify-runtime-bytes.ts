import ts from "typescript";

/** Emits parseable runtime code with comments removed for a provenance comparison. */
export function emitRuntimeCode(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
  });
  if (result.diagnostics?.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => Deno.cwd(),
        getNewLine: () => "\n",
      }),
    );
  }
  return result.outputText;
}

if (import.meta.main) {
  for (const file of Deno.args) {
    const emitted = emitRuntimeCode(await Deno.readTextFile(file), file);
    console.log(JSON.stringify({ file, emitted }));
  }
}
