import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { encode } from "@commonfabric/utils/encoding";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import type { Runtime } from "../runtime.ts";
import {
  modulePolicySecret,
  readRuntimeSecretIntoFlow,
  type RuntimeSecret,
  runtimeSecretLink,
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

const MODULE_POLICY_MARKER_KEYS = [
  "moduleIdentity",
  "policyDigest",
  "policyRefKind",
  "subject",
  "symbol",
  "type",
];

/**
 * A compiled `PolicyOf` marker: a module-policy reference whose subject is
 * the placeholder commit preparation binds to the owning space.
 */
type ModulePolicyMarker = {
  readonly type: typeof CFC_ATOM_TYPE.Policy;
  readonly policyRefKind: "module";
  readonly moduleIdentity: string;
  readonly symbol: string;
  readonly policyDigest: string;
  readonly subject: { readonly __ctOwningSpace: true };
};

/**
 * Returns the module policy a `policySecretHash` result schema names, the one
 * compiled marker in the one clause of a string's confidentiality, as a plain
 * value of its own.
 *
 * @throws Error when `schema` is anything else.
 */
const policyMarkerOf = (schema: unknown): ModulePolicyMarker => {
  const ifc = isObjectNotArray(schema) && schema.type === "string"
    ? schema.ifc
    : undefined;
  const confidentiality = isObjectNotArray(ifc)
    ? ifc.confidentiality
    : undefined;
  const marker = Array.isArray(confidentiality) &&
      confidentiality.length === 1
    ? confidentiality[0]
    : undefined;
  if (
    !isObjectNotArray(marker) ||
    Object.keys(marker).sort().join() !== MODULE_POLICY_MARKER_KEYS.join() ||
    marker.type !== CFC_ATOM_TYPE.Policy ||
    marker.policyRefKind !== "module" ||
    typeof marker.moduleIdentity !== "string" ||
    typeof marker.symbol !== "string" ||
    typeof marker.policyDigest !== "string" ||
    !isObjectNotArray(marker.subject) ||
    Object.keys(marker.subject).join() !== "__ctOwningSpace" ||
    marker.subject.__ctOwningSpace !== true
  ) {
    throw new Error(
      "policySecretHash: the type argument must be a string confidential " +
        "to exactly one module policy, " +
        "`Confidential<string, readonly [PolicyOf<typeof rules>]>`",
    );
  }
  return {
    type: CFC_ATOM_TYPE.Policy,
    policyRefKind: "module",
    moduleIdentity: marker.moduleIdentity,
    symbol: marker.symbol,
    policyDigest: marker.policyDigest,
    subject: { __ctOwningSpace: true },
  };
};

/**
 * Returns the hash `policySecretHash` hands out for `input` under `key`, a
 * runtime secret's stored value: the lowercase hex of HMAC-SHA-256 keyed with
 * the key's bytes, over the input's UTF-8 bytes.
 */
export const policySecretHashOf = (key: string, input: string): string =>
  Array.from(
    hmac(sha256, fromBase64url(key), encode(input)),
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

    let key: string | undefined;
    try {
      key = mintsInFlight.get(runtime)?.has(`${space}\n${secret.name}`)
        ? undefined
        : readRuntimeSecretIntoFlow(tx, space, secret.name);
    } catch {
      // The key's stored schema has not reached this replica yet; the sync
      // that settles the key brings it.
      key = undefined;
    }
    if (key === undefined) {
      // Tracked, so the runtime is not idle while the key it waits on and
      // the run that follows are still to come.
      runtime.scheduler.trackBackgroundTask(
        settleKey(runtime, space, secret).then(rerun, (error) => {
          console.error(
            "[policySecretHash] The policy's key could not be obtained.",
            error,
          );
        }),
      );
      return;
    }

    const input = inputs.key("input").get();
    if (input !== undefined && typeof input !== "string") {
      throw new Error("policySecretHash: `input` must be a string");
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
        input === undefined ? undefined : policySecretHashOf(key, input),
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
