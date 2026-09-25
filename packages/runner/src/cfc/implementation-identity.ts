import type { CfcTransformedByAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";

import type { Module } from "../builder/types.ts";
import type { HarnessedFunction } from "../harness/types.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import type { ImplementationIdentity } from "./types.ts";
import { normalizeIdentitySource } from "./writer-claim-correspondence.ts";

const BUILTIN_ARTIFACT_FORMAT = "commonfabric/cfc/builtin-registry/v1";

type TransformedByOperation = Pick<
  CfcTransformedByAtom,
  "codeHash" | "operation"
>;

/**
 * Content identity for a versioned builtin-registry entry. The entry is an
 * artifact description rather than executable source, so its digest is stable
 * across bundling and minification.
 */
export const builtinArtifactCodeHash = (builtinId: string): string =>
  // This registry artifact covers the builtin id, not implementation bytes.
  hashStringOf({ format: BUILTIN_ARTIFACT_FORMAT, operation: builtinId });

/**
 * Converts an internal writer identity into the exact public operation
 * identity carried by `TransformedBy`.
 */
export const transformedByOperation = (
  identity: ImplementationIdentity | undefined,
): TransformedByOperation | undefined => {
  if (identity?.kind === "builtin") {
    return {
      codeHash: builtinArtifactCodeHash(identity.builtinId),
      operation: identity.builtinId,
    };
  }
  if (identity?.kind !== "verified" || identity.moduleIdentity === undefined) {
    return undefined;
  }
  const operation = identity.symbol ?? identity.bindingPath?.join(".");
  return {
    codeHash: identity.moduleIdentity,
    ...(operation === undefined ? {} : { operation }),
  };
};

/**
 * Resolve the policy-facing implementation identity for a module invocation.
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
  const debugName = (module as { debugName?: string }).debugName;
  if (typeof debugName !== "string" || debugName.length === 0) {
    return resolveProvenanceImplementationIdentity(options.implementation);
  }

  return {
    kind: "builtin",
    builtinId: debugName,
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
  };
};
