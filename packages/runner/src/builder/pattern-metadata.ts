import { isObjectNotArray } from "@commonfabric/utils/types";
import type { RuntimeProgram } from "../harness/types.ts";
import {
  type DerivedInternalCellDescriptor,
  isPattern,
  type Pattern,
} from "./types.ts";

/**
 * Side-table storage for pattern metadata that is associated *after* a pattern
 * is exported from its module:
 *
 * - `program` — the rehydration source (`RuntimeProgram`) attached by the engine
 *   after compilation/eval and at registration time.
 *
 * This used to live as an own data property (`pattern.program`) on the
 * pattern object. Storing it in a module-level WeakMap instead lets the ESM
 * loader `harden()` exported pattern values at the module boundary: the
 * association is still attached later, but a WeakMap write does not mutate
 * the (now frozen) object. Keyed by `object` (patterns are callable objects),
 * with WeakMap GC semantics so a value's metadata is collected with the
 * value.
 */

const programByPattern = new WeakMap<object, RuntimeProgram>();

// Provenance brand: a value is added here ONLY by the trusted `pattern()`
// builder (see builder/pattern.ts). `isPattern` is a purely structural check
// (`{argumentSchema, resultSchema, nodes}`), so an attacker can forge that shape
// via `__cf_data({...})` — a frozen plain object that passes `isPattern`.
// Trust-granting sites (program / verified-load-id association, entry-pattern
// selection) must use `isTrustedPattern` instead, so forged pattern-shaped data
// cannot launder itself into the trust side-tables. The runner's own
// instantiation logic keeps using structural `isPattern` (it operates on
// derivation copies and independently re-resolves node implementations).
const trustedPatterns = new WeakSet<object>();

// Provenance brand for the OTHER trusted builder artifacts — `lift`, `handler`,
// and the node factories they produce (see builder/module.ts `createNodeFactory`).
// `pattern()` brands `trustedPatterns` instead. Kept as a separate set so the
// pattern-only trust gate (`isTrustedPattern`, used by CFC) is unchanged, while
// `isTrustedBuilderArtifact` accepts any trusted builder output. Like the pattern
// brand, this is the gate that stops `__cf_data`-forged data from acquiring a
// content-addressed `{ identity, symbol }` reference via `__cfReg`.
//
// Held lazily on this hoisted accessor rather than a top-level `const`/`let`:
// unlike `pattern()`, `createNodeFactory` is invoked at MODULE-INIT time by some
// builtins (e.g. builtins/sqlite/query-node), which runs inside the builder
// import cycle — a top-level binding would still be in its temporal dead zone at
// that point. A function declaration IS fully hoisted, so caching the `WeakSet`
// on it sidesteps the init-order dependency entirely.
function trustedBuilderArtifacts(): WeakSet<object> {
  const self = trustedBuilderArtifacts as { set?: WeakSet<object> };
  return (self.set ??= new WeakSet<object>());
}

function asKey(value: unknown): object | undefined {
  if (value === null) return undefined;
  return (typeof value === "object" || typeof value === "function")
    ? (value as object)
    : undefined;
}

/** The rehydration source associated with a pattern, if any. */
export function getPatternProgram(
  pattern: unknown,
): RuntimeProgram | undefined {
  const key = asKey(pattern);
  return key ? programByPattern.get(key) : undefined;
}

/** Associate a rehydration source with a pattern (works on frozen patterns). */
export function setPatternProgram(
  pattern: unknown,
  program: RuntimeProgram,
): void {
  const key = asKey(pattern);
  if (key) programByPattern.set(key, program);
}

/** Stamp a value as produced by the trusted `pattern()` builder. */
export function brandTrustedPattern<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedPatterns.add(key);
  return value;
}

// Derivation tracking: `copy → root original`. Replaces the former
// `unsafe_originalPattern` symbol backref. Registered ONLY by trusted-builder
// copy sites (`noteDerivedCopy` callers: build-time graph serialization in
// to-encodable-form, traversal copies in traverse-utils, binding copies in
// pattern-binding, and the `asScope`/`inSpace` factory derivations in
// builder/pattern.ts — the latter reachable from authored pattern code, which
// is sound because both objects are builder-minted and already branded) —
// forged values never enter, since nothing on the
// object itself can establish the link. Module-level (not per-manager): the
// copy sites live in builder-layer utilities with no PatternManager handle,
// and the linked facts (trust brands, content-addressed entry refs) are
// globally meaningful. WeakMap keys are the per-runtime live objects, so
// multiple runtimes in one process cannot collide.
const derivedFrom = new WeakMap<object, object>();

