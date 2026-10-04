/**
 * `Runtime.editWithRetry` retries on an ALLOW-LIST of rejection classes, not on
 * the truthiness of the commit error.
 *
 * Before this, every commit rejection was retried: a deterministic refusal —
 * an ACL `ProtocolError` about operation shape, an `AuthorizationError`, a
 * `PreconditionFailedError` whose own interface doc says "this class is
 * PERMANENT: the client must not retry" — burned the whole budget on identical
 * doomed round-trips, each one emitting a subscriber revert notification from
 * `finalizeRejection`. With the default budget that is 6 attempts; callers size
 * budgets larger (pattern-manager: `Math.max(16, 2 * importEdges + 8)`).
 *
 * These tests therefore assert the COMMIT COUNT, not just the outcome. A
 * classification that got the right final error after five doomed attempts
 * would pass an outcome-only assertion and fail here. The counterpart —
 * a genuine `ConflictError` still exhausting its budget — is asserted here and
 * in compile-cache-writeback-conflict.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  type Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { CFC_GRANT_ID_PREFIX } from "../src/cfc/grants.ts";
import { DEFAULT_MAX_RETRIES, Runtime } from "../src/runtime.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { FabricValue } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("edit-with-retry classification");

/**
 * Drive `editWithRetry` against a stubbed commit that always rejects with
 * `rejection`, and report how many commits it took. Stubbing `edit()` and
 * `prepareTxForCommit` is the idiom from compile-cache-writeback-conflict.test.ts:
 * it isolates the classification decision from every other moving part.
 */
