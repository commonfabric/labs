import { setArtifactEntryRef } from "../builder/pattern-metadata.ts";
import { isPattern } from "../builder/types.ts";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
import type { UnsafeHostTrustOptions } from "../unsafe-host-trust.ts";
import type { HarnessedFunction } from "./types.ts";

/**
 * The engine's executable store: the content-addressed implementation index
 * (`{identity, symbol}` → fn) — the single resolution backing for serialized
 * `$implRef`s. (Identity E5 deleted the legacy string-keyed
 * `implementationRef` index: stored data predating the writer flip is not
 * supported anymore — see the data-wipe decision in the implementation plan —
 * and the two categories that still wrote legacy refs are gone: in-action
 * minting now throws at creation time, and host-trusted values ride minted
 * pseudo-modules below.)
 */
export class ExecutableRegistry {
  /**
   * Content-addressed implementation index: module identity → symbol → the
   * implementation function recorded by `Engine.#recordModuleProvenance()`
   * during a verified evaluation (and by `trustHostValue()` for host
   * pseudo-modules). Deliberately _strong_ and session-unbounded: a serialized
   * module carries _only_ `$implRef` (no body when the writer proved this index
   * admits the ref), so resolution must never lose an implementation whose
   * module evaluated this session. Retention is bounded by the set of
   * _distinct_ verified implementations evaluated per session.
   */
  readonly #verifiedImplementationsByEntryRef = new Map<
    string,
    Map<string, HarnessedFunction>
  >();

  /**
   * Counter for host pseudo-module identities: each `trustHostValue()` call
   * mints a _unique_ `host:<n>` identity — uniqueness over content-derivation,
   * deliberately: host functions are closure-bearing, so two with identical
   * bytes are _not_ interchangeable. Host values are in-session only (a live
   * closure never survives a session), so a session-scoped counter is exactly
   * the right lifetime, and the session-lifetime index above is exactly the
   * right resolution home.
   */
  #nextHostModuleId = 0;

  readonly #hostRegisteredFunctions = new WeakSet<HarnessedFunction>();

  clear(): void {
    this.#verifiedImplementationsByEntryRef.clear();
    this.#nextHostModuleId = 0;
    // `#hostRegisteredFunctions` is a WeakSet (uniterable); entries age out
    // with their functions. Stale membership after clear() is harmless: it
    // only suppresses a re-registration, and the entry-ref the function
    // already carries stays valid for the life of the object.
  }

  /**
   * Record a verified implementation under its content-addressed
   * `{ identity, symbol }` entry ref. Overwrites: a re-evaluation of the same
   * identity resolves to the fresh function (mirroring the artifact index;
   * any two instances of one module identity are interchangeable — the SES
   * verifier forbids module-scope mutable state).
   */
  registerVerifiedImplementation(
    identity: string,
    symbol: string,
    implementation: HarnessedFunction,
  ): void {
    let bucket = this.#verifiedImplementationsByEntryRef.get(identity);
    if (!bucket) {
      bucket = new Map();
      this.#verifiedImplementationsByEntryRef.set(identity, bucket);
    }
    bucket.set(symbol, implementation);
  }

  getVerifiedImplementation(
    identity: string,
    symbol: string,
  ): HarnessedFunction | undefined {
    return this.#verifiedImplementationsByEntryRef.get(identity)?.get(symbol);
  }

