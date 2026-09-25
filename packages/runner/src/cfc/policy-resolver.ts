import type { CfcModulePolicyRefAtom } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Cancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcModulePolicyResolver } from "./exchange-eval.ts";
import {
  cfcPolicyManifestDocId,
  isExactModulePolicyRef,
  type PolicyArtifactManifestV1,
} from "./policy.ts";

export type CfcModulePolicyLoader = (
  reference: CfcModulePolicyRefAtom,
) => unknown;

/**
 * Wraps a durable manifest loader with the prepared-digest consultation
 * discipline. Present and absent exact-reference lookups are both recorded;
 * validation remains in the pure exchange evaluator.
 */
export const createTxCfcModulePolicyResolver = (
  tx: IExtendedStorageTransaction,
  load: CfcModulePolicyLoader,
): CfcModulePolicyResolver =>
(reference) => {
  let resolved: unknown;
  try {
    resolved = load(reference);
  } catch (error) {
    tx.recordCfcConsultedPolicyManifest({ reference, state: "absent" });
    throw error;
  }
  tx.recordCfcConsultedPolicyManifest({
    reference,
    state: resolved === undefined || resolved === null ? "absent" : "present",
  });
  return resolved;
};

/**
 * The manifest lookup for a boundary that reads a label without committing,
 * such as the display boundary: the verified manifest `reference` selects,
 * read from one of `spaces`, the spaces whose documents carried the label.
 */
export type RenderModulePolicyResolver = (
  reference: CfcModulePolicyRefAtom,
  spaces: readonly string[],
) => unknown;

/**
 * The module-manifest lookup for the display boundary, with a change feed for
 * the documents it reads.
 */
export interface CfcModulePolicySource {
  /**
   * The verified manifest `reference` selects, read from the first of
   * `spaces` that holds one, or `undefined` (the label then stays sealed).
   * Synchronous: it reads the local replica, and a document not yet synced
   * resolves nothing while its load is kicked off.
   */
  readonly resolve: RenderModulePolicyResolver;

  /**
   * Calls `onChange` when the manifest document `reference` selects in
   * `space` later syncs or changes, never at subscribe time. A manifest that
   * already verifies there has nothing left to wait for, and its
   * subscription is inert. Returns a cancel.
   */
  subscribe(
    reference: CfcModulePolicyRefAtom,
    space: string,
    onChange: () => void,
  ): Cancel;
}

/** How many verified manifests a {@link CfcModulePolicySource} keeps. */
export const DEFAULT_MODULE_POLICY_CACHE_CAPACITY = 128;

const noopCancel: Cancel = () => {};

/**
 * A runtime-backed {@link CfcModulePolicySource}. It reads the manifest
 * document at the reference's digest in a space that carried the label: spec
 * §4.4.1 has every transaction that persists a module-policy reference hold or
 * install the byte-verified manifest in that same space, so evaluation reads
 * the label's local digest-addressed store and never the producer's. The read
 * goes through the runtime's own verification, which the commit boundary also
 * uses: the stored envelope must validate, its digest must recompute, and its
 * module identity and symbol must match the reference. Anything else resolves
 * nothing. Because the digest covers the whole manifest, where it was read
 * from cannot change which rules it carries, and the subject, committed or
 * not, plays no part in finding it.
 *
 * This is not `Runtime.hasCfcPolicyManifest`. The runtime's per-space
 * manifest record gains a space when a transaction installs a manifest
 * there, before that transaction commits, so it answers "this space holds or
 * is about to hold it" — the question the commit gate asks. The display
 * boundary needs a manifest read and verified from the local replica
 * (§4.4.1), and this source keeps only those.
 *
 * The display boundary resolves a label every time a cell renders, so a
 * verified manifest is kept, keyed by space and digest, and a later lookup of
 * it reads no document. A kept entry cannot go stale, for the same reason the
 * read location is irrelevant to which rules apply. A lookup that found
 * nothing is not kept, since the document may still arrive, so each render
 * of a label whose manifest has not verified reads the replica again (a
 * cheap local read that kicks off the document's load). The cache holds the
 * `capacity` most recently used entries.
 */
export const createRuntimeCfcModulePolicySource = (
  runtime: Pick<
    Runtime,
    "readTx" | "resolveCfcPolicyManifest" | "getCellFromEntityId"
  >,
  capacity: number = DEFAULT_MODULE_POLICY_CACHE_CAPACITY,
): CfcModulePolicySource => {
  const verified = new Map<string, PolicyArtifactManifestV1>();
  const keyOf = (space: string, policyDigest: string) =>
    JSON.stringify([space, policyDigest]);
  const resolveIn = (
    reference: CfcModulePolicyRefAtom,
    space: string,
  ): PolicyArtifactManifestV1 | undefined => {
    if (!isExactModulePolicyRef(reference) || space.length === 0) {
      return undefined;
    }
    const key = keyOf(space, reference.policyDigest);
    const kept = verified.get(key);
    if (kept !== undefined) {
      verified.delete(key);
      verified.set(key, kept);
      return kept.manifest.moduleIdentity === reference.moduleIdentity &&
          kept.manifest.symbol === reference.symbol
        ? kept
        : undefined;
    }
    const tx = runtime.readTx();
    let artifact: PolicyArtifactManifestV1 | undefined;
    try {
      artifact = runtime.resolveCfcPolicyManifest(
        reference,
        tx,
        space as MemorySpace,
        false,
      );
    } finally {
      tx.clearReadOnly?.();
      tx.abort("module policy manifest lookup complete");
    }
    if (artifact !== undefined) {
      verified.set(key, artifact);
      if (verified.size > capacity) {
        verified.delete(verified.keys().next().value!);
      }
    }
    return artifact;
  };
  return {
    resolve(reference, spaces) {
      for (const space of spaces) {
        const artifact = resolveIn(reference, space);
        if (artifact !== undefined) return artifact;
      }
      return undefined;
    },
    subscribe(reference, space, onChange) {
      // A manifest that verifies now, from the cache or the replica, has
      // nothing left to wait for; a reference or space nothing can resolve
      // has nothing to wait on.
      if (
        !isExactModulePolicyRef(reference) || space.length === 0 ||
        resolveIn(reference, space) !== undefined
      ) {
        return noopCancel;
      }
      // `Cell.sink` runs its action once synchronously at subscribe time;
      // skip that fire so `onChange` signals change only.
      let primed = false;
      return runtime.getCellFromEntityId(
        space as MemorySpace,
        cfcPolicyManifestDocId(reference.policyDigest),
      ).sink(() => {
        if (!primed) {
          primed = true;
          return;
        }
        onChange();
      });
    },
  };
};