// Content-addressed `{ identity, symbol }` entry ref per live builder
// artifact. Written (first-write-wins) by the PatternManager's indexing of
// evaluated modules (`indexArtifact`, gated on `isTrustedBuilderArtifact`);
// promoted here from the manager so derived copies can resolve refs without a
// manager handle. The reverse index (`addressableByIdentity`, identity → live
// value) stays per-manager — it holds live values per runtime and is bounded.
const entryRefByValue = new WeakMap<
  object,
  { identity: string; symbol: string }
>();

/** The accepted addressing format for one piece's generated cells. */
export type GeneratedCellIdentity = {
  /** Zero preserves legacy addresses; one includes the authored entry ref. */
  readonly version: 0 | 1;
  /** The accepted, loadable authored artifact. */
  readonly identity: string;
  /** The artifact's registered entry symbol. */
  readonly symbol: string;
};

const generatedIdentityByPattern = new WeakMap<
  object,
  GeneratedCellIdentity | null
>();
const generatedIdentityByDescriptor = new WeakMap<
  object,
  GeneratedCellIdentity | null
>();

/** Parse persisted addressing metadata, refusing formats this runtime cannot honor. */
export function parseGeneratedCellIdentity(
  value: unknown,
): GeneratedCellIdentity | undefined {
  if (value === undefined) return undefined;
  if (
    !isObjectNotArray(value) || (value.version !== 0 && value.version !== 1) ||
    typeof value.identity !== "string" || typeof value.symbol !== "string" ||
    isKeylessPatternIdentity(value.identity)
  ) {
    throw new Error("Unsupported generated cell identity metadata");
  }
  return {
    version: value.version,
    identity: value.identity,
    symbol: value.symbol,
  };
}

/** Prepare independent descriptors for a piece; null selects session-only legacy. */
export function prepareGeneratedCellIdentity(
  pattern: Pattern,
  selection: GeneratedCellIdentity | null,
): Pattern {
  if (
    selection !== null &&
    (!isTrustedPattern(pattern) || isKeylessPatternIdentity(selection.identity))
  ) {
    throw new Error(
      "Generated cell identity requires a trusted, loadable artifact",
    );
  }
  selection = selection === null ? null : Object.freeze({ ...selection });
  const copy = {
    ...pattern,
    derivedInternalCells: pattern.derivedInternalCells?.map((descriptor) => ({
      ...descriptor,
    })),
  };
  noteDerivedCopy(copy, pattern);
  generatedIdentityByPattern.set(copy, selection);
  for (const descriptor of copy.derivedInternalCells ?? []) {
    generatedIdentityByDescriptor.set(descriptor, selection);
  }
  return copy;
}

/** The effective hash cause, using only the instance's prepared context. */
export function generatedInternalCellCause(
  descriptor: DerivedInternalCellDescriptor,
): DerivedInternalCellDescriptor["partialCause"] {
  const selection = generatedIdentityByDescriptor.get(descriptor);
  return selection?.version === 1 &&
      isObjectNotArray(descriptor.partialCause) &&
      "$generated" in descriptor.partialCause
    ? {
      ...descriptor.partialCause,
      $artifact: { identity: selection.identity, symbol: selection.symbol },
    }
    : descriptor.partialCause;
}

/**
 * Resolve a (possibly derived) value to its root original. Identity for
 * values that were never copied. Bounded: the chain is a tree toward the
 * root original (copies are fresh objects), but guard against cycles anyway.
 */
export function resolveOriginal<T>(value: T): T {
  let current = asKey(value);
  if (!current) return value;
  const seen = new Set<object>();
  while (true) {
    const next = derivedFrom.get(current);
    if (!next || next === current || seen.has(next)) break;
    seen.add(current);
    current = next;
  }
  return current as T;
}

/**
 * Record that `copy` is a derivation/serialized copy of `original`, carrying
 * its identity facts forward:
 *
 * - trust propagates EAGERLY (sound: builders brand their artifacts at
 *   creation time, before any copy can be made);
 * - a REAL entry ref propagates eagerly when already known — a session
 *   `keyless:` ref never does (pinning the mint onto the copy would shadow
 *   the root's later real promotion; see the guard in the body) — and
 *   lookups still walk `derivedFrom` lazily ({@link getArtifactEntryRef})
 *   because refs are indexed only post-evaluation — AFTER build-time
 *   copies were made.
 *
 * Only runner-owned copy sites may call this; it is the sole way a copy can
 * inherit trust, so forged values (which are never passed here with a trusted
 * original) gain nothing.
 */
