/**
 * Post-genesis ACL mutation against a real memory-v2 server.
 *
 * The pre-existing `acl-manager.test.ts` mocks the runtime wholesale — fake
 * cell, fake `editWithRetry` — so it cannot observe the commit the runner
 * actually emits. That is precisely how a bug shipped in which every ACL
 * mutation after genesis was refused by the server ("ACL mutations must
 * replace the space-scoped ACL document"): the runner decomposed the write
 * into `op: "patch"`, the server requires a whole-document `op: "set"`, and no
 * test in the suite could see the difference. `memory-v2-acl-bootstrap.test.ts`
 * uses a real server but only ever covers genesis.
 *
 * These tests therefore assert the emitted OPERATION SHAPE, not just a green
 * path. A patch-based "fix" that happened to succeed, or a fix that only
 * succeeded on a retry, would pass a value-only assertion and fail here.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { ACLManager } from "../src/acl-manager.ts";

const TEST_AUDIENCE = "did:key:z6Mk-runner-acl-mutation-audience";

interface RecordedOperation {
  readonly op: string;
  readonly id: string;
  readonly scope?: string;
}

/**
 * Loopback factory that records every operation the runner sends for the ACL
 * document, so a test can assert on commit shape and commit count.
 */
class RecordingLoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap: boolean;
  readonly aclOperations: RecordedOperation[] = [];
  #aclDocId: string;

  readonly #server: MemoryV2Server.Server;

  constructor(
    server: MemoryV2Server.Server,
    space: MemorySpace,
    // `false` suppresses the storage manager's ACL genesis at session open
    // (storage/v2.ts returns early when the factory does not advertise
    // support), which is the only way to reach a real server holding a space
    // whose ACL document does not exist yet.
    supportsAclBootstrap = true,
  ) {
    this.#server = server;
    this.#aclDocId = `of:${space}`;
    this.supportsAclBootstrap = supportsAclBootstrap;
  }

  /** Operations recorded since the marker returned by `mark()`. */
  since(marker: number): RecordedOperation[] {
    return this.aclOperations.slice(marker);
  }

  mark(): number {
    return this.aclOperations.length;
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
        const op = operation as RecordedOperation;
        if (op.id === this.#aclDocId) {
          this.aclOperations.push({ op: op.op, id: op.id, scope: op.scope });
        }
      }
      return realTransact(commit as Parameters<typeof realTransact>[0]);
    };
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
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

const createServer = (label: string): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: new URL(`memory://${label}`),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: "enforce" },
    subscriptionRefreshDelayMs: 0,
  });

/**
 * Genesis a space and return the pieces needed to mutate its ACL. The caller
 * owns teardown via the returned `dispose`.
 */
const withGenesisedSpace = async (label: string) => {
  const user = await Identity.fromPassphrase(`${label} user`);
  const spaceIdentity = await Identity.fromPassphrase(`${label} space`);
  const space = spaceIdentity.did();

  const server = createServer(label);
  const factory = new RecordingLoopbackSessionFactory(server, space);
  const storageManager = TestStorageManager.overServer(
    { as: user, spaceIdentity },
    factory,
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const sync = await storageManager.open(space).sync(`of:${space}` as URI);
  assert(!sync.error, sync.error?.message);

  // Independent clients over the same server, for genuine concurrency: a
  // second `ACLManager` on the same runtime would resolve both writes against
  // one local replica and never exercise the conflict path.
  const extraTeardown: Array<() => Promise<void>> = [];
  const openSecondClient = async () => {
    const otherManager = TestStorageManager.overServer(
      { as: user, spaceIdentity },
      new RecordingLoopbackSessionFactory(server, space),
    );
    const otherRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherManager,
    });
    const otherSync = await otherManager.open(space).sync(`of:${space}` as URI);
    assert(!otherSync.error, otherSync.error?.message);
    extraTeardown.push(async () => {
      await otherRuntime.dispose();
      await otherManager.close();
    });
    return new ACLManager(otherRuntime, space);
  };

  return {
    user,
    space,
    server,
    factory,
    runtime,
    acl: new ACLManager(runtime, space),
    openSecondClient,
    readStoredAcl: async () =>
      (await server.readDocument(space, `of:${space}`))?.value,
    dispose: async () => {
      for (const teardown of extraTeardown) await teardown();
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    },
  };
};

