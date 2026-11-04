import type { VirtualModuleRecord } from "./esm-module-loader.ts";
import {
  type BindingInfo,
  classifyModuleItems,
} from "./compiled-bundle-verifier.ts";
import {
  findTopLevelEquals,
  parseFunctionText,
  splitTopLevelCommaList,
  type StatementChunk,
  trimRange,
} from "./compiled-js-parser.ts";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "./runtime-module-policy.ts";
import {
  isAllowedTsLibHelperDeclaration,
  normalizeExact,
} from "./tslib-helpers.ts";

/**
 * Structural pre-flight verification for a module-record graph; see
 * docs/specs/module-loading.md §"Graph shape and wiring". It validates the
 * *shape and wiring* of the graph before any module executes — every specifier
 * is content-addressed,
 * every record is well-formed, and every resolved import points at a present
 * record.
 *
 * The deep SES_SANDBOXING module-item classification is provided by
 * {@link verifyCompiledModuleBody}, built on the `classifyModuleItems` core.
 */

const VALID_SPECIFIER = /^cf:(module|runtime)\//;

const EMPTY_BINDING_SET: ReadonlySet<string> = new Set<string>();

// A compiled-CommonJS import preamble statement, e.g.
//   const util_ts_1 = require("./util.ts");
//   const cf_1 = __importDefault(require("commonfabric"));
//   const ns_1 = __importStar(require("./ns.ts"));
//   var sibling_ts_1 = require("./sibling.ts");
// Captures (1) the declaration kind, (2) the local binding name, and (3) the
// imported specifier. Both `const` and `var` are matched: TypeScript's CommonJS
// emit declares the module reference for a *re-export* (`export { x } from
// "./m"`) with `var` (hoisted ahead of the live `Object.defineProperty(exports,
// …, { get })` getter) while plain imports use `const`. Accepting `var` is what
// lets a barrel re-export load instead of failing SES at runtime (CT-1661); it
// is canonical compiler output for an import edge the graph verifier has already
// checked.
//
// The `var` form is gated on a *non-runtime* (local) specifier at the call site:
// a `const` runtime binding is immutable (reassigning a `const` throws at
// runtime), but a `var` one is not, and the verifier does not inspect trusted
// builder-callback bodies — so a `var` runtime binding could be reassigned to
// attacker code from inside a callback and still pass trusted-builder
// classification. TS only emits `var` for re-export module references, which are
// always local, so runtime imports stay `const`-only.
const REQUIRE_IMPORT = new RegExp(
  "^(const|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
    "(?:__importDefault|__importStar)?\\s*\\(?\\s*" +
    "require\\(\\s*[\"']([^\"']+)[\"']\\s*\\)\\s*\\)?\\s*;?$",
);

// A bare side-effect import preamble statement, e.g. `require("./styles.ts");`
// (compiled from `import "./styles.ts"`). It binds nothing and names an ordinary
// dependency, so it is allowed (when the specifier is) and skipped rather than
// classified as executable code.
const SIDE_EFFECT_REQUIRE = /^require\(\s*["']([^"']+)["']\s*\)\s*;?$/;

// `export * from "./m"` compiles to `__exportStar(require("./m"), exports);`,
// with the require inline rather than as a separate binding. This re-export form
// binds nothing; allow it when the specifier is allowed, otherwise let it fall
// through to classification (which rejects it).
const EXPORT_STAR_REQUIRE =
  /^__exportStar\(\s*require\(\s*["']([^"']+)["']\s*\)\s*,\s*exports\s*\)\s*;?$/;

const SIMPLE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The top-level binding names a statement introduces, restricted to the simple
 * cases the verifier would otherwise *accept* (so a shadow could go unnoticed):
 * function/class declarations and `const`/`let`/`var` declarators. Multi-
 * declarator lists (`const a = 1, __exportStar = …`) are split depth-aware via
 * the shared comma/equals parsers — a leading-anchored regex would only see the
 * first declarator and miss the rest.
 *
 * Malformed or destructuring declarators throw out of the parsers; those are
 * rejected by `classifyModuleItems` regardless, so returning no names here stays
 * fail-closed.
 */