export function noteDerivedCopy(copy: unknown, original: unknown): void {
  const c = asKey(copy);
  const o = asKey(original);
  if (!c || !o || c === o) return;
  const root = resolveOriginal(o);
  derivedFrom.set(c, root);
  // Instance context belongs to the exact copy, independently of artifact provenance.
  if (generatedIdentityByPattern.has(o) && isPattern(copy)) {
    const selection = generatedIdentityByPattern.get(o)!;
    generatedIdentityByPattern.set(c, selection);
    for (const descriptor of copy.derivedInternalCells ?? []) {
      generatedIdentityByDescriptor.set(descriptor, selection);
    }
  }
  if (generatedIdentityByDescriptor.has(o)) {
    generatedIdentityByDescriptor.set(c, generatedIdentityByDescriptor.get(o)!);
  }

  if (trustedPatterns.has(root)) trustedPatterns.add(c);
  if (trustedBuilderArtifacts().has(root)) trustedBuilderArtifacts().add(c);
  // Eager ref propagation is an optimization only — the lazy root walk in
  // `getArtifactEntryRef` serves a copy without an own entry — and it must
  // never pin a SESSION-synthetic ref onto the copy: `getArtifactEntryRef`
  // consults the exact object first, so a keyless ref copied here would
  // shadow the root's later REAL promotion (module indexing after
  // build-time copies) for this copy forever. Real refs are immutable
  // facts and safe to pin; keyless ones stay root-resolved.
  const ref = entryRefByValue.get(root);
  if (
    ref && !entryRefByValue.has(c) && !isKeylessPatternIdentity(ref.identity)
  ) {
    entryRefByValue.set(c, ref);
  }
}

/**
 * Prefix of a session-synthetic keyless pattern identity — minted by
 * `PatternManager.ensureKeylessPatternIdentity` for a hand-built pattern with
 * no content-addressed entry ref. Session-only by construction (no
 * source/compiled closure exists behind it), so such an identity must never
 * be written into durable state (L3(a), RULED 2026-08-27).
 */
export const KEYLESS_PATTERN_IDENTITY_PREFIX = "keyless:";

/**
 * Whether `identity` is a session-synthetic keyless pointer rather than a
 * durable content-addressed artifact identity. A fresh runtime can never load
 * a keyless pointer.
 */
export function isKeylessPatternIdentity(identity: string): boolean {
  return identity.startsWith(KEYLESS_PATTERN_IDENTITY_PREFIX);
}

/**
 * Associate a content-addressed `{ identity, symbol }` entry ref with a live
 * builder artifact. First write wins (an artifact may be reachable under
 * several symbols; the first registration is canonical, matching the
 * pre-existing `valueToEntryRef` semantics) — with one deliberate exception:
 * a REAL (content-addressed) ref replaces a session-synthetic `keyless:`
 * one. The keyless mint can run before a module's post-evaluation indexing
 * ("refs are indexed only post-evaluation — AFTER build-time copies were
 * made"), and letting the mint win would permanently shadow the value's real,
 * loadable identity behind a pointer no other session can resolve.
 */
export function setArtifactEntryRef(
  value: unknown,
  ref: { identity: string; symbol: string },
): void {
  const key = asKey(value);
  if (!key) return;
  const existing = entryRefByValue.get(key);
  if (
    existing !== undefined &&
    !(isKeylessPatternIdentity(existing.identity) &&
      !isKeylessPatternIdentity(ref.identity))
  ) {
    return;
  }
  entryRefByValue.set(key, ref);
}

/**
 * The content-addressed `{ identity, symbol }` entry ref for a value — the
 * exact object first, then its root original (a copy made before the ref was
 * indexed resolves through the derivation link).
 */
export function getArtifactEntryRef(
  value: unknown,
): { identity: string; symbol: string } | undefined {
  const key = asKey(value);
  if (!key) return undefined;
  return entryRefByValue.get(key) ??
    entryRefByValue.get(resolveOriginal(key) as object);
}

/**
 * The first REAL (non-keyless) content-addressed entry ref reachable from
 * `value` along its derivation chain — the value itself, then each recorded
 * `derivedFrom` step toward the root original ("walk up as many steps as
 * needed"). This is the module-addressed PRODUCER identity of a runtime-built
 * pattern value: the keyless population is values whose producing code is
 * cf:module-addressed (CT-1644/CT-1655 hoisting), and a derived copy's chain
 * ends at that addressable original.
 *
 * Returns undefined when no step carries a real ref — a from-scratch
 * hand-built value with no recorded producer link (frames carry the building
 * code's `implementationIdentity`, but nothing records it per-artifact, and a
 * lift module's identity would not be a loadable PATTERN identity for the
 * value anyway). Callers must treat that as "no durable convergence
 * possible", never substitute the keyless ref.
 */
export function resolveProducerEntryRef(
  value: unknown,
): { identity: string; symbol: string } | undefined {
  let current = asKey(value);
  if (!current) return undefined;
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const ref = entryRefByValue.get(current);
    if (ref !== undefined && !isKeylessPatternIdentity(ref.identity)) {
      return ref;
    }
    const next = derivedFrom.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return undefined;
}

