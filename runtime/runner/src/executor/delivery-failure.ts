import type {
  DeliveryAttention,
  DeliveryDeferral,
  DeliveryFailureClass,
  DeliveryFailurePhase,
} from "@commonfabric/memory/v2";

/** The owner-ratified OW54 exception: cumulative confirmed failed-state time,
 * not operation time or time spent settling after positive recovery evidence. */
export const MAX_EVENT_DELIVERY_FAILURE_BUDGET = 60_000;

const elapsed = (from: number, to: number, ceiling = Number.MAX_SAFE_INTEGER) =>
  Math.min(ceiling, Math.max(0, to - from));

export const spentDeliveryFailureMs = (
  checkpoint: DeliveryDeferral,
  now: number,
  ceiling = Number.MAX_SAFE_INTEGER,
): number =>
  Math.min(
    ceiling,
    checkpoint.accumulatedFailureMs +
      (checkpoint.state === "failed" &&
          checkpoint.activeFailureStartedAt !== undefined
        ? elapsed(checkpoint.activeFailureStartedAt, now, ceiling)
        : 0),
  );

export const sameDeliveryDeferral = (
  left: DeliveryDeferral | undefined,
  right: DeliveryDeferral | undefined,
): boolean =>
  left === right || (left !== undefined && right !== undefined &&
    left.phase === right.phase &&
    left.failureClass === right.failureClass &&
    left.firstFailureAt === right.firstFailureAt &&
    left.lastFailureAt === right.lastFailureAt &&
    left.accumulatedFailureMs === right.accumulatedFailureMs &&
    left.failureCount === right.failureCount &&
    left.activeFailureStartedAt === right.activeFailureStartedAt &&
    left.state === right.state &&
    left.recoveryEpoch === right.recoveryEpoch &&
    left.permanentEvidence === right.permanentEvidence);

export const sameDeliveryAttention = (
  left: DeliveryAttention | undefined,
  right: DeliveryAttention | undefined,
): boolean =>
  left === right || (left !== undefined && right !== undefined &&
    left.phase === right.phase &&
    left.failureClass === right.failureClass &&
    left.code === right.code &&
    left.firstFailureAt === right.firstFailureAt &&
    left.lastFailureAt === right.lastFailureAt &&
    left.accumulatedFailureMs === right.accumulatedFailureMs &&
    left.failureCount === right.failureCount &&
    left.recovery === right.recovery);

export const observeDeliveryRecovery = (
  checkpoint: DeliveryDeferral,
  recoveryEpoch: string,
  now: number,
): DeliveryDeferral => {
  if (
    checkpoint.state !== "failed" || checkpoint.recoveryEpoch === recoveryEpoch
  ) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    accumulatedFailureMs: spentDeliveryFailureMs(checkpoint, now),
    activeFailureStartedAt: undefined,
    state: "recovering",
    recoveryEpoch,
  };
};

export type DeliveryFailureObservation = {
  now: number;
  phase: DeliveryFailurePhase;
  failureClass: DeliveryFailureClass;
  recoveryEpoch?: string;
  permanentEvidence?: boolean;
  budgetMs?: number;
};

export type DeliveryFailureDecision =
  | { kind: "deferred"; checkpoint: DeliveryDeferral }
  | {
    kind: "needs-attention";
    checkpoint: DeliveryDeferral;
    attention: DeliveryAttention;
  };

export const attentionForExpiredDeliveryFailure = (
  checkpoint: DeliveryDeferral,
  now: number,
  budgetMs = MAX_EVENT_DELIVERY_FAILURE_BUDGET,
): DeliveryAttention | undefined => {
  // A positive recovery signal earns exactly one attempt even when it closes
  // an episode at the budget boundary. Only an unchanged active failure may
  // terminalize; a failed recovery attempt re-enters `failed` and is then
  // evaluated by observeDeliveryFailure().
  if (checkpoint.state !== "failed") return undefined;
  const spent = spentDeliveryFailureMs(checkpoint, now, budgetMs);
  if (checkpoint.permanentEvidence !== true && spent < budgetMs) {
    return undefined;
  }
  return {
    phase: checkpoint.phase,
    failureClass: checkpoint.failureClass,
    code: checkpoint.permanentEvidence === true
      ? "permanent-delivery-failure"
      : "delivery-failure-budget-exhausted",
    firstFailureAt: checkpoint.firstFailureAt,
    lastFailureAt: checkpoint.lastFailureAt,
    accumulatedFailureMs: spent,
    failureCount: checkpoint.failureCount,
    recovery: "explicit-retry",
  };
};

export const observeDeliveryFailure = (
  current: DeliveryDeferral | undefined,
  observation: DeliveryFailureObservation,
): DeliveryFailureDecision => {
  const budgetMs = observation.budgetMs ??
    MAX_EVENT_DELIVERY_FAILURE_BUDGET;
  const checkpoint: DeliveryDeferral = current === undefined
    ? {
      phase: observation.phase,
      failureClass: observation.failureClass,
      firstFailureAt: observation.now,
      lastFailureAt: observation.now,
      accumulatedFailureMs: 0,
      failureCount: 1,
      activeFailureStartedAt: observation.now,
      state: "failed",
      ...(observation.recoveryEpoch === undefined
        ? {}
        : { recoveryEpoch: observation.recoveryEpoch }),
      ...(observation.permanentEvidence === true
        ? { permanentEvidence: true as const }
        : {}),
    }
    : {
      ...current,
      phase: current.permanentEvidence === true
        ? current.phase
        : observation.phase,
      failureClass: current.permanentEvidence === true
        ? current.failureClass
        : observation.failureClass,
      lastFailureAt: observation.now,
      failureCount: current.failureCount + 1,
      activeFailureStartedAt: current.state === "failed"
        ? current.activeFailureStartedAt ?? observation.now
        : observation.now,
      state: "failed",
      ...(current.permanentEvidence === true ||
          observation.recoveryEpoch === undefined
        ? {}
        : { recoveryEpoch: observation.recoveryEpoch }),
      ...(current.permanentEvidence === true ||
          observation.permanentEvidence === true
        ? { permanentEvidence: true as const }
        : {}),
    };
  const spent = spentDeliveryFailureMs(
    checkpoint,
    observation.now,
    budgetMs,
  );
  if (checkpoint.permanentEvidence !== true && spent < budgetMs) {
    return { kind: "deferred", checkpoint };
  }
  return {
    kind: "needs-attention",
    checkpoint,
    attention: {
      phase: checkpoint.phase,
      failureClass: checkpoint.failureClass,
      code: checkpoint.permanentEvidence === true
        ? "permanent-delivery-failure"
        : "delivery-failure-budget-exhausted",
      firstFailureAt: checkpoint.firstFailureAt,
      lastFailureAt: checkpoint.lastFailureAt,
      accumulatedFailureMs: spent,
      failureCount: checkpoint.failureCount,
      recovery: "explicit-retry",
    },
  };
};
