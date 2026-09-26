import { isObjectOrArray, isPrimitive } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { isInertArray } from "@commonfabric/utils/arrays";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import {
  assertValidFabricValueLayer,
  FabricInstance,
  FabricPrimitive,
  refuseFabricInstance,
  shallowFabricFromConvertibleJsObjectElseUndefined,
} from "@commonfabric/data-model";
import { type AliasBinding, isAliasBinding } from "../alias-binding.ts";
import {
  type FabricExecFunction,
  type FabricExecPlainObject,
  type FabricExecValue,
  isPattern,
  type Module,
  type Pattern,
  type Reactive,
  type toEncodableForm,
  type toJSON,
} from "./types.ts";
import { getTopFrame } from "./pattern.ts";
import {
  getArtifactEntryRef,
  getPatternProgram,
  isKeylessPatternIdentity,
  noteDerivedCopy,
} from "./pattern-metadata.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";
import {
  encodableFormOf,
  hasEncodableForm,
  replaceArtifacts,
} from "../encodable-form.ts";

export type CellAliasResolver = (
  cell: Reactive<any>,
  path: readonly PropertyKey[],
  ignoreSelfAliases: boolean,
) => AliasBinding | null | undefined;

// Surfaces the body-only module write (see `moduleToEncodableForm`). It has
// its own name so write-time diagnostics can be silenced or raised without
// touching everything the `runner` logger carries.
const serializeShapeLogger = getLogger("builder.serialize-shape", {
  logCountEvery: 0,
});

/**
 * The refusal a `FabricInstance` gets from the binding walks. Nothing reaches
 * it in production today, de facto: a `FabricError` is exposed to pattern
 * authors and ungated, so what keeps this safe is that no caller builds one
 * into a binding, not that none could.
 *
 * TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
 * point this becomes a walk rather than a refusal.
 */
function refuseBoundFabricInstance(value: FabricInstance): never {
  refuseFabricInstance(value, "in a pattern binding");
}

