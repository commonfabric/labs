import { unavailableMismatch } from "@commonfabric/data-model/availability";
/** Verifies served effect requests distinguish the selected scope instance. */

import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { fetchText } from "../../src/builtins/fetch.ts";
import type { Cell } from "../../src/cell.ts";
import type { PostCommitSideEffect } from "../../src/cfc/types.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { effectCompletionKeyOf } from "../../src/executor/effect-completion.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const service = await Identity.fromPassphrase("builtin-instance-service");
const alice = await Identity.fromPassphrase("builtin-instance-alice");
const bob = await Identity.fromPassphrase("builtin-instance-bob");
const space = service.did();
const aliceOne = { principal: alice.did(), sessionId: "alice-one" };
const aliceTwo = { principal: alice.did(), sessionId: "alice-two" };
const bobOne = { principal: bob.did(), sessionId: "bob-one" };

describe("fetch-served-instances", () => {
  let manager: EmulatedStorageManager;
  let server: ReturnType<typeof newSharedServer>;
  let runtime: Runtime;
  const transactions: IExtendedStorageTransaction[] = [];

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const engine = await server.engineForSpace(space);
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(service.did()),
    });
    expect(lease.acquire()).toBe(true);
    manager = EmulatedStorageManager.connectTo(server, { as: service });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort();
    await manager.synced();
    await runtime.dispose();
    await manager.close();
    await server.close();
  });

  /** Stages two requests without allowing network work or the first transaction to settle. */
  function staged(
    scope: "space" | "user" | "session",
    identities: ScopeKeyIdentity[],
    sharedClosure = false,
  ) {
    const input = runtime.getCellFromLink<{ url?: string }>({
      ...runtime.getCell(space, "instance-input").getAsNormalizedFullLink(),
      scope,
    });
    const parent = runtime.getCell(space, "instance-parent");
    const construct = () =>
      fetchText(input, () => {}, () => {}, [parent], parent, runtime);
    const shared = sharedClosure ? construct() : undefined;
    return identities.map((identity) => {
      const tx = runtime.edit();
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "instance-investigation",
        scopeKeyIdentity: identity,
        attributionFromScope: true,
      });
      tx.tx.scopeKeyIdentity = identity;
      input.withTx(tx).set({ url: "https://example.test/scoped" });
      (shared ?? construct())(tx);
      return tx.getCfcState().outbox.map((effect) => effect.idempotencyKey);
    });
  }

  it("releases idle instances with one graph-level cancellation registration", () => {
    const input = runtime.getCellFromLink<{ url?: string }>({
      ...runtime.getCell(space, "idle-input").getAsNormalizedFullLink(),
      scope: "session",
    });
    const parent = runtime.getCell(space, "idle-parent");
    const cancels: Array<() => void> = [];
    const action = fetchText(
      input,
      () => {},
      (cancel) => cancels.push(cancel),
      [parent],
      parent,
      runtime,
    );
    for (let index = 0; index < 20; index++) {
      const tx = runtime.edit();
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "idle-instance",
        scopeKeyIdentity: {
          principal: alice.did(),
          sessionId: `idle-${index}`,
        },
        attributionFromScope: true,
      });
      tx.tx.scopeKeyIdentity = {
        principal: alice.did(),
        sessionId: `idle-${index}`,
      };
      input.withTx(tx).set({});
      action(tx);
    }
    expect(cancels).toHaveLength(1);
    using edits = spy(runtime, "edit");
    cancels[0]();
    expect(edits.calls).toHaveLength(0);
  });

  it("retires a settled request with an equivalent staged callback still outstanding", async () => {
    const input = runtime.getCellFromLink<{ url?: string }>({
      ...runtime.getCell(space, "dedup-input").getAsNormalizedFullLink(),
      scope: "space",
    });
    const parent = runtime.getCell(space, "dedup-parent");
    const cancels: Array<() => void> = [];
    const action = fetchText(
      input,
      () => {},
      (cancel) => cancels.push(cancel),
      [parent],
      parent,
      runtime,
    );
    const edits = [runtime.edit(), runtime.edit()];
    for (const tx of edits) {
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "dedup-instance",
        scopeKeyIdentity: aliceOne,
        attributionFromScope: true,
      });
      tx.tx.scopeKeyIdentity = aliceOne;
      input.withTx(tx).set({ url: "https://example.test/dedup" });
      action(tx);
    }
    const first = edits[0].getCfcState().outbox[0];
    const duplicate = edits[1].getCfcState().outbox[0];
    expect(duplicate.idempotencyKey).toBe(first.idempotencyKey);
    let issued = 0;
    using _fetch = stub(runtime, "fetch", () => {
      issued++;
      return Promise.resolve(new Response("answer"));
    });
    {
      runtime.prepareTxForCommit(edits[0]);
      expect((await edits[0].commit().settled).error).toBeUndefined();
      await runtime.settled();
      expect(issued).toBe(1);
      using opened = spy(runtime, "edit");
      duplicate.abandon?.(new Error("late duplicate refusal"));
      cancels[0]();
      await runtime.settled();
      expect(opened.calls).toHaveLength(0);
    }
  });

  for (const scope of ["space", "user"] as const) {
    it(`captures each issuance's representative for a shared ${scope} instance`, async () => {
      const input = runtime.getCellFromLink<{ url?: string }>({
        ...runtime.getCell(space, "representative-input")
          .getAsNormalizedFullLink(),
        scope,
      });
      const parent = runtime.getCell(space, "representative-parent");
      const action = fetchText(
        input,
        () => {},
        () => {},
        [parent],
        parent,
        runtime,
      );
      const requests = [
        Promise.withResolvers<Response>(),
        Promise.withResolvers<Response>(),
      ];
      const issued = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ];
      const completions: Array<
        { key: string; identity: ScopeKeyIdentity | undefined }
      > = [];
      const originalEdit = runtime.editWithRetry.bind(runtime);
      let count = 0;
      using _fetch = stub(runtime, "fetch", () => {
        const index = count++;
        issued[index].resolve();
        return requests[index].promise;
      });
      runtime.editWithRetry = (callback, maxRetries, options) =>
        originalEdit(
          (tx) => {
            const result = callback(tx);
            const key = effectCompletionKeyOf(tx);
            if (key !== undefined) {
              completions.push({ key, identity: tx.tx.scopeKeyIdentity });
            }
            return result;
          },
          maxRetries,
          options,
        );
      const firstIdentity = scope === "space"
        ? aliceOne
        : { principal: service.did(), sessionId: "first-session" };
      const nextIdentity = scope === "space"
        ? bobOne
        : { principal: service.did(), sessionId: "next-session" };
      const keys: string[] = [];
      try {
        for (
          const [index, identity] of [firstIdentity, nextIdentity].entries()
        ) {
          const tx = runtime.edit();
          transactions.push(tx);
          stampWaveRunContext(tx, {
            kind: "derivation",
            actionId: "representative-instance",
            scopeKeyIdentity: identity,
            attributionFromScope: true,
          });
          tx.tx.scopeKeyIdentity = identity;
          input.withTx(tx).set({
            url: `https://example.test/representative-${index}`,
          });
          action(tx);
          keys.push(tx.getCfcState().outbox[0].idempotencyKey!);
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          await issued[index].promise;
          expect(
            completions.filter((entry) => entry.key === keys[index]).map((
              entry,
            ) => entry.identity),
          ).toEqual(
            expect.arrayContaining([identity]),
          );
        }
        requests[0].resolve(new Response("old payload"));
        requests[1].resolve(new Response("new payload"));
        await runtime.settled();
        const second = completions.filter((entry) => entry.key === keys[1]);
        expect(second.length).toBeGreaterThan(0);
        expect(second.map((entry) => entry.identity)).toEqual(
          second.map(() => nextIdentity),
        );
      } finally {
        for (const request of requests) {
          request.resolve(new Response("cleanup"));
        }
        await runtime.settled();
        runtime.editWithRetry = originalEdit;
      }
    });
  }

  /** Publishes scoped links while keeping stage and commit order explicit. */
  function publicationFixture(
    bindingScope: "space" | "session" = "space",
    sourceScope: "user" | "session" = "user",
    declaredScope: "space" | "session" = bindingScope,
  ) {
    const input = runtime.getCell<{ url?: string }>(space, "publication-input");
    const parent = runtime.getCell<{ publishedScope?: string }>(
      space,
      "publication-parent",
    );
    const userUrl = runtime.getCellFromLink<string>({
      ...runtime.getCell(space, "publication-url").getAsNormalizedFullLink(),
      scope: sourceScope,
    });
    const binding = runtime.getCellFromLink<{ publishedScope?: string }>({
      ...parent.getAsNormalizedFullLink(),
      scope: bindingScope,
    });
    const cancels: Array<() => void> = [];
    const dispatches: Array<() => ReturnType<PostCommitSideEffect["flush"]>> =
      [];
    const publicationCallbacks: Array<() => void> = [];
    let resultCells: {
      pending: Cell<boolean>;
      result: Cell<string | undefined>;
      error: Cell<string | undefined>;
    };
    const publications: Array<{ scope: string | undefined; session?: string }> =
      [];
    const action = fetchText(
      input,
      (tx, result) => {
        resultCells = result;
        const scope = result.result.getAsNormalizedFullLink().scope;
        publications.push({
          scope,
          session: tx.tx.scopeKeyIdentity?.sessionId,
        });
        binding.withTx(tx).set({ publishedScope: scope });
      },
      (cancel) => cancels.push(cancel),
      [parent],
      parent,
      runtime,
      { ...binding.getAsNormalizedFullLink(), scope: declaredScope },
      false,
      binding.getAsNormalizedFullLink(),
    );
    const stage = (
      scoped: boolean,
      url = "https://example.test/publication",
      identity = runtime.scopeKeyIdentity,
      omitDispatch = false,
      deferPublication = false,
    ) => {
      const tx = runtime.edit();
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "publication-instance",
        scopeKeyIdentity: identity,
        attributionFromScope: true,
      });
      tx.tx.scopeKeyIdentity = identity;
      if (omitDispatch) {
        const enqueue = tx.enqueuePostCommitEffect.bind(tx);
        tx.enqueuePostCommitEffect = (effect) => {
          dispatches.push(() => effect.flush(tx));
          enqueue({ ...effect, flush: () => {} });
        };
      }
      if (scoped) {
        userUrl.withTx(tx).set(url);
        input.withTx(tx).key("url").set(userUrl as unknown as string);
      } else input.withTx(tx).setRaw({ url });
      const register = tx.addCommitCallback.bind(tx);
      using _publication = deferPublication
        ? stub(tx, "addCommitCallback", (callback) =>
          register((...args) => {
            publicationCallbacks.push(() => callback(...args));
          }))
        : undefined;
      action(tx);
      return tx;
    };
    const commit = async (tx: IExtendedStorageTransaction) => {
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.settled();
    };
    return {
      stage,
      commit,
      parent,
      binding,
      cancels,
      publications,
      dispatches,
      publicationCallbacks,
      get resultCells() {
        return resultCells;
      },
    };
  }

  it("retires a completed request when publication bookkeeping arrives afterward", async () => {
    const fixture = publicationFixture();
    using request = stub(
      runtime,
      "fetch",
      () => Promise.resolve(new Response("completed before publication")),
    );
    const tx = fixture.stage(true, undefined, undefined, false, true);
    await fixture.commit(tx);
    expect(request.calls).toHaveLength(1);
    expect(fixture.resultCells.result.withTx(runtime.readTx()).get()).toBe(
      "completed before publication",
    );
    expect(fixture.publicationCallbacks).toHaveLength(1);
    fixture.publicationCallbacks[0]();
    using opened = spy(runtime, "edit");
    fixture.cancels[0]();
    expect(opened.calls).toHaveLength(0);
  });

  it("retires a delayed accepted attachment when another closure supplies its memo", async () => {
    const original = publicationFixture("session", "session");
    const attachment = publicationFixture("session", "session");
    const response = Promise.withResolvers<Response>();
    const issued = Promise.withResolvers<void>();
    using request = stub(runtime, "fetch", () => {
      issued.resolve();
      return response.promise;
    });
    try {
      const initial = original.stage(true);
      runtime.prepareTxForCommit(initial);
      expect((await initial.commit().settled).error).toBeUndefined();
      await issued.promise;
      const attached = attachment.stage(true, undefined, undefined, true, true);
      runtime.prepareTxForCommit(attached);
      expect((await attached.commit().settled).error).toBeUndefined();
      expect(attachment.publicationCallbacks).toHaveLength(1);
      response.resolve(new Response("shared memo"));
      await runtime.settled();
      expect(request.calls).toHaveLength(1);
      expect(attachment.resultCells.result.withTx(runtime.readTx()).get()).toBe(
        "shared memo",
      );
      attachment.publicationCallbacks[0]();
      using opened = spy(runtime, "edit");
      attachment.cancels[0]();
      expect(opened.calls).toHaveLength(0);
    } finally {
      response.resolve(new Response("cleanup"));
      await runtime.settled();
    }
  });

  it("clears a settled error when the scoped URL is emptied", async () => {
    const fixture = publicationFixture();
    using request = stub(
      runtime,
      "fetch",
      () => Promise.reject(new Error("request failed")),
    );
    await fixture.commit(fixture.stage(true));
    expect(fixture.resultCells.error.withTx(runtime.readTx()).get())
      .toBeDefined();
    const empty = fixture.stage(true, "");
    expect(empty.getCfcState().outbox).toHaveLength(0);
    await fixture.commit(empty);
    const read = runtime.readTx();
    expect(fixture.resultCells.pending.withTx(read).get()).toBe(false);
    expect(fixture.resultCells.result.withTx(read).get()).toEqual(
      unavailableMismatch(),
    );
    expect(fixture.resultCells.error.withTx(read).get()).toBeUndefined();
    expect(request.calls).toHaveLength(1);
  });

  it("aborts its teardown transaction when bookkeeping stamping throws", async () => {
    const fixture = publicationFixture();
    await fixture.commit(fixture.stage(true, undefined, undefined, true));
    const teardown = runtime.edit();
    transactions.push(teardown);
    using _edit = stub(runtime, "edit", () => teardown);
    using _stamp = stub(runtime, "stampServerRun", () => {
      throw new Error("bookkeeping stamp failed");
    });
    using aborted = spy(teardown, "abort");
    expect(() => fixture.cancels[0]()).not.toThrow();
    expect(aborted.calls).toHaveLength(1);
    expect(teardown.status().status).toBe("error");
  });

  for (const mode of ["request", "memo", "empty"] as const) {
    it(`keeps an accepted user ${mode} published after an earlier space stage is refused`, async () => {
      const fixture = publicationFixture();
      using _fetch = stub(
        runtime,
        "fetch",
        () => Promise.resolve(new Response("user answer")),
      );
      if (mode === "memo") await fixture.commit(fixture.stage(true));
      const old = fixture.stage(false, "https://example.test/old-space");
      const abandoned = old.getCfcState().outbox[0];
      const current = fixture.stage(true, mode === "empty" ? "" : undefined);
      expect(current.getCfcState().outbox).toHaveLength(
        mode === "request" ? 1 : 0,
      );
      await fixture.commit(current);
      expect(fixture.parent.get().publishedScope).toBe("user");
      abandoned.abandon?.(
        new Error("old uncommitted space contribution refused"),
      );
      await runtime.settled();
      using opened = spy(runtime, "edit");
      fixture.cancels[0]();
      expect(opened.calls).toHaveLength(0);
      expect(fixture.parent.get().publishedScope).toBe("user");
    });
  }

  it("publishes an initial refused request without a later accepted target", async () => {
    const fixture = publicationFixture();
    const old = fixture.stage(false);
    old.getCfcState().outbox[0].abandon?.(new Error("initial request refused"));
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("space");
  });

  it("does not let a failed user publication invalidate an earlier refusal", async () => {
    const fixture = publicationFixture();
    const old = fixture.stage(false);
    const failed = fixture.stage(true);
    failed.abort();
    old.getCfcState().outbox[0].abandon?.(new Error("space request refused"));
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("space");
  });

  it("keeps a newer refused user target published after an older space refusal", async () => {
    const fixture = publicationFixture();
    const old = fixture.stage(false);
    const next = fixture.stage(true);
    next.getCfcState().outbox[0].abandon?.(new Error("user request refused"));
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("user");
    old.getCfcState().outbox[0].abandon?.(
      new Error("older space request refused"),
    );
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("user");
  });

  it("keeps refusal ownership for a different output binding session", async () => {
    const fixture = publicationFixture("session");
    const first = { principal: service.did(), sessionId: "first-binding" };
    const second = { principal: service.did(), sessionId: "second-binding" };
    const old = fixture.stage(false, undefined, first);
    using _fetch = stub(
      runtime,
      "fetch",
      () => Promise.resolve(new Response("answer")),
    );
    await fixture.commit(fixture.stage(true, undefined, second));
    old.getCfcState().outbox[0].abandon?.(new Error("first binding refused"));
    await runtime.settled();
    expect(fixture.publications.at(-1)).toEqual({
      scope: "space",
      session: first.sessionId,
    });
    expect(fixture.publications.at(-2)).toEqual({
      scope: "user",
      session: second.sessionId,
    });
  });

  it("uses physical publication scope when the declared result scope differs", async () => {
    const fixture = publicationFixture("space", "user", "session");
    const first = {
      principal: service.did(),
      sessionId: "old-declared-session",
    };
    const second = {
      principal: service.did(),
      sessionId: "new-declared-session",
    };
    const old = fixture.stage(false, undefined, first);
    using _fetch = stub(
      runtime,
      "fetch",
      () => Promise.resolve(new Response("current answer")),
    );
    await fixture.commit(fixture.stage(true, undefined, second));
    old.getCfcState().outbox[0].abandon?.(
      new Error("old space request refused"),
    );
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("user");
  });

  it("preserves an earlier refusal when another session publishes the same symbolic target", async () => {
    const fixture = publicationFixture("space", "session");
    const first = { principal: service.did(), sessionId: "first-result" };
    const second = { principal: service.did(), sessionId: "second-result" };
    const old = fixture.stage(true, undefined, first);
    await fixture.commit(fixture.stage(true, "", second));
    old.getCfcState().outbox[0].abandon?.(new Error("first session refused"));
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("session");
    expect(fixture.publications.at(-1)).toEqual({
      scope: "session",
      session: first.sessionId,
    });
  });

  for (const completed of [false, true]) {
    it(`announces a shared ${completed ? "completed" : "pending"} result to a different refused binding session`, async () => {
      const fixture = publicationFixture("session");
      const first = {
        principal: service.did(),
        sessionId: "first-shared-binding",
      };
      const second = {
        principal: service.did(),
        sessionId: "second-shared-binding",
      };
      const old = fixture.stage(false, undefined, first);
      const response = Promise.withResolvers<Response>();
      const issued = Promise.withResolvers<void>();
      using _fetch = stub(runtime, "fetch", () => {
        issued.resolve();
        return response.promise;
      });
      try {
        const next = fixture.stage(false, undefined, second);
        runtime.prepareTxForCommit(next);
        expect((await next.commit().settled).error).toBeUndefined();
        await issued.promise;
        if (completed) {
          response.resolve(new Response("shared answer"));
          await runtime.settled();
        }
        using tracked = spy(runtime, "trackAsyncWork");
        old.getCfcState().outbox[0].abandon?.(
          new Error("first binding refused"),
        );
        expect(tracked.calls).toHaveLength(1);
        await tracked.calls[0].args[0];
        expect(fixture.publications.at(-1)).toEqual({
          scope: "space",
          session: first.sessionId,
        });
        const read = runtime.readTx();
        expect(fixture.resultCells.pending.withTx(read).get()).toBe(!completed);
        expect(fixture.resultCells.error.withTx(read).get()).toBeUndefined();
        if (completed) {
          expect(fixture.resultCells.result.withTx(read).get()).toBe(
            "shared answer",
          );
        }
      } finally {
        response.resolve(new Response("shared answer"));
        await runtime.settled();
      }
    });
  }

  it("retires accepted equivalent bindings when the outbox omits one callback", async () => {
    const fixture = publicationFixture("session");
    const first = {
      principal: service.did(),
      sessionId: "first-accepted-binding",
    };
    const second = {
      principal: service.did(),
      sessionId: "second-accepted-binding",
    };
    const response = Promise.withResolvers<Response>();
    const issued = Promise.withResolvers<void>();
    using _fetch = stub(runtime, "fetch", () => {
      issued.resolve();
      return response.promise;
    });
    try {
      const initial = fixture.stage(false, undefined, first, true);
      const firstKey = initial.getCfcState().outbox[0].idempotencyKey;
      await fixture.commit(initial);
      const duplicate = fixture.stage(false, undefined, second, true);
      expect(duplicate.getCfcState().outbox[0].idempotencyKey).toBe(firstKey);
      await fixture.commit(duplicate);
      // Both requests are accepted; outbox deduplication dispatches only one.
      expect(fixture.dispatches).toHaveLength(2);
      await fixture.dispatches[0]();
      await issued.promise;
      response.resolve(new Response("shared answer"));
      await runtime.settled();
      using opened = spy(runtime, "edit");
      fixture.cancels[0]();
      expect(opened.calls).toHaveLength(0);
    } finally {
      response.resolve(new Response("shared answer"));
      await runtime.settled();
    }
  });

  it("retains an accepted binding before dispatch when another binding is refused", async () => {
    const fixture = publicationFixture("session");
    const first = {
      principal: service.did(),
      sessionId: "refused-before-dispatch",
    };
    const second = {
      principal: service.did(),
      sessionId: "accepted-before-dispatch",
    };
    const old = fixture.stage(false, undefined, first);
    await fixture.commit(fixture.stage(false, undefined, second, true));
    old.getCfcState().outbox[0].abandon?.(new Error("first binding refused"));
    await runtime.settled();
    using opened = spy(runtime, "edit");
    fixture.cancels[0]();
    expect(opened.calls).toHaveLength(1);
  });

  it("releases accepted ownership when the sink release check skips dispatch", async () => {
    const fixture = publicationFixture();
    const tx = fixture.stage(false, undefined, undefined, true);
    await fixture.commit(tx);
    const state = tx.getCfcState();
    using _state = stub(tx, "getCfcState", () =>
      ({
        ...state,
        prepare: {
          status: "prepared",
          digest: "release-rejection-fixture",
          input: {
            consumedReads: [],
            attemptedWrites: [],
            writes: [],
            writeAttemptLog: [],
            dereferenceTraces: [],
            triggerReads: [],
            writePolicyInputs: [],
          },
        },
      }) satisfies ReturnType<typeof tx.getCfcState>);
    using request = spy(runtime, "fetch");
    await fixture.dispatches[0]();
    await runtime.settled();
    expect(request.calls).toHaveLength(0);
    using opened = spy(runtime, "edit");
    fixture.cancels[0]();
    expect(opened.calls).toHaveLength(0);
  });

  for (const scoped of [false, true]) {
    it(`keeps cancellation ownership when an accepted request returns after a ${scoped ? "user" : "space"} empty publication`, async () => {
      const fixture = publicationFixture();
      const response = Promise.withResolvers<Response>();
      const issued = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      using _fetch = stub(runtime, "fetch", (_url, options) => {
        signal = options?.signal ?? undefined;
        issued.resolve();
        return response.promise;
      });
      try {
        const initial = fixture.stage(false, undefined, undefined, true);
        const initialKey = initial.getCfcState().outbox[0].idempotencyKey;
        await fixture.commit(initial);
        await fixture.commit(fixture.stage(scoped, ""));
        const returned = fixture.stage(false, undefined, undefined, true);
        expect(returned.getCfcState().outbox[0].idempotencyKey).toBe(
          initialKey,
        );
        await fixture.commit(returned);
        // In-flight deduplication retains the originally accepted callback.
        await fixture.dispatches[0]();
        await issued.promise;
        expect(signal?.aborted).toBe(false);
        fixture.cancels[0]();
        expect(signal?.aborted).toBe(true);
      } finally {
        response.resolve(new Response("cleanup"));
        await runtime.settled();
      }
    });
  }

  it("does not let an older accepted publication invalidate a newer staged target", async () => {
    const fixture = publicationFixture();
    const old = fixture.stage(false);
    const next = fixture.stage(true);
    using _fetch = stub(
      runtime,
      "fetch",
      () => Promise.resolve(new Response("space answer")),
    );
    await fixture.commit(old);
    next.getCfcState().outbox[0].abandon?.(new Error("newer target refused"));
    await runtime.settled();
    expect(fixture.parent.get().publishedScope).toBe("user");
  });

  for (const mode of ["request", "empty", "memo"] as const) {
    it(`preserves refusal ownership when a newer user ${mode} publication is withdrawn`, async () => {
      const fixture = publicationFixture();
      using _fetch = stub(
        runtime,
        "fetch",
        () => Promise.resolve(new Response("seed answer")),
      );
      if (mode !== "request") {
        await fixture.commit(
          fixture.stage(true, mode === "empty" ? "" : undefined),
        );
      }
      const old = fixture.stage(false, "https://example.test/old-space");
      const wave = new WaveAccumulator({
        space,
        basisSeq: 0,
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (space) => manager.open(space).replica,
      });
      try {
        runtime.installSealDestination({
          seal: (tx) => wave.seal(tx),
          deferSealedEffects: () => true,
        });
        const current = fixture.stage(true, mode === "empty" ? "" : undefined);
        runtime.prepareTxForCommit(current);
        expect((await current.commit().settled).error).toBeUndefined();
        runtime.clearSealDestination();
        const settlement = waveSettlementOf(current);
        expect(settlement).toBeDefined();
        wave.abandon("new publication withdrawn");
        if (settlement) expect((await settlement).error).toBeDefined();
        await wave.settled();
        old.getCfcState().outbox[0].abandon?.(new Error("old request refused"));
        await runtime.settled();
        expect(fixture.parent.get().publishedScope).toBe("space");
      } finally {
        runtime.clearSealDestination();
        wave.abandon("fixture cleanup");
        await wave.settled();
      }
    });
  }

  it(`fetchText retains one user's deterministic request identity`, () => {
    const keys = staged("user", [aliceOne, aliceOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText shares one user's key across sessions`, () => {
    const keys = staged("user", [aliceOne, aliceTwo]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText shares a space-scoped key across users`, () => {
    const keys = staged("space", [aliceOne, bobOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText separates two user instances`, () => {
    const keys = staged("user", [aliceOne, bobOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
    expect(keys[1][0]).not.toBe(keys[0][0]);
  });

  it(`fetchText separates two session instances`, () => {
    const keys = staged("session", [aliceOne, aliceTwo]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
    expect(keys[1][0]).not.toBe(keys[0][0]);
  });

  it(`fetchText stages both users on one builtin closure`, () => {
    const keys = staged("user", [aliceOne, bobOne], true);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
    expect(keys[1][0]).not.toBe(keys[0][0]);
  });
});
