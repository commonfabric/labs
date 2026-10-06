import { hashOf } from "@commonfabric/data-model";

import type { Module } from "../builder/types.ts";
import type { HarnessedFunction } from "../harness/types.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import { registeredBuiltinRef } from "../module.ts";
import type { ImplementationIdentity } from "./types.ts";
import { normalizeIdentitySource } from "./writer-claim-correspondence.ts";

/**
 * Resolve the policy-facing implementation identity for a module invocation.
 *
 * `kind: "builtin"` is proven EXCLUSIVELY by registry membership: the module
 * object is one a `ModuleRegistry` handed out (`registeredBuiltinRef` in
 * module.ts). A builtin identity is read as proof of which builtin wrote a
 * value by:
 *   - the custody seal's `TransformedBy` witness (cfc/custody-seal.ts);
 *   - reviewed snapshot copies (cfc/share-snapshot.ts);
 *   - the builtin-name arm of `writeAuthorizedBy` (cfc/prepare.ts);
 *   - `gateRuntimeMintedIntegrity`, under which a builtin's writes keep
 *     runtime-minted atoms (cfc/prepare.ts).
 * So it never comes from a member the module carries. A module that arrives
 * as data — a stored graph or an op pattern's plain graph run as-is, whose
 * module may carry any `debugName` — resolves as what it is: verified when its
 * function has provenance, otherwise nothing.
 *
 * `kind: "verified"` is proven EXCLUSIVELY by the function object's
 * content-addressed provenance (harness/verified-provenance.ts): an entry
 * exists only for a function registered during a verified evaluation, so the
 * WeakMap lookup itself is the anti-spoof check — an attacker-supplied
 * function (even with byte-identical source text) has no entry and resolves
 * to nothing. The former `implementationRef` × `verifiedLoadId` registry arm
 * is gone (PR E2): every function the legacy registry could admit is an
 * evaluation product and therefore carries provenance, so the arm had no
 * reachable case the provenance path does not cover.
 */
export const resolvePolicyFacingImplementationIdentity = (
  module: Module,
  options: {
    implementation?: HarnessedFunction;
  } = {},
): ImplementationIdentity | undefined => {
  const builtinId = registeredBuiltinRef(module);
  if (builtinId === undefined) {
    return resolveProvenanceImplementationIdentity(options.implementation);
  }

  return {
    kind: "builtin",
    builtinId,
  };
};

export const resolveBuiltinImplementationIdentity = (
  module: Module,
): ImplementationIdentity | undefined =>
  resolvePolicyFacingImplementationIdentity(module);

/**
 * Resolve `kind: "verified"` from the function object's content-addressed
 * provenance. Returns undefined when the function has no provenance —
 * fail-closed: no identity, no authorized write.
 *
 * The provenance yields the content-addressed `moduleIdentity` — the sole
 * `writeAuthorizedBy` verification arm (prepare.ts). The legacy bundleId arm,
 * and the raw `verifiedLoadId` arm before it, retired with the legacy read
 * path (identity E5): a load id embedded a session counter, so such claims
 * could never verify across sessions anyway, and claims written since #4009
 * carry `moduleIdentity`.
 */
const resolveProvenanceImplementationIdentity = (
  implementation: HarnessedFunction | undefined,
): ImplementationIdentity | undefined => {
  if (typeof implementation !== "function") return undefined;
  const provenance = getVerifiedProvenance(implementation);
  if (!provenance) return undefined;

  // `.src` (the debug source location) is NO LONGER consulted for identity: the
  // WeakMap provenance lookup above IS the anti-spoof proof (an attacker-supplied
  // function has no entry), and the policy-facing identity fields are provenance-
  // derived, never `.src`-derived. `writeAuthorizedBy` verifies the direct or
  // delegated `moduleIdentity` plus the exact `bindingPath`; `sourceFile` remains
  // diagnostic at verification time and participates only when claims are minted
  // or reconciled. The former `identityFromCanonicalSource(.src)
  // === provenance.identity` consistency check was defense-in-depth, not the
  // security boundary; it is dropped so that making `.src` lazy/debug-only
  // (skipped at boot) cannot flip a genuinely-verified implementation to
  // `unsupported` and deny its authorized writes. `.src` garble/absence is now
  // identity-inert (the `src-garble-identity-invariant` harness asserts this).
  return {
    kind: "verified",
    moduleIdentity: provenance.identity,
    ...(provenance.symbol ? { symbol: provenance.symbol } : {}),
    ...(provenance.bindingIdentity
      ? {
        sourceFile: normalizeIdentitySource(
          provenance.bindingIdentity.sourceFile,
        )!,
        bindingPath: [...provenance.bindingIdentity.bindingPath],
      }
      : {}),
    ...(provenance.bindingIdentity ? {} : {
      codeHash: hashOf(Function.prototype.toString.call(implementation))
        .toString(),
    }),
  };
};