export function withAliasBindings(
  value: unknown,
  resolveCellAlias?: CellAliasResolver,
  ignoreSelfAliases: boolean = false,
  path: readonly PropertyKey[] = [],
  seen?: WeakMap<object, number>,
): FabricExecValue {
  // Turn strongly typed builder values into the serialized binding structure:
  // cell references become `$alias` records, and data leaves come through as
  // the `FabricValue`s they are.

  // Convert regular cells and results from Cell.get() to opaque refs
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) {
    const { external, frame } = value.export();

    // If this is an external reference, just copy the reference as is.
    if (external) return external as FabricExecValue;

    // Verify that opaque refs are not in a parent frame
    if (frame !== getTopFrame()) {
      throw new Error(
        `Cell with parent cell not found in current frame. Likely a closure that should have been transformed.`,
      );
    }

    // Otherwise it's an internal reference. Ask the pattern builder how this
    // cell should be represented in the serialized pattern.
    const alias = resolveCellAlias?.(
      value as Reactive<any>,
      path,
      ignoreSelfAliases,
    );
    if (alias === null) return undefined;
    if (alias !== undefined) return alias as unknown as FabricExecValue;
    throw new Error(`Cell not found in pattern aliases`);
  }

  // If we encounter a link, it's from a nested pattern.
  if (isAliasBinding(value)) {
    const alias = (value as AliasBinding).$alias;
    // If this was a shadow ref, i.e. a nested pattern, see whether we're now at
    // the level that it should be resolved to the actual cell.
    if (alias.partialCause !== undefined) {
      return {
        $alias: {
          partialCause: alias.partialCause,
          defer: (alias.defer ?? 0) + 1,
          path: alias.path,
          ...(alias.scope !== undefined && { scope: alias.scope }),
          ...(alias.schema !== undefined && { schema: alias.schema }),
        },
      } satisfies AliasBinding;
    } else if (!("cell" in alias) || typeof (alias.cell) === "string") {
      // If we encounter an existing alias and it isn't an absolute reference
      // with a cell id, then increase the nesting level. (Named-cell aliases
      // carry no scope; only partialCause aliases do.)
      return {
        $alias: {
          cell: alias.cell,
          defer: (alias.defer ?? 0) + 1,
          path: alias.path,
          ...(alias.schema !== undefined && { schema: alias.schema }),
        },
      } satisfies AliasBinding;
    } else {
      throw new Error(`Invalid alias cell`);
    }
  }

  // If this is an INERT array, process each element recursively. A non-inert
  // array falls through to the sanctioned conversion below, which refuses it,
  // for the same reason a non-inert plain object is refused there: `.map()`
  // rebuilds by index, so it drops a named or symbol-keyed property and
  // EVALUATES an accessor-backed index into a data property, and -- since
  // `.map()` honors `Symbol.species` -- hands back an `Array` subclass instance
  // still carrying its live prototype. The first two produce an array that
  // satisfies `isValidFabricValue()` while meaning something else; the last
  // produces one that does not satisfy it at all.
  if (isInertArray(value)) {
    return value.map((v, i) =>
      withAliasBindings(v, resolveCellAlias, ignoreSelfAliases, [
        ...path,
        i,
      ], seen)
    );
  }

  // A `FabricPrimitive` is an atomic value whose state lives in private fields
  // (zero enumerable own-props), so the `for...in` copy below would flatten it
  // to `{}`. It leaves whole, and it leaves FIRST: it is also a record, so an
  // `isObjectOrArray()` test would otherwise claim it.
  if (value instanceof FabricPrimitive) return value;

  // A `FabricInstance` is NOT a leaf. It is a container reached by its codec
  // contents rather than by property name, which this walk cannot do, so the
  // `for...in` copy would rebuild it from zero enumerable own properties as
  // `{}`. It refuses instead of doing that quietly.
  if (value instanceof FabricInstance) refuseBoundFabricInstance(value);

  // Whatever reaches here is handed to the sanctioned conversion, which mints
  // its fabric form or -- there being nothing to mint -- leaves it to the vet
  // to refuse. Three kinds arrive: a native carrying a canonical fabric form
  // (a `Uint8Array`, a `Date`); a non-inert array, which the array branch
  // above declines to walk; and a value with no fabric representation at all.
  //
  // The INERT tests -- this one and the array test above -- are what keep this
  // function's output vetted, and neither is interchangeable with a bare
  // plain-object or array check. An inert container is already known good, so
  // it skips the conversion and is walked in place -- no clone allocated only
  // to be dropped when the `for...in` below rebuilds it. Every other record
  // goes to the conversion and is converted or REJECTED there.
  //
  // A plain object that is not inert must be among the rejected. Excluding it
  // here instead would launder it exactly as a native would be laundered: the
  // `for...in` rebuild silently drops a symbol key and a non-enumerable
  // property, EVALUATES an accessor into a data property, and reparents a
  // null-prototype object -- each producing a plain object that satisfies
  // `isValidFabricValue()` while meaning something else. Nothing downstream can
  // catch it, because what it produces is genuinely valid.
  if (
    isObjectOrArray(value) && !isPattern(value) && !isInertPlainObject(value)
  ) {
    const minted = shallowFabricFromConvertibleJsObjectElseUndefined(value);
    if (minted === undefined) {
      // Nothing was minted, so the value would have to be walkable as it
      // stands, and this is what holds it to that. Everything reaching this
      // arm is in fact refused: an inert array returned above, an inert plain
      // object is excluded by the guard just made, and a value already in
      // fabric form returned earlier still. Routing a non-inert plain object
      // HERE rather than excluding it above is what gets it refused.
      assertValidFabricValueLayer(value);
    } else if (minted instanceof FabricInstance) {
      // An `Error` mints a `FabricError`.
      refuseBoundFabricInstance(minted);
    } else {
      // A `Uint8Array` mints a `FabricBytes`, a `Date` a `FabricEpochNsec`.
      return minted as FabricExecValue;
    }
  }

  // If this is an object or a pattern, process each key recursively.
  if (isObjectOrArray(value) || isPattern(value)) {
    // Guard against circular object references (e.g. schema objects with
    // shared identity between $defs and sibling properties).
    if (!seen) seen = new WeakMap();
    // Circularity is keyed on object identity, and the conversion above is
    // the only thing that could hand back a different one -- which it does
    // only for a leaf, and every leaf returns or is refused on the spot. So a
    // value reaching this walk still carries the identity it arrived under,
    // and marking that one identity catches every cycle back to it.
    const depth = seen.get(value as object) ?? 0;
    if (depth > 0) return {}; // Actually circular
    seen.set(value as object, depth + 1);

    // If this is a pattern, serialize it through the INTERNAL graph
    // serializer (its toJSON under the internal-serialization context): this
    // function builds the in-memory node representation, so embedded
    // sub-pattern graphs must stay bare — no boundary `$patternRef`.
    const valueToProcess: Readonly<Record<string, unknown>> =
      (isPattern(value) && hasEncodableForm(value))
        ? serializePatternGraph(value)
        : (value as Readonly<Record<string, unknown>>);

    const result: Record<string, FabricExecValue> = {};
    for (const key in valueToProcess) {
      const boundValue = withAliasBindings(
        valueToProcess[key],
        resolveCellAlias,
        ignoreSelfAliases,
        [...path, key],
        seen,
      );
      if (boundValue !== undefined) {
        result[key] = boundValue;
      }
    }

    // Restore depth so shared references can be re-serialized
    seen.set(value as object, depth);

    // Register the copy's derivation link so trust and the content-addressed
    // entry ref carry to the serialized copy (side table; symbol keys would be
    // dropped by JSON anyway).
    if (isPattern(value)) noteDerivedCopy(result, value);

    return result;
  }

  // What remains is a leaf that is not an object: a primitive or a function.
  if (isPrimitive(value)) return value;

  // A function stands as itself. It is a builder artifact, or a member of a
  // module this walk is rebuilding key by key: a JavaScript module's
  // `implementation`, or an artifact's own serializers. That second kind is
  // not an execution value, which this cast does not show, and which is why
  // `pattern.ts` asserts a walked module back to a `Module`.
  //
  // TODO(danfuzz): bind a module, and a pattern graph's nodes, through their
  // declared members rather than as records, at which point a function reaching
  // here is always an artifact and neither assertion is needed.
  return value as FabricExecFunction;
}