// The authored file a pattern was defined in, per live builder artifact.
//
// Distinct from `programByPattern`, which holds the whole source CLOSURE and is
// deliberately absent on the by-identity reload path. This is just the
// filename, which that path does know and can afford to keep — enough to map a
// live pattern back to a file without carrying its sources.
//
// A WeakMap for the same reason `programByPattern` is one: an evaluated
// module's exports are HARDENED, so defining a property on one throws ("object
// is not extensible"). The association has to live beside the value, not on it.
const sourcePathByValue = new WeakMap<object, string>();

/**
 * Associate the authored file a builder artifact came from. Written by the
 * PatternManager when it indexes an evaluated module, alongside the entry ref.
 *
 * LAST write wins, which is the opposite of {@link setArtifactEntryRef} and is
 * load-bearing rather than incidental. A re-export barrel puts the SAME artifact
 * object in two namespaces, so this is called twice for it — once with the
 * barrel's filename, once with the defining module's. The defining module is the
 * answer that is useful (it is the file a reader must edit, and the only one
 * whose default export is this artifact), and it comes LAST because the evaluate
 * loop walks `graph.specifierByPath` importer-first. First-write-wins would name
 * the barrel. `Engine.#recordModuleProvenance` solves the same re-export
 * ambiguity explicitly; here the traversal order supplies it, so a change to
 * that order has to preserve this.
 *
 * Gated on trusted-builder provenance to match the two writes it sits beside in
 * `registerEvaluatedModules` — `indexArtifact` and `recordModuleProvenance` both
 * gate the same way. Nothing that reaches {@link getPatternSourcePath} is
 * untrusted, so the gate costs no coverage and keeps the table's population
 * equal to the artifact index's.
 */
export function setPatternSourcePath(
  value: unknown,
  sourcePath: string,
): void {
  if (!isTrustedBuilderArtifact(value)) return;
  const key = asKey(value);
  if (key) sourcePathByValue.set(key, sourcePath);
}

/**
 * The authored file a builder artifact came from — the exact object first, then
 * its root original.
 *
 * The derivation walk is load-bearing, not defensive: a nested pattern reaches
 * the runner as a derivation COPY (binding and traversal copies), and the
 * source path is stamped post-evaluation on the module export it was copied
 * from. Probing only the exact object misses every sub-pattern, which is the
 * whole population this table exists to name. Same lazy resolution, and for the
 * same reason, as {@link getArtifactEntryRef}.
 */
export function getPatternSourcePath(value: unknown): string | undefined {
  const key = asKey(value);
  if (!key) return undefined;
  return sourcePathByValue.get(key) ??
    sourcePathByValue.get(resolveOriginal(key) as object);
}

/**
 * True only for a value that is structurally a pattern AND has trusted builder
 * provenance — either it carries the brand directly, or it is a derivation /
 * serialized copy registered via {@link noteDerivedCopy} (which propagates the
 * brand eagerly). A `__cf_data`-forged pattern-shaped object is `isPattern`
 * but NOT `isTrustedPattern`: no own property can grant trust (the brand and
 * derivation link live in runner-private WeakSets/WeakMaps), and forged values
 * never reach `noteDerivedCopy` with a trusted original.
 */
export function isTrustedPattern(value: unknown): value is Pattern {
  if (!isPattern(value)) return false;
  const key = asKey(value);
  if (!key) return false;
  return trustedPatterns.has(key) ||
    trustedPatterns.has(resolveOriginal(key) as object);
}

/** Stamp a value as produced by a trusted non-pattern builder (lift/handler/…). */
export function brandTrustedBuilderArtifact<T>(value: T): T {
  const key = asKey(value);
  if (key) trustedBuilderArtifacts().add(key);
  return value;
}

/**
 * True for any value with trusted-builder provenance — a trusted pattern OR a
 * branded lift/handler/node-factory — including derivation / serialized
 * copies registered via {@link noteDerivedCopy}. This is the gate that decides
 * whether a `__cfReg`-registered value may receive a content-addressed
 * `{ identity, symbol }` reference; forged plain data carries no brand and is
 * rejected. Pure WeakSet/WeakMap probes — no property reads, so exotic values
 * (e.g. a Proxy with a throwing get trap) cannot abort registration/lookup.
 */
export function isTrustedBuilderArtifact(value: unknown): boolean {
  const key = asKey(value);
  if (!key) return false;
  if (trustedBuilderArtifacts().has(key) || trustedPatterns.has(key)) {
    return true;
  }
  const root = resolveOriginal(key) as object;
  return trustedBuilderArtifacts().has(root) || trustedPatterns.has(root);
}
