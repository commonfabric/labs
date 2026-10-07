/**
 * The `policySecretHash` builtin: keyed hashes under a module policy's key, a
 * runtime secret minted once per space and policy that no code reads, handed
 * to pattern code in the policy's custody so that only the policy's exchange
 * rules release anything computed from them. docs/specs/cfc-policy-secret.md
 * is the design, and says what it protects and what it does not.
 */

import { hmacSha256 } from "@commonfabric/content-hash";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { encode } from "@commonfabric/utils/encoding";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import {
  type CfcModulePolicyMarker,
  isExactModulePolicyMarker,
  OWNING_SPACE_PLACEHOLDER,
} from "../cfc/policy.ts";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { Runtime } from "../runtime.ts";
import {
  modulePolicySecret,
  readRuntimeSecretIntoFlow,
  type RuntimeSecret,
  runtimeSecretLink,
  RuntimeSecretUnresolvedError,
  watchRuntimeSecret,
} from "../runtime-secret.ts";
import type { Action } from "../scheduler.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * The builtin identity a policy secret hash is written under, which the
 * `TransformedBy` stamped on it names.
 */
export const POLICY_SECRET_HASH_WRITER = "policySecretHash";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string" },
    schema: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

/**
 * Returns the module policy a `policySecretHash` result schema names, the one
 * compiled marker in the one clause of a string's confidentiality, as a plain
 * value of its own.
 *
 * @throws Error when `schema` is anything else.
 */
const policyMarkerOf = (schema: unknown): CfcModulePolicyMarker => {
  const ifc = isObjectNotArray(schema) && schema.type === "string"
    ? schema.ifc
    : undefined;
  const confidentiality = isObjectNotArray(ifc)
    ? ifc.confidentiality
    : undefined;
  const marker = Array.isArray(confidentiality) &&
      confidentiality.length === 1
    ? snapshotQueryResult(confidentiality[0])
    : undefined;
  if (!isExactModulePolicyMarker(marker)) {
    throw new Error(
      "policySecretHash: the type argument must be a string confidential " +
        "to exactly one module policy, " +
        "`Confidential<string, readonly [PolicyOf<typeof rules>]>`",
    );
  }
  return {
    type: marker.type,
    policyRefKind: marker.policyRefKind,
    moduleIdentity: marker.moduleIdentity,
    symbol: marker.symbol,
    policyDigest: marker.policyDigest,
    subject: { [OWNING_SPACE_PLACEHOLDER]: true },
  };
};

/**
 * Returns the hash `policySecretHash` hands out for `input` under `key`, a
 * runtime secret's stored value: the lowercase hex of HMAC-SHA-256 keyed with
 * the key's bytes, over the input's UTF-8 bytes.
 */