export function moduleToEncodableForm(module: Module): FabricExecPlainObject {
  const frame = getTopFrame();
  // Destructure-and-drop the runtime-only members a module carries for the
  // builder's own use: its serializer under BOTH the names it answers to
  // (`toEncodableForm`, and `toJSON` for the JSON protocol -- see
  // `json-member.ts`), and the handler ergonomics
  // (`mod.with(...)`/`mod.bind(...)`). None is part of the serialized
  // contract; left in, each would surface as a "not representable as a
  // `FabricValue`: function" rejection, so they are destructured out
  // here. `to-encodable-form.test.ts` asserts the whole resulting key set, an extra
  // member being a changed content-derived id for every value that carries a
  // module.
  const {
    implementation: _implementation,
    toEncodableForm: _toEncodableForm,
    toJSON: _toJSON,
    with: _with,
    bind: _bind,
    ...rest
  } = module as Module & toEncodableForm & Partial<toJSON> & {
    with?: unknown;
    bind?: unknown;
  };
  let implementation = module.implementation;

  // CT-1230 WORKAROUND: Preserve pattern structure when serializing pattern modules.
  //
  // Problem: When a subpattern is passed to .map(), the pattern's implementation
  // was being stringified (e.g., "(inputs2) => { ... }") instead of preserving
  // the actual pattern structure. This caused "Invalid pattern" errors at runtime
  // because isPattern() check failed on the string.
  //
  // Why this helps: Using withAliasBindings ensures nested $alias bindings
  // get their nesting level incremented properly. Without this, aliases could be
  // bound to a specific doc too early, causing handlers to point at stale docs
  // when the pattern is later executed in a different context.
  //
  // We don't fully understand why the original code stringified pattern functions,
  // but this defensive change ensures patterns passed as values (like to map())
  // retain their structure and alias metadata.
  if (
    module.type === "pattern" && implementation && isPattern(implementation)
  ) {
    implementation = withAliasBindings(
      implementation,
    ) as unknown as Pattern;
    return {
      ...rest,
      implementation,
    };
  }

  if (typeof implementation === "function") {
    // Content-addressed reference: when the implementation function has
    // module-scope provenance (recorded by the module indexing during a
    // verified evaluation — `toJSON` runs at cell-write time,
    // post-evaluation), serialize its `{ identity, symbol }` so a rehydrated
    // module resolves by identity. Host-trusted functions carry the same
    // shape through their minted pseudo-module entry ref (identity E5,
    // design §5) — closure-bearing, so by-identity resolution is their only
    // rehydration. Everything else (test-built, never verified) keeps its
    // stringified body below for the SES fallback.
    const provenance = module.type === "javascript"
      ? getVerifiedProvenance(implementation)
      : undefined;
    // The entry-ref fallback (host pseudo-modules) is REGISTRY-scoped, unlike
    // provenance (process-global, content-derived): emit it only when the
    // serializing frame's OWN engine resolves the ref to this very function —
    // a host trust grant in another runtime of the same process proves
    // nothing here (Codex/cubic P1 on the E5 PR).
    const entryRefCandidate =
      provenance?.symbol === undefined && module.type === "javascript"
        ? getArtifactEntryRef(implementation)
        : undefined;
    const entryRefValue = entryRefCandidate !== undefined &&
        frame?.runtime?.harness?.getVerifiedImplementation?.(
            entryRefCandidate.identity,
            entryRefCandidate.symbol,
          ) === implementation
      ? entryRefCandidate
      : undefined;
    const implRefValue = (provenance?.symbol
      ? { identity: provenance.identity, symbol: provenance.symbol }
      : undefined) ?? entryRefValue;
    if (module.type === "javascript" && implRefValue === undefined) {
      // This module serializes body-only with no `$implRef` — a shape a
      // reader can resolve only through the bare-SES stringified-source
      // fallback, where module-scope references do not exist. Surfacing it
      // here catches the shape as it is written, which is the only signal for
      // graphs serialized inline rather than persisted by pattern reference.
      serializeShapeLogger.error("noref-body-write", () => [
        "Serializing a function implementation with neither provenance nor a" +
        " verified entry ref (body-only, no $implRef)",
        {
          preview: Function.prototype.toString.call(implementation).slice(
            0,
            80,
          ),
        },
      ]);
    }
    const implRef = implRefValue ? { $implRef: implRefValue } : {};
    const preview = (implementation as { preview?: string }).preview ??
      implementation.toString().slice(0, 200);
    const location = (implementation as { src?: string }).src;
    // Omit the stringified body only when the implementation is resolvable on
    // load BY THE RUNTIME THAT WILL READ IT: its engine's content-addressed
    // implementation index admits the `$implRef`. Provenance is
    // process-global, so a `$implRef` being PRESENT does not by itself prove
    // the reading runtime can resolve it: a pattern compiled by a standalone
    // Engine and registered on another runtime carries `$implRef`, but that
    // runtime's engine never verified-evaluated the module, so it must keep
    // the stringified body as the fallback or reload throws. The engine index
    // — unlike the bounded artifact index — never evicts within a session.
    const implRefResolvable = implRefValue !== undefined &&
      typeof frame?.runtime?.harness?.getVerifiedImplementation?.(
          implRefValue.identity,
          implRefValue.symbol,
        ) === "function";
    return {
      ...rest,
      ...implRef,
      ...(module.type === "javascript" && !implRefResolvable
        ? {
          implementation: Function.prototype.toString.call(implementation),
        }
        : {}),
      ...(preview ? { preview } : {}),
      ...(location ? { location } : {}),
    };
  }

  return {
    ...rest,
    ...(implementation !== undefined ? { implementation } : {}),
  };
}