const commitsFor = async (
  rejection: Record<string, unknown>,
  options: { maxRetries?: number; succeedOnAttempt?: number } = {},
): Promise<{ commits: number; error?: { name?: string }; ok?: unknown }> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  let commits = 0;
  const fakeTx = () => ({
    tx: {},
    abort: () => {},
    commit: () => {
      commits++;
      if (
        options.succeedOnAttempt !== undefined &&
        commits >= options.succeedOnAttempt
      ) {
        return Promise.resolve({});
      }
      return Promise.resolve({ error: rejection });
    },
  });
  // deno-lint-ignore no-explicit-any
  (runtime as any).edit = () => fakeTx();
  // deno-lint-ignore no-explicit-any
  (runtime as any).prepareTxForCommit = () => {};
  try {
    const result = options.maxRetries === undefined
      ? await runtime.editWithRetry(() => "done")
      : await runtime.editWithRetry(() => "done", options.maxRetries);
    return {
      commits,
      error: result.error as { name?: string } | undefined,
      ok: result.ok,
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("editWithRetry rejection classification", () => {
  // Each of these is a deterministic refusal of the committed data: re-running
  // the identical function recomputes the identical refused write.
  const terminal: Array<[string, Record<string, unknown>]> = [
    // The ACL-mutation shape refusal (memory/v2/server.ts `#validateAclCommit`).
    ["ProtocolError", {
      name: "ProtocolError",
      message: "ACL mutations must replace the space-scoped ACL document",
    }],
    // A denial the server did NOT mark retriable.
    ["AuthorizationError", {
      name: "AuthorizationError",
      message: "Space did:key:z6Mk requires an ACL genesis commit",
    }],
    // storage/interface.ts: "this class is PERMANENT: the client must not retry".
    ["PreconditionFailedError", {
      name: "PreconditionFailedError",
      message: "origin never committed",
      precondition: "origin-committed",
    }],
    // A commit-time row-label rule violation (`isTerminalRejection`).
    ["RowLabelCommitError", {
      name: "RowLabelCommitError",
      message: "row label rule refused the commit",
    }],
    // The server's catch-all for an internal failure.
    ["TransactionError", {
      name: "TransactionError",
      message: "internal server failure",
    }],
    // Terminal for a different reason than the rest of this list: not the data,
    // the retry path. A commit routed to a session the server no longer knows
    // was never evaluated — the same shape as a ConnectionError — but nothing
    // between two attempts remounts the session, so every attempt reuses the
    // handle the server just refused. See the SpaceReplica test at the bottom
    // of this file, which pins that no-remount fact end to end.
    ["SessionError", {
      name: "SessionError",
      message: "Unknown session for space",
    }],
    // A malformed store operation.
    ["StoreError", { name: "StoreError", message: "malformed operation" }],
    // The client-side sibling of RowLabelCommitError: the CFC boundary
    // evaluated the transaction's own reads and writes and refused them
    // before storage saw the commit. Deterministic in exactly the same way,
    // so a re-run recomputes the identical refused write.
    ["CfcCommitRefusalError", {
      name: "CfcCommitRefusalError",
      message: "CFC enforcement rejected commit: writer-fit misfit",
      reasons: ["writer-fit misfit"],
    }],
  ];

  for (const [name, rejection] of terminal) {
    it(`commits exactly once for a ${name}`, async () => {
      const { commits, error } = await commitsFor(rejection);
      expect(commits).toBe(1);
      expect(error?.name).toBe(name);
    });
  }

  it("ignores a large explicit budget for a terminal rejection", async () => {
    // pattern-manager sizes its budget at Math.max(16, 2 * importEdges + 8);
    // a deterministic rejection there used to burn 56+ round-trips.
    const { commits, error } = await commitsFor(
      { name: "ProtocolError", message: "refused" },
      { maxRetries: 32 },
    );
    expect(commits).toBe(1);
    expect(error?.name).toBe("ProtocolError");
  });

  it("does not await readyToRetry for a terminal rejection", async () => {
    // The catch-up gate belongs to the conflict protocol. Awaiting it for a
    // rejection we are not going to retry would be pure latency.
    let gated = 0;
    const { commits } = await commitsFor({
      name: "ProtocolError",
      message: "refused",
      readyToRetry: () => {
        gated++;
        return Promise.resolve();
      },
    });
    expect(commits).toBe(1);
    expect(gated).toBe(0);
  });

  // The allow-list: re-running against fresh state can produce a different
  // outcome, so the bounded retry stays.
  const retryable: Array<[string, Record<string, unknown>]> = [
    // Stale basis from upstream. The message shape is what toRejectedError
    // recognizes; the gate is what editWithRetry awaits.
    ["ConflictError", {
      name: "ConflictError",
      message: "stale confirmed read: of:test at seq 0 conflicted with seq 9",
      readyToRetry: () => Promise.resolve(),
    }],
    // Stale basis locally (storage/v2-transaction.ts `validate()`).
    ["StorageTransactionInconsistent", {
      name: "StorageTransactionInconsistent",
      message: "read invalidated before commit",
    }],
    // Liveness the client heals by itself: a transport close schedules
    // `reconnect()`, and a `transact` issued while disconnected queues in
    // `#outstandingCommits` and calls `restoreConnection()` (memory/v2/client.ts),
    // so the retry runs over a re-established link. `SessionError` looks like
    // this one but is in the terminal list above — nothing remounts a session.
    ["ConnectionError", { name: "ConnectionError", message: "socket closed" }],
    // Liveness by collateral damage: an undecodable frame makes the client's
    // `rejectPending` sweep (memory/v2/client.ts `onMessage`) reject EVERY
    // in-flight request, including commits the server may never have seen and
    // certainly never refused.
    ["InvalidMessageError", {
      name: "InvalidMessageError",
      message: "Unable to parse memory server message",
    }],
    // The callback discarded this attempt; also the one CFC pre-storage
    // rejection that stays retryable, where a PREPARED transaction's inputs
    // drifted before the verdict and a fresh attempt prepares against the
    // current ones. The boundary's own refusal is `CfcCommitRefusalError`,
    // below, and is terminal.
    ["StorageTransactionAborted", {
      name: "StorageTransactionAborted",
      message: "CFC enforcement rejected commit: prepared digest changed",
    }],
    // The one denial the server itself says can clear.
    ["retriable AuthorizationError", {
      name: "AuthorizationError",
      message: "challenge already used",
      retriable: true,
    }],
  ];

  for (const [name, rejection] of retryable) {
    it(`exhausts the budget for a ${name}`, async () => {
      const { commits, error } = await commitsFor(rejection);
      // DEFAULT_MAX_RETRIES retries = DEFAULT_MAX_RETRIES + 1 attempts.
      expect(commits).toBe(DEFAULT_MAX_RETRIES + 1);
      expect(error).toBeDefined();
    });

    it(`stops as soon as a ${name} clears`, async () => {
      const { commits, error, ok } = await commitsFor(rejection, {
        succeedOnAttempt: 2,
      });
      expect(commits).toBe(2);
      expect(error).toBeUndefined();
      expect(ok).toBe("done");
    });
  }

  it("returns a `CfcCommitRefusalError` after one run of the action", async () => {
    // A real CFC refusal rather than the stubs above: which shape a boundary
    // refusal takes is settled before the classifier sees it. The transaction
    // write chokepoint records an unprivileged write at a reserved CFC grant
    // address, prepare refuses it with a verdict, and a refusal whose reasons
    // are all verdicts is the terminal name.
    //
    // The rung decides this case, so it names one: the refusal exists from
    // `enforce-explicit` upward, and under `observe` the reason stays a
    // diagnostic while under `disabled` no gate runs at all.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    let actions = 0;
    try {
      const result = await runtime.editWithRetry((tx) => {
        actions++;
        tx.writeOrThrow({
          space: signer.did(),
          id: `${CFC_GRANT_ID_PREFIX}forged` as URI,
          type: "application/json",
          path: ["value"],
        }, { forged: true });
        return "written";
      });
      expect(actions).toBe(1);
      expect(result.error?.name).toBe("CfcCommitRefusalError");
      expect(result.error?.message).toContain(
        "unprivileged write to protected runtime surface",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

// The classification above is only reachable if the wire name survives
// normalization. `toRejectedError` (storage/v2.ts) used to preserve only
// PreconditionFailedError / ConflictError / RowLabelCommitError and flatten
// everything else into a generic TransactionError — so no caller COULD
// classify. This exercises the real server -> runner path.

const TEST_AUDIENCE = "did:key:z6Mk-runner-retry-classification-audience";

class CountingLoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  /** Commits sent for a space's ACL document, across all sessions. */
  aclCommits = 0;

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    const realTransact = session.transact.bind(session);
    (session as unknown as { transact: unknown }).transact = (
      commit: { operations?: readonly unknown[] },
    ) => {
      for (const operation of commit.operations ?? []) {
        if ((operation as { id?: string }).id === `of:${space}`) {
          this.aclCommits++;
          break;
        }
      }
      return realTransact(commit as Parameters<typeof realTransact>[0]);
    };
    return { client, session };
  }
}

class TestStorageManager extends V2StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

Deno.test("a server ProtocolError reaches editWithRetry by name, once", async () => {
  const user = await Identity.fromPassphrase("retry-classification user");
  const bob = await Identity.fromPassphrase("retry-classification bob");

  const server = new MemoryV2Server.Server({
    store: new URL("memory://retry-classification"),
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: "enforce" },
    subscriptionRefreshDelayMs: 0,
  });
  const factory = new CountingLoopbackSessionFactory(server);
  const storageManager = TestStorageManager.overServer({ as: user }, factory);
  const space = await storageManager.createSpace({ [user.did()]: "OWNER" });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const sync = await storageManager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    const before = factory.aclCommits;

    // Replace the ACL with an ownerless one. This is the correct SHAPE (a
    // whole-document write, so it passes the runner's write chokepoint) but
    // the server refuses the VALUE: an ACL must retain a concrete OWNER. That
    // is deterministic — no re-run makes the value well-formed — and it can
    // only be decided server-side, which is what this test needs to observe.
    //
    // It deliberately does not provoke the ACL *shape* rule. A value-path
    // write to the ACL document no longer reaches the server at all: the
    // runner refuses it in-process (`noteSystemWrite`), which surfaces as
    // StorageTransactionAborted — a retryable class — and so would not
    // exercise the terminal path under test.
    const address: IMemorySpaceAddress = {
      space,
      id: `of:${space}` as URI,
      type: "application/json",
      path: [],
    };
    const result = await runtime.editWithRetry((tx) => {
      tx.writeOrThrow(
        address,
        { value: { [bob.did()]: "READ" } } as unknown as FabricValue,
      );
    });

    assert(result.error, "the malformed ACL commit must be refused");
    // The name the server chose, not a flattened TransactionError.
    assertEquals(result.error.name, "ProtocolError");
    assert(
      result.error.message.includes("concrete OWNER"),
      `unexpected message: ${result.error.message}`,
    );
    // Exactly one round-trip: the refusal is deterministic.
    assertEquals(factory.aclCommits - before, 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  }
});

// Why `SessionError` is terminal, pinned against the real replica.
//
// The convergence argument for retrying one is identical to a
// `ConnectionError`'s — the commit was never evaluated, so a re-established
// session could land it. It fails on a fact about the RETRY PATH, not about the
// error: nothing between two `editWithRetry` attempts remounts the session.
// `SpaceReplica.#memoizedSessionHandle()` memoizes the mount and clears it
// only in `close()`/`closeNow()` (storage/v2.ts), and `SpaceSession.#reopen()`
// runs
// only from `restore()`, which only the client's transport `reconnect()` calls
// (memory/v2/client.ts). So every attempt re-sends over the very handle the
// server just refused.
//
// This asserts both halves: one commit attempt (the classification), and one
// session creation (the fact the classification rests on). If someone teaches
// the retry path to clear `#sessionHandle`, the second assertion is what will
// fail — and that is the signal to move `SessionError` back into the allow-list
// in storage/rejection.ts.
class SessionErrorSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  /** Mounts created — how many times a session was (re)opened. */
  sessions = 0;

  /** transact() calls made after `arm()`. */
  commits = 0;

  #armed = false;

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  arm(): void {
    this.#armed = true;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    this.sessions++;
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    const realTransact = session.transact.bind(session);
    (session as unknown as { transact: unknown }).transact = (
      commit: unknown,
    ) => {
      if (!this.#armed) {
        return realTransact(commit as Parameters<typeof realTransact>[0]);
      }
      this.commits++;
      // Verbatim what memory/v2/server.ts `transact` returns for a session the
      // registry no longer holds — the ACL de-authorization sweep
      // (`#revokeDeauthorizedSessions`) and a takeover both produce it on a
      // still-live connection. It travels the real rejection path from here:
      // SpaceReplica's push catch -> `toRejectedError` (which preserves the
      // name) -> `finalizeRejection` -> editWithRetry's classification.
      return Promise.reject(
        Object.assign(new Error("Unknown session for space"), {
          name: "SessionError",
        }),
      );
    };
    return { client, session };
  }
}

Deno.test("a SessionError commits once and does not remount the session", async () => {
  const user = await Identity.fromPassphrase("session-error user");

  const server = new MemoryV2Server.Server({
    store: new URL("memory://session-error-retry"),
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: "enforce" },
    subscriptionRefreshDelayMs: 0,
  });
  const factory = new SessionErrorSessionFactory(server);
  const storageManager = TestStorageManager.overServer({ as: user }, factory);
  const space = await storageManager.createSpace({ [user.did()]: "OWNER" });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  try {
    const sync = await storageManager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    const sessionsAfterMount = factory.sessions;
    factory.arm();

    const address: IMemorySpaceAddress = {
      space,
      id: "of:session-error-doc" as URI,
      type: "application/json",
      path: [],
    };
    const result = await runtime.editWithRetry((tx) => {
      tx.writeOrThrow(address, { value: 1 } as unknown as FabricValue);
    });

    assert(result.error, "the commit must be rejected");
    assertEquals(result.error.name, "SessionError");
    // One attempt. Before this classification the default budget spent six,
    // all within milliseconds of each other — there is no backoff.
    assertEquals(factory.commits, 1);
    // And the reason one attempt is all that could ever help: the retry path
    // never opened a new session, so a second attempt would have re-sent over
    // the same refused handle.
    assertEquals(factory.sessions, sessionsAfterMount);
  } finally {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  }
});