export const policySecretHashOf = (key: string, input: string): string =>
  Array.from(
    hmacSha256(fromBase64url(key), encode(input)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * The mints in flight on each runtime, by space and secret name. Every
 * instance of the builtin that needs a key while its mint is in flight waits
 * for that mint, so none computes from a draw a concurrent mint elsewhere may
 * still reject.
 */
const mintsInFlight = new WeakMap<Runtime, Map<string, Promise<void>>>();

/**
 * Helper for {@link policySecretHash}, which obtains the key `secret` in
 * `space`: it syncs the key's document, which brings the schema document its
 * metadata names, and mints the key in a transaction of its own when no
 * trusted one is stored. Resolves once that transaction has settled.
 */
const settleKey = (
  runtime: Runtime,
  space: MemorySpace,
  secret: RuntimeSecret,
): Promise<void> => {
  let mints = mintsInFlight.get(runtime);
  if (mints === undefined) {
    mints = new Map();
    mintsInFlight.set(runtime, mints);
  }
  const key = `${space}\n${secret.name}`;
  const inFlight = mints.get(key);
  if (inFlight !== undefined) return inFlight;
  const mint = (async () => {
    await runtime.getCellFromLink(runtimeSecretLink(space, secret.name))
      .sync();
    const { error } = await runtime.editWithRetry((tx) =>
      tx.ensureRuntimeSecret(space, secret, runtimeWritePolicyAuthorization)
    );
    if (error !== undefined) throw new Error(error.message, { cause: error });
  })().finally(() => mints.delete(key));
  mints.set(key, mint);
  return mint;
};

/**
 * `policySecretHash<T>({ input })`: the keyed hash of the string `input` under
 * the key of the module policy `T` names, so that only the policy's exchange
 * rules release anything computed from it (docs/specs/cfc-policy-secret.md).
 *
 * The key is a runtime secret (`runtime-secret.ts`) stored under the policy's
 * clause, and nothing but this builtin reads it. The builtin reads the key and
 * the input with ordinary reads and writes the hash as its result under its
 * own identity, so the result carries what the flow of that transaction
 * carries: the policy's clause, the input's labels, and
 * `TransformedBy{builtin policySecretHash}`. The result is unset until the key
 * is available and while the input is, and the builtin writes nothing unless
 * the runtime enforces CFC and persists flow labels.
 */
export function policySecretHash(
  inputsCell: Cell<{ input?: string; schema?: unknown }>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
  _cause: unknown,
  parentCell: Cell<unknown>,
  runtime: Runtime,
): { action: Action; onActionRegistered: (action: Action) => void } {
  let cancelled = false;
  addCancel(() => {
    cancelled = true;
  });
  let registeredAction: Action | undefined;
  const rerun = (): void => {
    if (!cancelled && registeredAction !== undefined) {
      runtime.scheduler.invalidateAction(registeredAction);
    }
  };

  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (
      cfcEnforcementStrictness(runtime.cfcEnforcementMode) <
        CFC_ENFORCING_STRICTNESS || runtime.cfcFlowLabels !== "persist"
    ) {
      throw new Error(
        "policySecretHash: requires a runtime that enforces CFC and persists " +
          "flow labels",
      );
    }
    const inputs = inputsCell.withTx(tx);
    const marker = policyMarkerOf(
      inputs.asSchema(INPUT_SCHEMA).key("schema").get(),
    );
    const space = parentCell.space;
    const secret = modulePolicySecret(marker);

    const input = inputs.key("input").get();
    if (input !== undefined && typeof input !== "string") {
      throw new Error("policySecretHash: `input` must be a string");
    }

    let key: string | undefined;
    if (mintsInFlight.get(runtime)?.has(`${space}\n${secret.name}`)) {
      watchRuntimeSecret(tx, space, secret);
    } else {
      try {
        key = readRuntimeSecretIntoFlow(tx, space, secret);
      } catch (error) {
        // The key's stored schema has not reached this replica yet; the sync
        // that settles the key brings it.
        if (!(error instanceof RuntimeSecretUnresolvedError)) throw error;
      }
    }
    if (key === undefined) {
      // Tracked, so the runtime is not idle while the key it waits on and
      // the run that follows are still to come. A settle that fails leaves
      // the run waiting on the key's document, which runs it again once a
      // key is stored there.
      runtime.scheduler.trackBackgroundTask(
        settleKey(runtime, space, secret).then(rerun, (error) => {
          console.error(
            "[policySecretHash] The policy's key could not be obtained.",
            error,
          );
        }),
      );
    }
    // The scheduler runs the action under no identity of its own, so the
    // write is attributed here, which is what stamps the hash as the
    // builtin's.
    const prior = tx.getCfcState().implementationIdentity;
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: POLICY_SECRET_HASH_WRITER,
    });
    try {
      sendResult(
        tx,
        key === undefined || input === undefined
          ? undefined
          : policySecretHashOf(key, input),
      );
    } finally {
      setCfcImplementationIdentity(tx, prior);
    }
  };

  return {
    action,
    onActionRegistered: (registered) => {
      registeredAction = registered;
    },
  };
}