// Ambient context: true while serializing the runtime-INTERNAL graph
// representation (builder-time node serialization via
// `withAliasBindings`, and through it the `$opFallback` eviction
// fallback graphs). The storage boundary (`Pattern.toEncodableForm()`, reached
// by the runtime's artifact walk on the way into a cell write) adds
// the content-addressed `$patternRef` on top of the graph; internal
// serialization must NOT, or in-memory `Pattern.nodes` would grow refs for
// any sub-pattern whose module is already indexed (e.g. builder calls inside
// a running action referencing an imported, already-evaluated pattern) and
// the eviction fallback would silently become a ref (design §7's $opFallback
// trap). Synchronous push/pop — serialization never awaits.
let internalGraphSerialization = false;

/**
 * Serialize a pattern's full node-graph — the runtime-internal representation
 * (design §7: the graph is internal; the boundary speaks refs-first). Used by
 * `withAliasBindings` (builder-time node serialization, which the
 * `$opFallback` graphs descend from) and debug tooling.
 *
 * Asks the pattern for its own encodable form rather than calling
 * `patternToEncodableForm` directly: a factory's closure deliberately serializes the
 * ROOT factory (which carries `.program`, set after construction — see
 * builder/pattern.ts), so the indirection is load-bearing.
 */
export function serializePatternGraph(
  pattern: Pattern,
): Record<string, unknown> {
  const previous = internalGraphSerialization;
  internalGraphSerialization = true;
  try {
    // `undefined` as the no-form answer is what stands the fallback behind the
    // `??`, and one read gets there. A pattern's form is a record by
    // construction, so nothing nullish can arrive from the other side.
    return (encodableFormOf(pattern, undefined) ??
      patternToEncodableForm(pattern)) as Record<string, unknown>;
  } finally {
    internalGraphSerialization = previous;
  }
}

