import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  observeDeliveryFailure,
  observeDeliveryRecovery,
  spentDeliveryFailureMs,
} from "../src/executor/delivery-failure.ts";
import {
  ReplicaLoadFailureError,
  toReplicaLoadFailureError,
} from "../src/storage/interface.ts";

describe("served-event delivery failure policy", () => {
  it("accumulates failed episodes across recovery without charging recovery work", () => {
    const first = observeDeliveryFailure(undefined, {
      now: 1_000,
      phase: "dispatch-load",
      failureClass: "session-revoked",
      recoveryEpoch: "session:1",
    });
    expect(first.kind).toBe("deferred");
    if (first.kind !== "deferred") throw new Error("expected deferral");
    expect(spentDeliveryFailureMs(first.checkpoint, 21_000)).toBe(20_000);

    const recovering = observeDeliveryRecovery(
      first.checkpoint,
      "session:2",
      21_000,
    );
    expect(recovering).toEqual({
      ...first.checkpoint,
      accumulatedFailureMs: 20_000,
      activeFailureStartedAt: undefined,
      state: "recovering",
      recoveryEpoch: "session:2",
    });
    expect(spentDeliveryFailureMs(recovering, 51_000)).toBe(20_000);
    expect(observeDeliveryRecovery(recovering, "session:3", 31_000)).toBe(
      recovering,
    );
    expect(observeDeliveryRecovery(first.checkpoint, "session:1", 31_000))
      .toBe(first.checkpoint);

    const repeated = observeDeliveryFailure(recovering, {
      now: 51_000,
      phase: "dispatch-load",
      failureClass: "connection",
      recoveryEpoch: "session:2",
    });
    expect(repeated.kind).toBe("deferred");
    if (repeated.kind !== "deferred") throw new Error("expected deferral");
    expect(repeated.checkpoint.accumulatedFailureMs).toBe(20_000);
    expect(repeated.checkpoint.activeFailureStartedAt).toBe(51_000);
    expect(repeated.checkpoint.failureCount).toBe(2);

    const exhausted = observeDeliveryFailure(repeated.checkpoint, {
      now: 91_000,
      phase: "dispatch-load",
      failureClass: "connection",
      recoveryEpoch: "session:2",
      budgetMs: 60_000,
    });
    expect(exhausted.kind).toBe("needs-attention");
    if (exhausted.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(exhausted.attention.accumulatedFailureMs).toBe(60_000);
    expect(exhausted.attention.failureCount).toBe(3);
    expect(exhausted.attention.code).toBe(
      "delivery-failure-budget-exhausted",
    );
  });

  it("clamps negative elapsed time and caps a forward jump at the budget", () => {
    const first = observeDeliveryFailure(undefined, {
      now: 10_000,
      phase: "commit-preparation",
      failureClass: "unknown",
      recoveryEpoch: "runtime:1",
    });
    if (first.kind !== "deferred") throw new Error("expected deferral");
    expect(spentDeliveryFailureMs(first.checkpoint, 9_000)).toBe(0);

    const jumped = observeDeliveryFailure(first.checkpoint, {
      now: Number.MAX_SAFE_INTEGER,
      phase: "commit-preparation",
      failureClass: "unknown",
      recoveryEpoch: "runtime:1",
      budgetMs: 60_000,
    });
    expect(jumped.kind).toBe("needs-attention");
    if (jumped.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(jumped.attention.accumulatedFailureMs).toBe(60_000);
  });

  it("terminalizes only positively evidenced permanent verdicts immediately", () => {
    const ambiguous = observeDeliveryFailure(undefined, {
      now: 1,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
    });
    expect(ambiguous.kind).toBe("deferred");

    const permanent = observeDeliveryFailure(undefined, {
      now: 1,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
      permanentEvidence: true,
    });
    expect(permanent.kind).toBe("needs-attention");
    if (permanent.kind !== "needs-attention") {
      throw new Error("expected terminal cover");
    }
    expect(permanent.attention.code).toBe("permanent-delivery-failure");

    const persisted = observeDeliveryFailure(permanent.checkpoint, {
      now: 2,
      phase: "dispatch-load",
      failureClass: "authorization",
      recoveryEpoch: "acl:1",
    });
    expect(persisted.kind).toBe("needs-attention");
    if (persisted.kind !== "needs-attention") {
      throw new Error("expected persisted permanent terminal cover");
    }
    expect(persisted.attention.code).toBe("permanent-delivery-failure");
    expect(persisted.attention.phase).toBe("dispatch-load");
    expect(persisted.attention.failureClass).toBe("authorization");

    const changed = observeDeliveryFailure(permanent.checkpoint, {
      now: 3,
      phase: "commit-finalization",
      failureClass: "connection",
      recoveryEpoch: "connection:1",
    });
    expect(changed.kind).toBe("needs-attention");
    if (changed.kind !== "needs-attention") {
      throw new Error("expected persisted permanent terminal cover");
    }
    expect(changed.attention.phase).toBe("dispatch-load");
    expect(changed.attention.failureClass).toBe("authorization");
    expect(changed.checkpoint.recoveryEpoch).toBe("acl:1");
  });

  it("accepts current-ACL evidence from the load producer, never from its name alone", () => {
    const existing = new ReplicaLoadFailureError({
      failureClass: "connection",
      recoveryEpoch: "load:existing",
      permanentEvidence: false,
    }, new Error("already classified"));
    expect(toReplicaLoadFailureError(existing, "load:replacement")).toBe(
      existing,
    );

    expect(
      toReplicaLoadFailureError({
        name: "AuthorizationError",
        message: "ambiguous denial",
      }, "load:1").failure,
    ).toEqual({
      failureClass: "authorization",
      recoveryEpoch: "load:1",
      permanentEvidence: false,
    });

    expect(
      toReplicaLoadFailureError({
        name: "Error",
        message: "memory session revoked: diagnostic text only",
      }, "load:typed-only").failure.failureClass,
    ).toBe("unknown");

    expect(
      toReplicaLoadFailureError({
        name: "AuthorizationError",
        message: "current ACL denied the load",
        permanentEvidence: true,
        aclRevision: 42,
      }, "load:2").failure,
    ).toEqual({
      failureClass: "authorization",
      recoveryEpoch: "acl:42",
      permanentEvidence: true,
    });
  });

  it("returns permanent protocol evidence for a foreign scoped read refusal by its type, never by its message", () => {
    expect(
      toReplicaLoadFailureError({
        name: "ForeignScopedReadRefusedError",
        message: "foreign scoped read refused on the serving path",
      }, "load:3").failure,
    ).toEqual({
      failureClass: "protocol",
      recoveryEpoch: "load:3",
      permanentEvidence: true,
    });

    expect(
      toReplicaLoadFailureError({
        name: "ConnectionError",
        message: "foreign scoped read refused on the serving path",
      }, "load:4").failure,
    ).toEqual({
      failureClass: "connection",
      recoveryEpoch: "load:4",
      permanentEvidence: false,
    });
  });
});