/**
 * A real server holding a space whose ACL document has never been written, and
 * a runtime mounted AS THE SPACE IDENTITY. Two things make the un-genesised
 * state reachable: the factory does not advertise `supportsAclBootstrap`, so
 * the storage manager's genesis at session open is skipped entirely; and the
 * server grants an implicit OWNER to a principal equal to the space
 * (`#resolveCapability`), which is also the only principal its
 * `#validateAclCommit` lets initialize a missing ACL. The caller owns teardown.
 */
const withUnGenesisedSpace = async (label: string) => {
  const spaceIdentity = await Identity.fromPassphrase(`${label} space`);
  const space = spaceIdentity.did();

  const server = createServer(label);
  const factory = new RecordingLoopbackSessionFactory(server, space, false);
  const storageManager = TestStorageManager.overServer(
    { as: spaceIdentity },
    factory,
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const sync = await storageManager.open(space).sync(`of:${space}` as URI);
  assert(!sync.error, sync.error?.message);

  return {
    space,
    server,
    factory,
    runtime,
    acl: new ACLManager(runtime, space),
    readStoredAcl: async () =>
      (await server.readDocument(space, `of:${space}`))?.value,
    dispose: async () => {
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    },
  };
};

Deno.test("ACLManager can request space-authorized initialization", async () => {
  // Restores coverage the mocked `acl-manager.test.ts` used to carry: the
  // `current === null` branch of `#write`, i.e. creating the FIRST ACL rather
  // than replacing an existing one. Every other test here starts from a
  // genesised space, so without this the whole-document write is only ever
  // exercised against a document that already exists — and the mocked version
  // could not tell whether the server would accept the commit at all.
  const ctx = await withUnGenesisedSpace("runner-acl-mutation-init");
  const alice = await Identity.fromPassphrase("runner-acl-mutation-init alice");
  try {
    assertEquals(
      await ctx.readStoredAcl(),
      undefined,
      "fixture must start with no ACL document",
    );
    assertEquals(await ctx.acl.get(), null);

    const marker = ctx.factory.mark();
    await ctx.acl.set(alice.did(), "OWNER");

    assertEquals(await ctx.readStoredAcl(), { [alice.did()]: "OWNER" });
    // A genesis commit is subject to the same shape invariant as any later
    // mutation, and takes exactly one attempt.
    assertEquals(ctx.factory.since(marker), [{
      op: "set",
      id: `of:${ctx.space}`,
      scope: "space",
    }]);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACLManager surfaces rejected writes with the server's error name", async () => {
  // Also restored from the mocked suite, which was the only assertion that
  // `#write` rethrows with `error.name` preserved rather than collapsing the
  // rejection into a generic Error. The name is load-bearing: it is what
  // `isRetryableCommitRejection` keys off, so losing it would silently enroll
  // a deterministic refusal in `editWithRetry`'s retry loop. Against a real
  // server the refusal is genuine — the ACL validity rule in
  // `#validateAclCommit` — instead of a hand-written mock result.
  const ctx = await withUnGenesisedSpace("runner-acl-mutation-rejected");
  const alice = await Identity.fromPassphrase("runner-acl-mutation-rej alice");
  try {
    await ctx.acl.set(alice.did(), "OWNER");

    let failure: Error | undefined;
    try {
      // Downgrading the only concrete OWNER leaves the ACL ownerless, which
      // the server refuses as a ProtocolError.
      await ctx.acl.set(alice.did(), "WRITE");
    } catch (error) {
      failure = error as Error;
    }

    assert(failure, "an ownerless ACL must be refused");
    assertEquals(
      failure.name,
      "ProtocolError",
      `#write must preserve the rejection's name, got: ${failure.name}`,
    );
    assert(
      /concrete OWNER/.test(failure.message),
      `unexpected message: ${failure.message}`,
    );
    assertEquals(await ctx.readStoredAcl(), { [alice.did()]: "OWNER" });
  } finally {
    await ctx.dispose();
  }
});

Deno.test("a batched value-path ACL write throws and leaves the earlier run applied", async () => {
  // The batch path runs writes through the same `noteSystemWrite` chokepoint as
  // single writes, so the ACL guard fires there too. But `writeBatch`
  // (storage/v2-transaction.ts) applies same-document runs as it PULLS from the
  // generator, and the generator calls `noteSystemWrite` before it yields — so
  // a throw on write k escapes after runs 1..k-1 have already been applied.
  // This is a partial write plus a throw, not an atomic refusal, and the
  // behavior is asserted rather than assumed so a future change to either side
  // has to confront it.
  //
  // Three writes are needed to observe it: a run is only flushed when a write
  // for a DIFFERENT document arrives, so with only [ordinary, acl] the throw
  // would beat the first flush.
  const ctx = await withGenesisedSpace("runner-acl-mutation-batch");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-batch bob");
  const first = `of:${ctx.space}-batch-first` as URI;
  const second = `of:${ctx.space}-batch-second` as URI;
  try {
    const marker = ctx.factory.mark();
    const tx = ctx.runtime.edit();
    const link = (id: URI, path: readonly string[]) => ({
      id,
      space: ctx.space,
      scope: "space" as const,
      path,
    });

    const writeValuesOrThrow = tx.writeValuesOrThrow?.bind(tx);
    assert(writeValuesOrThrow, "the batch write API must be available");

    let thrown: Error | undefined;
    try {
      writeValuesOrThrow([
        { address: link(first, []), value: "first" },
        { address: link(second, []), value: "second" },
        // Even path `[]` reaches the guard: `toMemorySpaceAddress` prefixes
        // "value", so no link-shaped write can ever address the ACL document's
        // root. The value surface is the ONLY surface this API can reach.
        {
          address: link(`of:${ctx.space}` as URI, [bob.did()]),
          value: "WRITE",
        },
      ]);
    } catch (error) {
      thrown = error as Error;
    }

    assert(thrown, "a batched ACL write must throw");
    assert(
      /mutate it through ACLManager/.test(thrown.message),
      `error should name ACLManager, got: ${thrown.message}`,
    );

    // The partial write: run 1 was flushed when write 2 arrived; run 2 never
    // was. Nothing rolled run 1 back, and the transaction is still open and
    // still writable — a caller that swallowed the throw and committed would
    // land the prefix.
    assertEquals(
      tx.readOrThrow({
        space: ctx.space,
        id: first,
        type: "application/json",
        path: ["value"],
      }),
      "first",
    );
    assertEquals(
      tx.readOrThrow({
        space: ctx.space,
        id: second,
        type: "application/json",
        path: ["value"],
      }),
      undefined,
    );
    assertEquals(tx.status().status, "ready");

    // The obligation that fact creates: the caller must not commit. Aborting is
    // what keeps the prefix off the server.
    tx.abort("batched ACL write refused");
    assertEquals(ctx.factory.since(marker), []);
    assertEquals(await ctx.readStoredAcl(), {
      [ctx.user.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL grant after genesis emits one whole-document set", async () => {
  const ctx = await withGenesisedSpace("runner-acl-mutation-grant");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-grant bob");
  try {
    const marker = ctx.factory.mark();
    await ctx.acl.set(bob.did(), "READ");

    assertEquals(await ctx.readStoredAcl(), {
      [ctx.user.did()]: "OWNER",
      "*": "WRITE",
      [bob.did()]: "READ",
    });

    // Shape, not just outcome. The server's storage invariant is that an ACL
    // mutation is a single whole-document `set`; a `patch` here is the bug.
    // The count also guards the retry path: a fix that only succeeded on a
    // later `editWithRetry` attempt would show more than one operation.
    assertEquals(ctx.factory.since(marker), [{
      op: "set",
      id: `of:${ctx.space}`,
      scope: "space",
    }]);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL capability can be changed and revoked after genesis", async () => {
  const ctx = await withGenesisedSpace("runner-acl-mutation-revoke");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-revoke bob");
  try {
    await ctx.acl.set(bob.did(), "READ");

    // Upgrade in place.
    const upgradeMarker = ctx.factory.mark();
    await ctx.acl.set(bob.did(), "WRITE");
    assertEquals(
      (await ctx.readStoredAcl() as Record<string, string>)[bob.did()],
      "WRITE",
    );
    assertEquals(ctx.factory.since(upgradeMarker).map((o) => o.op), ["set"]);

    // Revoke.
    const revokeMarker = ctx.factory.mark();
    await ctx.acl.remove(bob.did());
    const stored = await ctx.readStoredAcl() as Record<string, string>;
    assertEquals(bob.did() in stored, false);
    assertEquals(ctx.factory.since(revokeMarker).map((o) => o.op), ["set"]);

    assertEquals(await ctx.acl.get(), {
      [ctx.user.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test("removing the bootstrap wildcard makes a space private", async () => {
  // The reason this bug mattered: genesis writes `"*": "WRITE"`, so a named
  // space is born world-writable, and this is the only operation that closes
  // it. While ACL mutation was broken there was no route to a private space
  // through any product surface.
  const ctx = await withGenesisedSpace("runner-acl-mutation-lockdown");
  try {
    assertEquals(
      "*" in (await ctx.readStoredAcl() as Record<string, string>),
      true,
    );

    const marker = ctx.factory.mark();
    await ctx.acl.remove("*");

    assertEquals(await ctx.readStoredAcl(), { [ctx.user.did()]: "OWNER" });
    assertEquals(ctx.factory.since(marker).map((o) => o.op), ["set"]);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL mutation preserves sibling envelope fields", async () => {
  // A whole-document write replaces every sibling field, so `#write` spreads
  // the stored envelope instead of constructing a bare `{ value }`. Without
  // that, a `["cfc"]` label map or `source` on the ACL document would be
  // silently erased by the next grant. Nothing sets a sibling on the ACL doc
  // today, which is exactly why this needs a test rather than a comment.
  const ctx = await withGenesisedSpace("runner-acl-mutation-siblings");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-siblings bob");
  try {
    // Install a sibling out-of-band, as a labeling layer would.
    const current = await ctx.server.readDocument(
      ctx.space,
      `of:${ctx.space}`,
    );
    const writer = new RecordingLoopbackSessionFactory(ctx.server, ctx.space);
    const spaceIdentity = await Identity.fromPassphrase(
      "runner-acl-mutation-siblings space",
    );
    const connection = await writer.create(ctx.space, spaceIdentity);
    try {
      await connection.session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${ctx.space}`,
          value: { value: current?.value, cfc: { marker: "label-map" } },
        }],
      });
    } finally {
      await connection.client.close();
    }

    await ctx.acl.set(bob.did(), "READ");

    const after = await ctx.server.readDocument(ctx.space, `of:${ctx.space}`);
    assertEquals(
      (after as { cfc?: unknown } | undefined)?.cfc,
      { marker: "label-map" },
      "a grant must not erase sibling envelope fields",
    );
    assertEquals(
      (after?.value as Record<string, string>)[bob.did()],
      "READ",
    );
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL mutation does not mutate the caller's stored value", async () => {
  // Ported from the mocked suite: `#write` derives a fresh object rather than
  // mutating the immutable view handed out by `get()`.
  const ctx = await withGenesisedSpace("runner-acl-mutation-immutable");
  const bob = await Identity.fromPassphrase(
    "runner-acl-mutation-immutable bob",
  );
  try {
    const before = await ctx.acl.get();
    await ctx.acl.set(bob.did(), "WRITE");
    assertEquals(
      before,
      { [ctx.user.did()]: "OWNER", "*": "WRITE" },
      "the previously returned ACL must not be mutated in place",
    );
  } finally {
    await ctx.dispose();
  }
});

Deno.test("concurrent ACL writers do not lose each other's grants", async () => {
  // The classic ACL lost-update, and the specific hazard of a whole-document
  // write: a stale base clobbers a concurrent grant instead of merging with
  // it. `#write` re-reads and re-derives inside every `editWithRetry` attempt
  // precisely so a retry merges with the winner. The mocked suite asserted
  // this against a fake transaction; this races two INDEPENDENT clients — each
  // with its own storage manager, runtime and local replica — over one server,
  // so the server's conflict detection is genuinely in the loop.
  const ctx = await withGenesisedSpace("runner-acl-mutation-concurrent");
  const other = await ctx.openSecondClient();
  const bob = await Identity.fromPassphrase("runner-acl-mutation-concurrent b");
  const carol = await Identity.fromPassphrase(
    "runner-acl-mutation-concurrent c",
  );
  try {
    await Promise.all([
      ctx.acl.set(bob.did(), "READ"),
      other.set(carol.did(), "WRITE"),
    ]);

    // Neither grant may be clobbered by the other's whole-document write.
    assertEquals(await ctx.readStoredAcl(), {
      [ctx.user.did()]: "OWNER",
      "*": "WRITE",
      [bob.did()]: "READ",
      [carol.did()]: "WRITE",
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL mutation notifies subscribers of the ACL cell", async () => {
  // `#write` addresses the whole document (path `[]`) while every reader —
  // notably `cfc/space-membership.ts`, which drives live revocation — holds a
  // Cell at link path `[]`, i.e. document path `["value"]`. A write that
  // landed without dirtying those readers would leave revocation silently
  // stale, so the reactivity direction is asserted rather than assumed.
  const ctx = await withGenesisedSpace("runner-acl-mutation-reactivity");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-reactivity b");
  try {
    const aclCell = ctx.runtime.getCellFromLink<unknown>({
      id: `of:${ctx.space}` as URI,
      path: [],
      space: ctx.space,
    });
    await aclCell.sync();

    const seen: unknown[] = [];
    const cancel = aclCell.sink((value) => {
      seen.push(value);
    });
    try {
      await ctx.acl.set(bob.did(), "READ");
      await ctx.runtime.idle();
    } finally {
      cancel();
    }

    const latest = seen.at(-1) as Record<string, string> | undefined;
    assertEquals(
      latest?.[bob.did()],
      "READ",
      "a path-[] ACL write must dirty readers holding the value surface",
    );
  } finally {
    await ctx.dispose();
  }
});

Deno.test("a value-path write to the ACL document is refused in-process", async () => {
  // The server's contract (INV-12) is that an ACL mutation is a single
  // whole-document `set`. Before this guard, a value-surface write was
  // decomposed into `op: "patch"`, refused after a round-trip, and reported as
  // an error about commit shape that the write's author had no reason to
  // understand — which is how the original bug stayed unexplained. The runner's
  // write chokepoint now refuses it locally and names the sanctioned writer.
  const ctx = await withGenesisedSpace("runner-acl-mutation-guard");
  const bob = await Identity.fromPassphrase("runner-acl-mutation-guard bob");
  try {
    const marker = ctx.factory.mark();
    const result = await ctx.runtime.editWithRetry((tx) => {
      tx.writeOrThrow({
        space: ctx.space,
        id: `of:${ctx.space}` as URI,
        type: "application/json",
        path: ["value", bob.did()],
      }, "WRITE");
    });

    assert(result.error, "a value-path ACL write must not commit");
    assert(
      /mutate it through ACLManager/.test(result.error.message),
      `error should name ACLManager, got: ${result.error.message}`,
    );
    // Refused before any commit is built — no round-trip, no server rejection.
    assertEquals(ctx.factory.since(marker), []);
    assertEquals(await ctx.readStoredAcl(), {
      [ctx.user.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACL mutation still cannot remove the last concrete owner", async () => {
  // Guard against the fix having relaxed a real server invariant while making
  // mutation work.
  const ctx = await withGenesisedSpace("runner-acl-mutation-last-owner");
  try {
    let failure: Error | undefined;
    try {
      await ctx.acl.remove(ctx.user.did());
    } catch (error) {
      failure = error as Error;
    }
    assert(failure, "removing the only concrete OWNER must be refused");
    assertEquals(
      (await ctx.readStoredAcl() as Record<string, string>)[ctx.user.did()],
      "OWNER",
    );
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACLManager returns the committed ACL when an owner removes themself", async () => {
  const ctx = await withGenesisedSpace("runner-acl-mutation-self-remove");
  const bob = await Identity.fromPassphrase(
    "runner-acl-mutation-self-remove bob",
  );
  try {
    await ctx.acl.remove("*");
    await ctx.acl.set(bob.did(), "OWNER");

    const committed = await ctx.acl.remove(ctx.user.did());

    assertEquals(committed, {
      [bob.did()]: "OWNER",
    });
    assertEquals(await ctx.readStoredAcl(), committed);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACLManager monotonic grants preserve stronger concurrent access", async () => {
  const harness = await withGenesisedSpace("monotonic-grant");
  try {
    const guest = (await Identity.fromPassphrase("monotonic-guest")).did();
    await harness.acl.remove("*");
    const external = "did:web:principal.example";
    await harness.acl.grant(external, "READ");
    assertEquals(
      (await harness.readStoredAcl() as Record<string, string>)[external],
      "READ",
    );
    await harness.acl.set(external, "WRITE");
    await harness.acl.grant(external, "READ");
    assertEquals(
      (await harness.readStoredAcl() as Record<string, string>)[external],
      "WRITE",
    );
    await harness.acl.set("*", "WRITE");
    await harness.acl.grant(guest, "READ");
    assertEquals((await harness.acl.get())?.[guest], "WRITE");
    await harness.acl.remove("*");

    await harness.acl.set(guest, "OWNER");
    await harness.acl.grant(guest, "READ");
    assertEquals((await harness.acl.get())?.[guest], "OWNER");
    await harness.acl.remove(guest);
    const other = await harness.openSecondClient();
    await Promise.all([
      harness.acl.grant(guest, "WRITE"),
      other.grant(guest, "READ"),
    ]);
    assertEquals(
      (await harness.readStoredAcl() as Record<string, string>)[guest],
      "WRITE",
    );
    await other.grant(guest, "READ");
    assertEquals(
      (await harness.readStoredAcl() as Record<string, string>)[guest],
      "WRITE",
    );
  } finally {
    await harness.dispose();
  }
});

Deno.test("ACLManager grants refuse wildcard or unsupported authority without writing", async () => {
  const ctx = await withGenesisedSpace("monotonic-grant-invalid");
  try {
    const marker = ctx.factory.mark();
    const before = await ctx.readStoredAcl();
    await assertRejects(
      () => ctx.acl.grant("*" as Parameters<ACLManager["grant"]>[0], "READ"),
      Error,
      "READ or WRITE",
    );
    await assertRejects(
      () => ctx.acl.grant(ctx.user.did(), "OWNER" as "READ"),
      Error,
      "READ or WRITE",
    );
    assertEquals(ctx.factory.since(marker), []);
    assertEquals(await ctx.readStoredAcl(), before);
  } finally {
    await ctx.dispose();
  }
});

Deno.test("ACLManager grants cannot initialize a missing ACL", async () => {
  const ctx = await withUnGenesisedSpace("monotonic-grant-no-acl");
  try {
    const marker = ctx.factory.mark();
    await assertRejects(
      () => ctx.acl.grant(ctx.space, "READ"),
      Error,
      "No ACL initialized",
    );
    assertEquals(ctx.factory.since(marker), []);
    assertEquals(await ctx.readStoredAcl(), undefined);
  } finally {
    await ctx.dispose();
  }
});