export function patternToEncodableForm(
  pattern: Pattern,
): FabricExecPlainObject {
  // Serialize only the STABLE program identity ({main, mainExport}), never the
  // authored `files`. The `files` array serializes non-canonically (two
  // encodings -> two content ids), so embedding it dragged a session-varying
  // blob into every serialized pattern and thrashed link ids / re-ran actions
  // on reload. {main, mainExport} are deterministic strings, so they reload
  // stably; they are kept because consumers read them (e.g. the CLI
  // `dev --pattern-json` output asserts `program.mainExport`). The full
  // program-with-files is recovered from the `pattern:<identity>` source docs
  // (the single durable source — written by every cold compile);
  // sub-patterns are referenced by {identity, symbol} on the ESM path.
  const program = getPatternProgram(pattern);
  const programIdentity = program
    ? {
      main: program.main,
      ...(program.mainExport !== undefined
        ? { mainExport: program.mainExport }
        : {}),
    }
    : undefined;
  const graph = {
    argumentSchema: pattern.argumentSchema,
    resultSchema: pattern.resultSchema,
    ...(pattern.derivedInternalCells
      ? { derivedInternalCells: pattern.derivedInternalCells }
      : {}),
    result: pattern.result,
    nodes: pattern.nodes,
    ...(programIdentity ? { program: programIdentity } : {}),
  };
  if (internalGraphSerialization) return graph;
  // JSON boundary (cell writes, `JSON.stringify`): REFS-ONLY (design §7,
  // identity E4). The ref is content-derived, so identical bytes re-emit the
  // identical ref across sessions. Schemas ride along so consumers read them
  // without resolving. Rehydration is by identity: the session-lifetime
  // artifact index, or `loadPatternByIdentity` for an async reader.
  //
  // A pattern with NO entry ref serializes its full graph instead, since
  // nothing could resolve its ref. That graph holds LIVE modules, so the walk
  // replaces its artifacts here.
  //
  // A session-synthetic `keyless:` ref counts as NO entry ref at this
  // boundary (L3(a), RULED 2026-08-27: keyless identities must never land
  // durably). The mint (`ensureKeylessPatternIdentity`) sets the value's
  // forward entry ref for in-session by-identity resolution; without this
  // check, any later boundary write of the minted VALUE would emit a
  // `$patternRef` no other session can ever resolve, in place of the designed
  // full-graph fallback.
  //
  // `moduleToEncodableForm` reads `getTopFrame()` to decide `$implRef`. A
  // frame inherits its parent's runtime (`builder/pattern.ts`), so
  // `frame.runtime` is the same at every point along one stack.
  const entryRef = getArtifactEntryRef(pattern);
  return entryRef && !isKeylessPatternIdentity(entryRef.identity)
    ? {
      $patternRef: { identity: entryRef.identity, symbol: entryRef.symbol },
      argumentSchema: pattern.argumentSchema,
      resultSchema: pattern.resultSchema,
    }
    : replaceArtifacts(graph, noteDerivedCopy);
}