function shadowNamesInStatement(
  source: string,
  statement: StatementChunk,
  text: string,
): string[] {
  const fn = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text);
  if (fn) return [fn[1]];
  const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (cls) return [cls[1]];
  const kind = /^(?:const|let|var)\b/.exec(text)?.[0];
  if (!kind) return [];
  try {
    const trimmed = trimRange(source, statement.start, statement.end);
    const listStart = trimmed.start + kind.length;
    let listEnd = trimmed.end;
    while (listEnd > listStart && /\s/.test(source[listEnd - 1])) listEnd--;
    if (listEnd > listStart && source[listEnd - 1] === ";") listEnd--;
    const names: string[] = [];
    for (const range of splitTopLevelCommaList(source, listStart, listEnd)) {
      const equals = findTopLevelEquals(source, range.start, range.end);
      const nameRange = trimRange(source, range.start, equals ?? range.end);
      const name = source.slice(nameRange.start, nameRange.end);
      if (SIMPLE_IDENTIFIER.test(name)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Security-classify a module's compiled-CommonJS body. It recognizes the
 * `const x = require("…")` import preamble — seeding `env` with import bindings
 * (marking runtime modules as trusted) — and hands the remaining top-level items
 * to the shared {@link classifyModuleItems} core with empty shadow-guard /
 * reserved-binding sets: the module wrapper puts no loader binding in scope
 * around the body, so there is nothing to shadow or reserve. Throws on any
 * violation.
 */
export function verifyCompiledModuleBody(
  compiled: string,
  filename = "<module>",
): { hasHoistRegistration: boolean } {
  // Wrap so the shared parser can extract the top-level statements as a function
  // body; offsets stay consistent with `wrapped` for classification.
  const wrapped = `function () {\n${compiled}\n}`;
  const parsed = parseFunctionText(wrapped, 0, wrapped.length);
  const statementTexts = parsed.body.statements.map((s) =>
    wrapped.slice(s.start, s.end).trim()
  );

  // If the body declares its own top-level binding for one of the identifiers a
  // fast-path trusts (`require`, or the TS interop helpers `__exportStar` /
  // `__importDefault` / `__importStar`), the corresponding fast-path would
  // mis-trust a call into attacker-controlled code (e.g. a local
  // `function __exportStar(m){ globalThis.steal = m; }` invoked by an
  // `__exportStar(require("./m"), exports)` re-export). Detect such shadows and
  // disable the affected fast-path so the statement falls through to
  // classifyModuleItems, which rejects the call as a local-callable result: a
  // non-canonical helper gets no special treatment.
  //
  // Canonical TS interop helper declarations (`var __exportStar = (this && …)`)
  // are the trusted helpers themselves, not shadows, so they are excluded.
  const shadowed = new Set<string>();
  parsed.body.statements.forEach((statement, index) => {
    const text = statementTexts[index];
    if (isAllowedTsLibHelperDeclaration(normalizeExact(text))) return;
    for (const name of shadowNamesInStatement(wrapped, statement, text)) {
      shadowed.add(name);
    }
  });

  const requireShadowed = shadowed.has("require");
  const exportStarShadowed = shadowed.has("__exportStar");
  const importDefaultShadowed = shadowed.has("__importDefault");
  const importStarShadowed = shadowed.has("__importStar");

  const env = new Map<string, BindingInfo>();
  const classifiable: typeof parsed.body.statements = [];
  parsed.body.statements.forEach((statement, index) => {
    const text = statementTexts[index];
    // Only fast-path imports whose specifier is allowed (runtime module or a
    // local path); arbitrary specifiers (e.g. "node:fs") fall through and are
    // rejected by classification, per the dependency allowlist in
    // runtime-module-policy.ts. The fast-path is disabled entirely when
    // `require` is shadowed.
    // Inline TS interop helper declarations (`var __importDefault = …`, etc.)
    // are emitted per-module for default/namespace imports and re-exports. They
    // are canonical compiler output (byte-matched), trusted, and `var` — skip
    // them before classification, which would otherwise reject the `var`.
    if (isAllowedTsLibHelperDeclaration(normalizeExact(text))) {
      return;
    }
    if (!requireShadowed) {
      const bound = REQUIRE_IMPORT.exec(text);
      // A helper-wrapped import (`__importDefault(require(...))` /
      // `__importStar(require(...))`) must not be fast-pathed if *that specific*
      // helper is locally shadowed — the shadow would run instead of the
      // trusted helper. Checked per-helper so shadowing one does not
      // unnecessarily disable a legitimate import using the other.
      const usesShadowedImportHelper =
        (importDefaultShadowed && /\b__importDefault\s*\(/.test(text)) ||
        (importStarShadowed && /\b__importStar\s*\(/.test(text));
      // A `var` import binding is mutable at runtime, so only accept it for a
      // non-runtime (local) specifier — never a trusted runtime module (see the
      // REQUIRE_IMPORT comment). A `var` runtime require falls through and is
      // rejected by classification as a top-level mutable binding.
      const isRuntime = bound ? isRuntimeModuleIdentifier(bound[3]) : false;
      const mutableRuntimeBinding = bound?.[1] === "var" && isRuntime;
      if (
        bound && !usesShadowedImportHelper && !mutableRuntimeBinding &&
        isAllowedAuthoredImportSpecifier(bound[3])
      ) {
        const [, , binding, specifier] = bound;
        env.set(binding, {
          kind: "import",
          dependencySpecifier: specifier,
          namespaceImport: true,
          trustedRuntimeName: isRuntime ? specifier : undefined,
        });
        return;
      }
      const sideEffect = SIDE_EFFECT_REQUIRE.exec(text);
      if (sideEffect && isAllowedAuthoredImportSpecifier(sideEffect[1])) {
        return; // side-effect import binds nothing
      }
      const exportStar = EXPORT_STAR_REQUIRE.exec(text);
      if (
        exportStar && !exportStarShadowed &&
        isAllowedAuthoredImportSpecifier(exportStar[1])
      ) {
        return; // `export * from "<allowed>"` re-export; binds nothing
      }
    }
    classifiable.push(statement);
  });

  return classifyModuleItems(wrapped, filename, classifiable, env, {
    requiredGuards: EMPTY_BINDING_SET,
    reservedBindings: EMPTY_BINDING_SET,
    missingGuardsErrorAt: 0,
  });
}

export class ModuleGraphVerificationError extends Error {
  override name = "ModuleGraphVerificationError";
}

export function verifyModuleGraph(
  records: Map<string, VirtualModuleRecord>,
  entrySpecifier: string,
): void {
  if (!records.has(entrySpecifier)) {
    throw new ModuleGraphVerificationError(
      `Module graph entry specifier is not present: ${entrySpecifier}`,
    );
  }

  for (const [specifier, record] of records) {
    if (!VALID_SPECIFIER.test(specifier)) {
      throw new ModuleGraphVerificationError(
        `Non-content-addressed module specifier: ${specifier}`,
      );
    }
    if (!Array.isArray(record.imports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array imports list`,
      );
    }
    if (!Array.isArray(record.exports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array exports list`,
      );
    }
    if (typeof record.execute !== "function") {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-function execute`,
      );
    }
    // Every resolution must remap a *declared* import — a resolution for a
    // specifier the record never imports is a smuggled edge.
    if (record.resolutions) {
      for (const key of Object.keys(record.resolutions)) {
        if (!record.imports.includes(key)) {
          throw new ModuleGraphVerificationError(
            `Record ${specifier} resolves an undeclared import "${key}"`,
          );
        }
      }
    }
    for (const importSpecifier of record.imports) {
      const target = record.resolutions?.[importSpecifier] ?? importSpecifier;
      // The resolved target must itself be content-addressed (a cf:module/ or
      // cf:runtime/ specifier), not an arbitrary string. Without this, a record
      // could rewire an import edge to ANY present key — e.g. an unresolved
      // `/x` / `node:fs` left verbatim by the compiler's fallback branch, or a
      // sibling's specifier — and inherit a trusted (runtime) record's
      // namespace. Presence alone is not enough; the edge must point into the
      // content-addressed namespace.
      if (!VALID_SPECIFIER.test(target)) {
        throw new ModuleGraphVerificationError(
          `Record ${specifier} has a non-content-addressed import target "${importSpecifier}" -> "${target}"`,
        );
      }
      // A trusted runtime import must resolve to ITS matching runtime record,
      // not an arbitrary content-addressed sibling. The body verifier marks
      // `require("commonfabric")` as a trusted runtime binding based on the
      // authored specifier; without this, a record could declare
      // `imports: ["commonfabric"]` with `resolutions: { commonfabric:
      // "cf:module/evil" }` and be handed a sibling module's namespace under a
      // trusted-runtime binding (rewire-to-sibling for host APIs).
      if (
        isRuntimeModuleIdentifier(importSpecifier) &&
        target !== `cf:runtime/${importSpecifier}`
      ) {
        throw new ModuleGraphVerificationError(
          `Record ${specifier} resolves runtime import "${importSpecifier}" to "${target}" instead of "cf:runtime/${importSpecifier}"`,
        );
      }
      if (!records.has(target)) {
        throw new ModuleGraphVerificationError(
          `Record ${specifier} has an unresolved import "${importSpecifier}" -> "${target}"`,
        );
      }
    }
  }
}
