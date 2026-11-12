import { ensureSESLockdown } from "./ses-runtime.ts";
import { verifyModuleGraph } from "./module-record-verifier.ts";

/**
 * SES module-graph loader; see docs/specs/module-loading.md §"Loader:
 * per-module records in SES compartments".
 *
 * Loads a graph of per-module records through the SES Compartment module
 * system using synchronous `importNow`. Modules are addressed by
 * content-addressed specifiers (`cf:module/<hash>`), and runtime modules
 * (`commonfabric`, …) are ordinary records in the same graph.
 *
 * This version uses SES "virtual" (third-party) module records — `{ imports,
 * exports, execute }` — because this build of `ses` does not expose a
 * `ModuleSource`/`StaticModuleRecord` constructor. Each record evaluates
 * synchronously, preserving the scheduler's synchronous execution contract, and
 * import cycles resolve through lazy `compartment.importNow` inside `execute`.
 * A caller that must not hold its thread for a whole graph evaluates it a module
 * at a time ({@link openModuleGraph}).
 */

/** A SES third-party (virtual) module record. */
export interface VirtualModuleRecord {
  /** Specifiers this module imports (as written in the module). */
  imports: string[];

  /** Names this module exports. */
  exports: string[];

  /**
   * Maps each of this module's import specifiers to the absolute
   * (content-addressed) specifier it resolves to. When omitted, an import
   * specifier resolves to itself (used by runtime-module records whose imports
   * are already absolute).
   */
  resolutions?: Record<string, string>;

  /**
   * Populate `moduleExports`. Use `compartment.importNow(resolvedImports[spec])`
   * to obtain an imported module's namespace.
   */
  execute(
    moduleExports: Record<string, unknown>,
    compartment: SesCompartment,
    resolvedImports: Record<string, string>,
  ): void;
}

interface SesCompartment {
  importNow(specifier: string): Record<string, unknown>;
  evaluate(source: string): unknown;
  globalThis: Record<string, unknown>;
}

interface SesCompartmentCtor {
  new (
    globals: Record<string, unknown>,
    moduleMap: Record<string, unknown>,
    options: {
      name?: string;
      resolveHook(importSpecifier: string, referrer: string): string;
      importNowHook(specifier: string): VirtualModuleRecord;
    },
  ): SesCompartment;
}

export interface SesModuleLoaderOptions {
  /** Records keyed by absolute (content-addressed) specifier. */
  records: Map<string, VirtualModuleRecord>;

  /** Global endowments for the compartment. */
  globals?: Record<string, unknown>;

  /** Optional compartment name, for diagnostics. */
  name?: string;

  /**
   * Run structural graph verification before loading. Default true. The deep
   * SES classification port is still pending (see module-record-verifier.ts).
   */
  verify?: boolean;
}

/**
 * Load `entrySpecifier` and its transitive dependencies synchronously,
 * returning the entry module's namespace.
 *
 * SECURITY: `verify` performs only *structural* validation. It is NOT a
 * security boundary — the SES_SANDBOXING module-item classification lives in
 * the per-module body verifier (see module-record-verifier.ts). Callers must
 * treat the module graph as trusted/already-classified.
 */
export function importModuleGraphNow(
  entrySpecifier: string,
  options: SesModuleLoaderOptions,
): Record<string, unknown> {
  return loadModuleGraph(entrySpecifier, options).namespace;
}

/**
 * Like {@link importModuleGraphNow} but returns the loaded entry namespace plus
 * an `importNow` bound to the SAME compartment, so additional already-loaded
 * module specifiers can be retrieved (as singletons) without re-instantiating
 * the graph.
 */
export function loadModuleGraph(
  entrySpecifier: string,
  options: SesModuleLoaderOptions,
): {
  namespace: Record<string, unknown>;
  importNow: (specifier: string) => Record<string, unknown>;
} {
  const { evaluationOrder, importNow } = openModuleGraph(
    entrySpecifier,
    options,
  );
  for (const specifier of evaluationOrder) importNow(specifier);
  return { namespace: importNow(entrySpecifier), importNow };
}

/**
 * Returns the specifier that `importSpecifier` resolves to for `record`: its
 * entry in the record's `resolutions`, and otherwise the specifier itself.
 */
export function resolveRecordImport(
  record: VirtualModuleRecord,
  importSpecifier: string,
): string {
  const { resolutions } = record;
  return resolutions !== undefined &&
      Object.hasOwn(resolutions, importSpecifier)
    ? resolutions[importSpecifier]
    : importSpecifier;
}

