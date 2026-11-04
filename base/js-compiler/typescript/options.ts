import type { CompilerOptions } from "typescript";
import { JsxEmit, ModuleKind, ScriptTarget } from "typescript";

export const TARGET_TYPE_LIB = "es2023";
export const MODULE_KIND = ModuleKind.CommonJS;
export const TARGET = ScriptTarget.ES2023;

export const getCompilerOptions = (): CompilerOptions => {
  return {
    //
    // Typechecking
    //

    strict: true,
    strictNullChecks: true,
    strictFunctionTypes: true,

    //
    // Module
    //

    // Per-module CommonJS bodies — the inputs the ESM module-record loader
    // and verifier consume.
    module: MODULE_KIND,

    //
    // Emit
    //

    removeComments: true,
    // Belt-and-suspenders on authoring paths; the pipeline's explicit checks
    // (syntactic + program + semantic gates) throw first. Stored-source
    // compiles override this to false (see compileToModulesSteps): there the
    // checker deliberately drops authoring-hygiene codes like TS2578, and
    // TypeScript's own emit veto would re-block exactly what was filtered
    // (CT-1916).
    noEmitOnError: true,
    // Note: declaration emit is disabled because TypeScript's declaration emit
    // has trouble with unique symbols (CELL_BRAND, CELL_INNER_TYPE) in exported
    // types, causing emit to skip entirely. Declaration checking is done
    // explicitly via checker.declarationCheck() instead.
    declaration: false,
    // Enable source map generation. The mappings are load-bearing: stack-frame
    // mapping uses them to recover authored positions from compiled code.
    sourceMap: true,
    // Do not embed the authored source in the map. `sourcesContent` has no
    // reader: the only code that touches it (composeBundleSourceMap) copies it
    // into the runtime's source-map registry, but the consumers there
    // (SourceMapParser, via originalPositionFor) read the mappings only, and
    // no `//# sourceMappingURL` is emitted for a debugger to load these maps.
    // The authored source is persisted separately as source documents.
    // Dropping it cuts the per-module source-map bytes the compile cache
    // stores and syncs by ~65% (e.g. ~110KB to ~38.5KB on the group-chat
    // bundle).
    inlineSources: false,
    // Generate separate source map instead of inline
    inlineSourceMap: false,

    //
    // JavaScript
    //

    allowJs: true,
    // Authored `.js` sources emit their compiled body under the SAME name
    // (`/math.js` in → `/math.js` out). TypeScript vetoes that as an input
    // overwrite, but compilation runs against `VirtualFs`, which keeps reads
    // (`fsRead`) and writes (`fsWrite`) in separate stores — the input is never
    // clobbered. Suppress the check so `allowJs` works on the per-module emit
    // path. (`compileToModules` still fails loudly when two DIFFERENT sources
    // collide on one output, e.g. `/a.ts` + `/a.js`.)
    suppressOutputPathCheck: true,

    //
    // Interop
    //

    forceConsistentCasingInFileNames: true,
    esModuleInterop: true,
    isolatedModules: false,

    //
    // Language and Environment
    //

    jsx: JsxEmit.React,
    // The reserved helper binding keeps authored locals out of JSX dispatch.
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    target: TARGET,
    // `lib` should autoapply, but we need to manage default libraries since
    // we are running outside of node. The Compiler API needs the actual file
    // names to register these virtual files as default libraries; extensionless
    // names load, but `Program.isSourceFileDefaultLibrary()` rejects them.
    // Ensure the target lib matches `target`.
    lib: [`${TARGET_TYPE_LIB}.d.ts`, "dom.d.ts", "jsx.d.ts"],
    // Dynamic import/requires and `<reference` pragmas
    // should not be respected.
    noResolve: true,
  };
};