  /**
   * Trust a host-provided value: walk it, and register every reachable
   * function as a symbol of a freshly minted `host:<n>` pseudo-module —
   * `{ identity, symbol }` entry ref stamped (so `moduleToEncodableForm` emits a
   * normal `$implRef`, body omitted) and the implementation admitted into the
   * session-lifetime index above (so the `$implRef` resolves through the same
   * arm as every verified module).
   *
   * Host trust is an EXECUTION grant only: no provenance is recorded, so
   * CFC's policy-facing identity resolution fails closed for these functions
   * (design §5 — pinned by test/host-pseudo-module.test.ts).
   */
  trustHostValue(
    value: unknown,
    options: UnsafeHostTrustOptions,
  ): void {
    if (
      typeof options.reason !== "string" || options.reason.trim().length === 0
    ) {
      throw new Error("unsafe host trust requires a non-empty reason");
    }
    const functions: HarnessedFunction[] = [];
    this.#collectHostFunctions(value, functions, new Set());
    const fresh = functions.filter((fn) =>
      !this.#hostRegisteredFunctions.has(fn)
    );
    if (fresh.length === 0) return;
    const identity = `host:${this.#nextHostModuleId++}`;
    fresh.forEach((implementation, index) => {
      const symbol = `fn${index}`;
      hardenVerifiedFunction(implementation as (...args: any[]) => unknown);
      this.registerVerifiedImplementation(identity, symbol, implementation);
      // First-write-wins in the entry-ref table keeps a re-trusted function's
      // serialized ref stable; the WeakSet below prevents re-registration
      // under a second identity in the first place.
      setArtifactEntryRef(implementation, { identity, symbol });
      this.#hostRegisteredFunctions.add(implementation);
    });
  }

  #collectHostFunctions(
    value: unknown,
    functions: HarnessedFunction[],
    seen: Set<unknown>,
  ): void {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    const implementation =
      (value as { implementation?: unknown }).implementation;
    if (typeof implementation === "function") {
      functions.push(implementation as HarnessedFunction);
    } else if (typeof value === "function" && !isPattern(value)) {
      // A bare host helper. Pattern FACTORIES are excluded: patterns resolve
      // through the artifact index, not the implementation index, and giving
      // a factory a host entry ref would poison the op-sentinel path
      // (substituteOpPatternRefs would stamp a `$patternRef` the artifact
      // index cannot resolve). Their nodes' module implementations are
      // registered by the walk below.
      functions.push(value as HarnessedFunction);
    }

    for (const child of verifiedWalkChildValues(value as object)) {
      this.#collectHostFunctions(child, functions, seen);
    }
  }
}

/**
 * Yield the child values to recurse into when walking a verified value graph
 * (used by {@link ExecutableRegistry.trustHostValue}'s
 * `#collectHostFunctions`).
 *
 * Data properties — the CommonJS shape (`exports.x = …`) — expose their value
 * directly. SES module-namespace exports are live-binding ACCESSOR properties
 * (`get`/`set`, no `value`). Reading only `descriptor.value` therefore never
 * descends into a module namespace's exports (CT-1623).
 *
 * Reading via [[Get]] is scoped to genuine module namespaces (see
 * {@link isModuleNamespaceObject}), whose getters are spec-defined live bindings
 * with no user-controlled side effects. Getters on ordinary objects are
 * deliberately NOT invoked, preserving the side-effect-free walk over data
 * values.
 */
export function* verifiedWalkChildValues(value: object): Generator<unknown> {
  const isModuleNamespace = isModuleNamespaceObject(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      yield descriptor.value;
    } else if (isModuleNamespace && typeof descriptor.get === "function") {
      try {
        yield (value as Record<PropertyKey, unknown>)[key];
      } catch {
        // A live binding that throws on read carries nothing to register.
      }
    }
  }
}

/**
 * Detect a module-namespace object WITHOUT invoking user code.
 *
 * We must not use `Object.prototype.toString.call(value)` or read
 * `value[Symbol.toStringTag]`: both perform a `[[Get]]` that would invoke a
 * user-defined `@@toStringTag` getter as a side effect on every value walked —
 * exactly the side-effect-free property this traversal is meant to preserve.
 *
 * Instead we match the exact `@@toStringTag` shape of a Module Namespace Exotic
 * Object (ECMAScript 28.3 / 10.4.6): an own, non-writable, non-enumerable,
 * non-configurable DATA property whose value is "Module" (verified: SES
 * namespaces expose precisely this). Reading the own descriptor never invokes a
 * getter, and the strict attribute match keeps the classifier from being
 * tricked by an ordinary object that merely carries a (writable/enumerable/
 * configurable) `@@toStringTag` data property or exposes one via an accessor —
 * so getters on non-namespace objects are never run.
 */
function isModuleNamespaceObject(value: object): boolean {
  const tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
  return tag !== undefined &&
    "value" in tag && tag.value === "Module" &&
    tag.writable === false &&
    tag.enumerable === false &&
    tag.configurable === false;
}