/**
 * Helper for {@link openModuleGraph}: returns the specifiers to import, in
 * order, so that each import evaluates as little as it can.
 *
 * A compiled body evaluates each import as it reaches that import's `require`,
 * nested inside its own evaluation, and `imports` lists those in the order the
 * body reaches them. So a depth-first walk of `imports`, listing each module
 * after its imports, finishes modules in the order that importing the entry
 * alone finishes them, and each body then finds its imports already evaluated.
 * Only code a body runs ahead of an `import` statement moves: it runs after that
 * import rather than before it, which is the order ES modules give it.
 *
 * A cycle is listed by the one module the walk entered it through, and everything
 * the walk first reached through that module evaluates nested inside it. A cycle
 * decides which of its modules sees another's exports half-populated, and that
 * depends on which one evaluates first and on when each `require` is reached.
 * Throws if the graph is missing a record, so that nothing of an incomplete graph
 * evaluates.
 */
function moduleEvaluationOrder(
  records: ReadonlyMap<string, VirtualModuleRecord>,
  entrySpecifier: string,
): string[] {
  const order: string[] = [];
  // Where the walk entered each module, or `Infinity` once its cycle is closed.
  const enteredAt = new Map<string, number>();
  const unclosed: string[] = [];

  // Returns the earliest entry point still unclosed that `specifier` reaches.
  const visit = (specifier: string): number => {
    const record = records.get(specifier);
    if (record === undefined) {
      throw new Error(`Unknown module specifier: ${specifier}`);
    }
    const entry = enteredAt.size;
    const orderOnEntry = order.length;
    enteredAt.set(specifier, entry);
    unclosed.push(specifier);
    let earliest = entry;
    for (const importSpecifier of record.imports) {
      const target = resolveRecordImport(record, importSpecifier);
      earliest = Math.min(earliest, enteredAt.get(target) ?? visit(target));
    }
    if (earliest === entry) {
      const closed = unclosed.splice(unclosed.lastIndexOf(specifier));
      for (const member of closed) enteredAt.set(member, Infinity);
      if (closed.length > 1) order.length = orderOnEntry;
      order.push(specifier);
    }
    return earliest;
  };

  visit(entrySpecifier);
  return order;
}

/**
 * Sets up a compartment for the graph at `entrySpecifier` and evaluates none of
 * it. Importing each of `evaluationOrder` in turn evaluates the graph in the same
 * order as importing the entry alone does (see {@link moduleEvaluationOrder}),
 * so a caller can give up its thread between those imports; a module's own
 * evaluation stays one synchronous stretch.
 */
export function openModuleGraph(
  entrySpecifier: string,
  options: SesModuleLoaderOptions,
): {
  evaluationOrder: readonly string[];
  importNow: (specifier: string) => Record<string, unknown>;
} {
  ensureSESLockdown();
  const { records, globals = {}, name = "cf:esm", verify = true } = options;

  if (verify) {
    verifyModuleGraph(records, entrySpecifier);
  }

  // The lockdown above comes from ses-runtime.ts, whose `ses` import installs
  // `Compartment`.
  const CompartmentCtor = (globalThis as { Compartment?: SesCompartmentCtor })
    .Compartment!;

  const compartment = new CompartmentCtor({ ...globals }, {}, {
    name,
    // Resolve an import specifier against the referrer's resolution map. Runtime
    // modules and hand-built records whose imports are already absolute omit
    // `resolutions`, in which case resolution is the identity function.
    resolveHook: (importSpecifier: string, referrer: string) => {
      const resolutions = records.get(referrer)?.resolutions;
      return resolutions?.[importSpecifier] ?? importSpecifier;
    },
    importNowHook: (specifier: string) => {
      const record = records.get(specifier);
      if (!record) {
        throw new Error(`Unknown module specifier: ${specifier}`);
      }
      return record;
    },
  });
  // SES freezes intrinsics, but compartment global bindings remain writable
  // unless explicitly locked down, so a module could poison globals seen by
  // siblings. Mirror createCompartment() in ses-runtime.ts.
  Object.freeze(compartment.globalThis);

  return {
    evaluationOrder: moduleEvaluationOrder(records, entrySpecifier),
    importNow: (specifier: string) => compartment.importNow(specifier),
  };
}

/**
 * Build virtual module records for the runtime modules (`commonfabric`, …) from
 * the host's `runtimeExports` map, keyed by `cf:runtime/<specifier>` to match
 * the content-addressed specifiers the adapter resolves runtime imports to.
 * Each record simply copies the (already frozen) runtime namespace onto its
 * module exports — these are the trusted host APIs, not authored code.
 */
export function runtimeModuleRecords(
  runtimeExports: Record<string, Record<string, unknown>>,
): Map<string, VirtualModuleRecord> {
  const records = new Map<string, VirtualModuleRecord>();
  for (const [specifier, namespace] of Object.entries(runtimeExports)) {
    const exportNames = Object.keys(namespace);
    const declared = exportNames.includes("__esModule")
      ? exportNames
      : [...exportNames, "__esModule"];
    records.set(`cf:runtime/${specifier}`, {
      imports: [],
      exports: declared,
      execute: (moduleExports) => {
        for (const name of exportNames) {
          moduleExports[name] = namespace[name];
        }
        moduleExports.__esModule = true;
      },
    });
  }
  return records;
}
