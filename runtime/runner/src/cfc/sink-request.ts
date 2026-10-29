import type { FabricValue } from "@commonfabric/api";
import { fabricAwareEqual } from "@commonfabric/data-model";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { createFrozenRequestSnapshot } from "./request-snapshot.ts";
import {
  type CfcPrepareState,
  POST_COMMIT_RELEASE_REJECTED,
  type WritePolicyInput,
} from "./types.ts";

type SinkRequestPolicyInput = Extract<
  WritePolicyInput,
  { kind: "sink-request" }
>;
type SinkRequestPolicyState = {
  writePolicyInputs: readonly WritePolicyInput[];
  prepare?: CfcPrepareState;
};

const isSinkRequestPolicyInput = (
  input: WritePolicyInput,
): input is SinkRequestPolicyInput => input.kind === "sink-request";

const preparedSinkRequestInputs = (
  state: SinkRequestPolicyState,
): readonly WritePolicyInput[] =>
  state.prepare?.status === "prepared"
    ? state.prepare.input.writePolicyInputs
    : state.writePolicyInputs;

export function createSinkRequestPolicyInput(
  sink: string,
  effectId: string,
  request: FabricValue,
): SinkRequestPolicyInput {
  return {
    kind: "sink-request",
    effectId,
    sink,
    request: createFrozenRequestSnapshot(request),
  };
}

export function recordSinkRequestPolicyInput(
  tx: Pick<IExtendedStorageTransaction, "recordCfcWritePolicyInput">,
  sink: string,
  effectId: string,
  request: FabricValue,
): void {
  tx.recordCfcWritePolicyInput(
    createSinkRequestPolicyInput(sink, effectId, request),
  );
}

export function verifySinkRequestRelease(
  tx: { getCfcState(): SinkRequestPolicyState },
  sink: string,
  effectId: string,
  request: FabricValue,
  preparedInput?: SinkRequestPolicyInput,
): string | undefined {
  const state = tx.getCfcState();
  const match = state.prepare?.status === "prepared"
    ? preparedSinkRequestInputs(state).find((input) =>
      isSinkRequestPolicyInput(input) &&
      input.sink === sink &&
      input.effectId === effectId
    ) as SinkRequestPolicyInput | undefined
    : preparedInput?.sink === sink && preparedInput.effectId === effectId
    ? preparedInput
    : preparedSinkRequestInputs(state).find((input) =>
      isSinkRequestPolicyInput(input) &&
      input.sink === sink &&
      input.effectId === effectId
    ) as SinkRequestPolicyInput | undefined;

  if (match === undefined) {
    return `missing sink-request policy input for ${sink}`;
  }

  if (!fabricAwareEqual(match.request, request)) {
    return `sink-request policy input mismatch for ${sink}`;
  }

  return undefined;
}

/**
 * Stage a sink request on `tx` and run `flush` once that transaction commits.
 *
 * The work happens after the commit because the request's own state — the
 * pending flag, the request hash a later run recognizes — has to be durable
 * before anything is sent. So the commit failing means the work never starts.
 * Usually that is right: the action runs again, stages the request again, and
 * a later attempt sends it. When the code that owns those attempts stops
 * making them, the caller is left with a request that was staged, never sent,
 * and never answered. `onRejected` is where a caller settles that. It is
 * called once, when the transaction is abandoned, and never on a rejection
 * another attempt still follows — the scheduler decides which is which, since
 * no rejection says so on its own.
 *
 * What it is handed says the request was refused and names the sink, and stops
 * there. A caller records that error where a pattern reads it, and the refusal
 * detail — the document the rule named, the confidentiality atoms that did not
 * fit, and with them the `source` of each caveat, the principal that introduced
 * it — is precisely what the pattern-facing surface withholds (inv-12 / audit
 * 28b, the rule `redactCaveatSourcesForDisplay` applies to label views). It
 * would be a strange bargain to refuse the write and then hand its reason to
 * the writer. The detail travels on `cause` and to the log below, both of which
 * face the operator. A deployment that wants a pattern to read some of the
 * reason declassifies the fields it chooses through an error exchange rule,
 * which names each field and the confidentiality it is released to.
 *
 * A rejected request has no receipt and no partial send. The refusal happens
 * before the transaction reaches storage, which clears the post-commit outbox,
 * so `flush` — and with it the release check below that would mint one — never
 * runs. `onRejected` reports what did not happen; it must not write anything
 * that stands for a completed request.
 */
export function enqueueSinkRequestPostCommitEffect(
  tx: Pick<
    IExtendedStorageTransaction,
    "enqueuePostCommitEffect" | "recordCfcWritePolicyInput"
  >,
  sink: string,
  effectId: string,
  request: FabricValue,
  kind: string,
  flush: (tx: IExtendedStorageTransaction) => void | Promise<void>,
  options?: {
    /** Dedupe/outbox key override. The effectful builtins pass their
     * PER-TARGET key (executor/effect-completion.ts `effectTargetKey`:
     * `<effectId>@<result-cell id>`) so two DISTINCT nodes issuing
     * byte-identical inputs each keep their own effect — colliding on
     * the bare effectId dropped the second node's closure and wedged
     * its cells pending forever (the stage-G round-2 headline). The
     * CFC policy-input `effectId` stays unscoped either way. */
    idempotencyKey?: string;

    /** Called once, with an error naming the refusal, when the transaction
     * staging this request is abandoned — no further attempt at it is
     * coming, so the request will never be sent. */
    onRejected?: (error: Error) => void;

    /** Releases local ownership when a post-commit release check skips work. */
    onReleaseRejected?: () => void;
  },
): void {
  const policyInput = createSinkRequestPolicyInput(sink, effectId, request);
  tx.recordCfcWritePolicyInput(policyInput);
  const onRejected = options?.onRejected;
  tx.enqueuePostCommitEffect({
    id: effectId,
    idempotencyKey: options?.idempotencyKey ?? effectId,
    // Each transaction keeps one effect per key, including this callback.
    // The serving outbox retains accepted attachments' release checks until
    // one dispatches; this callback belongs only to transaction abandonment.
    abandon: onRejected === undefined ? undefined : (error) => {
      console.error(
        `[cfc] ${kind} was abandoned before it started; the request is not ` +
          `sent.`,
        { sink, effectId, rejection: (error as { message?: string })?.message },
      );
      onRejected(
        new Error(`${sink} request was refused before it started`, {
          cause: error,
        }),
      );
    },
    kind,
    flush: (committedTx) => {
      const reason = verifySinkRequestRelease(
        committedTx as { getCfcState(): SinkRequestPolicyState },
        sink,
        effectId,
        request,
        policyInput,
      );
      if (reason !== undefined) {
        // Fail closed: the effect is not sent. Surface the reject to the
        // transaction (CFC stats + diagnostics) rather than only console.warn,
        // so a systematically failing release check is observable (audit W3.23).
        const noteable = committedTx as {
          noteCfcSinkReleaseReject?: (
            info: { sink: string; effectId: string; detail: string },
          ) => void;
        };
        if (typeof noteable.noteCfcSinkReleaseReject === "function") {
          noteable.noteCfcSinkReleaseReject({ sink, effectId, detail: reason });
        } else {
          console.warn("[CFC sink-request]", {
            ruleId: "sink-request-release",
            sink,
            effectId,
            detail: reason,
          });
        }
        options?.onReleaseRejected?.();
        return POST_COMMIT_RELEASE_REJECTED;
      }
      return flush(committedTx as IExtendedStorageTransaction);
    },
  });
}
