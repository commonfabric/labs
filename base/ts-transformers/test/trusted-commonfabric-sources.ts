import ts from "typescript";
import { registerCommonFabricDeclarationSources } from "@commonfabric/schema-generator/common-fabric-symbols";

export const TRUSTED_COMMONFABRIC_GLOBALS_SOURCE_NAME =
  "/$builtins/commonfabric-globals.d.ts";

/**
 * Minimal global declarations for AST-policy unit harnesses that intentionally
 * avoid module resolution. Declarations authored in the test source merge with
 * these compiler-owned globals, while block-local shadows remain untrusted.
 */
export const TRUSTED_COMMONFABRIC_GLOBALS = `
declare function pattern<T>(callback: T): T;
declare function handler<T>(...args: any[]): T;
declare function action<T>(...args: any[]): T;
declare function lift<T>(...args: any[]): T;
declare function computed<T>(callback: () => T): T;
declare function cell<T>(value: T): T;
declare function ifElse<T>(predicate: any, whenTrue: T, whenFalse: T): T;
declare function when<T>(predicate: any, value: T): T;
declare function unless<T>(predicate: any, value: T): T;
declare function wish<T>(...args: any[]): T;
declare function generateText<T>(...args: any[]): T;
declare function generateObject<T>(...args: any[]): T;
declare function fetchBinary<T>(...args: any[]): T;
declare function fetchText<T>(...args: any[]): T;
declare function fetchJson<T>(...args: any[]): T;
declare function fetchJsonUnchecked<T>(...args: any[]): T;
declare function fetchProgram<T>(...args: any[]): T;
declare function navigateTo<T>(...args: any[]): T;
`;

/**
 * Register exact SourceFile objects that a test harness supplied as its
 * compiler-owned Common Fabric API. Callers remain the authority: this helper
 * never infers trust from a filename or module declaration string.
 */
export function registerTrustedCommonFabricTestSources(
  program: ts.Program,
  sourceNames: readonly string[],
): void {
  const sources = sourceNames.flatMap((sourceName) => {
    const source = program.getSourceFile(sourceName);
    return source ? [source] : [];
  });
  if (sources.length > 0) {
    registerCommonFabricDeclarationSources(program.getTypeChecker(), sources);
  }
}

/** Canonical source names owned by the shared virtual Common Fabric harness. */
export function sharedCommonFabricTestSourceNames(
  types: Readonly<Record<string, string>>,
): string[] {
  return ["commonfabric.d.ts", "commonfabric-schema.d.ts", "cfc.ts"]
    .filter((sourceName) => types[sourceName] !== undefined);
}
