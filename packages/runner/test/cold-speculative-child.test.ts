import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";

import { getMetaLink } from "../src/link-utils.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { markDurableReadTx } from "../src/storage/reactivity-log.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

describe("cold speculative child", () => {
  const managers: EmulatedStorageManager[] = [];
  const runtimes: Runtime[] = [];
  let server: ReturnType<typeof newSharedServer>;

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers.splice(0)) await manager.close();
    await server?.close();
  });

  async function setup(servingPosture = false) {
    const signer = await Identity.fromPassphrase("cold speculative child");
    const space = signer.did();
    server = newSharedServer();
    const open = (serverExecution: boolean, servingPosture = false) => {
      const storageManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution },
        servingPosture,
      });
      managers.push(storageManager);
      runtimes.push(runtime);
      return runtime;
    };
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { computed, pattern } from "commonfabric";
export default pattern<{ shortName: string }>(({ shortName }) => ({
  shortName: computed(() => shortName),
}));
`,
      }],
    };
    const author = open(false);
    const compiled = await author.patternManager.compilePattern(program, {
      space,
    });
    const child = author.getCell<{ shortName: string }>(
      space,
      "canonical member",
      compiled.resultSchema,
    );
    const create = author.edit();
    author.run(create, compiled, { shortName: "2" }, child);
    author.prepareTxForCommit(create);
    expect((await create.commit()).error).toBeUndefined();
    await child.pull();
    await author.storageManager.synced();
    const argumentLink = getMetaLink(child, "argument")!;
    const engine = await server.engineForSpace(space);
    const storedArgument = () =>
      Engine.read(engine, {
        id: argumentLink.id,
        scope: argumentLink.scope,
      })?.value;
    expect(storedArgument()).toEqual({ shortName: "2" });
    await author.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author), 1);

    const reader = open(true, servingPosture);
    const readerPattern = await reader.patternManager.compilePattern(program, {
      space,
    });
    // Replicate the result without the argument or the child's other cells.
    const reached = reader.getCellFromLink(child.getAsNormalizedFullLink())
      .asSchema({ type: "object", properties: {} });
    await reached.sync();
    const key = entityKey(
      reached.getAsNormalizedFullLink(),
      reader.scopeKeyIdentity,
    );
    let deferred = false;
    reader.telemetry.addEventListener("telemetry", (event) => {
      const { marker } = (event as CustomEvent<{
        marker: { type: string; key?: string };
      }>).detail;
      if (
        marker.type === "runner.deferred-start.pending" && marker.key === key
      ) {
        deferred = true;
      }
    });
    const failures: unknown[] = [];
    reader.pieceStartCommitFailureObserver = ({ error }) =>
      failures.push(error);
    const argument = reader.getCellFromLink<{ shortName: string }>(
      argumentLink,
    );
    return {
      space,
      reader,
      reached,
      argument,
      storedArgument,
      failures,
      async start(
        context?: ServerRunInfo,
        wrap: (tx: IExtendedStorageTransaction) => IExtendedStorageTransaction =
          (tx) => tx,
      ) {
        const tx = reader.edit();
        if (context !== undefined) stampSpeculationRunContext(tx, context);
        reader.run(wrap(tx), readerPattern, { shortName: "3" }, reached);
        reader.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        expect(deferred).toBe(true);
      },
      async finish() {
        await reader.idle();
        await reader.storageManager.synced();
        expect(failures).toEqual([]);
      },
    };
  }

  const handlerContext: ServerRunInfo = {
    actionId: "handler-result",
    kind: "event-handler",
    eventId: "child-event",
    parentEventId: "parent-event",
  };

  it("keeps a deferred speculative child argument out of durable storage", async () => {
    const fixture = await setup();
    await fixture.start(handlerContext);
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });

    fixture.reader.speculationOverlay!.retireIntent(
      fixture.space,
      "parent-event",
    );
    await fixture.finish();
    expect(fixture.argument.get()).toEqual({ shortName: "2" });
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
  });

  it("drops a deferred child's candidate when its parent event ends before the data arrives", async () => {
    const fixture = await setup();
    const landing = Promise.withResolvers<void>();
    fixture.reader.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      pattern,
      inputs,
      sync,
    ) => {
      await landing.promise;
      return await sync(cell, pattern, inputs);
    };
    await fixture.start(handlerContext);
    fixture.reader.speculationOverlay!.resolveIntent(
      fixture.space,
      "of:parent-events",
      "parent-event",
      { kind: "refused", reason: "parent completed before child data arrived" },
    );
    landing.resolve();
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "2" });
  });

  it("keeps a deferred derivation's child argument in the overlay", async () => {
    const fixture = await setup();
    await fixture.start({ actionId: "derived-child", kind: "derivation" });
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
  });

  it("keeps a wrapped speculative child argument out of durable storage", async () => {
    const fixture = await setup();
    await fixture.start(
      handlerContext,
      (tx) => new TransactionWrapper(tx, { nonReactive: true }),
    );
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
    fixture.reader.speculationOverlay!.retireIntent(
      fixture.space,
      "parent-event",
    );
    await fixture.finish();
    expect(fixture.argument.get()).toEqual({ shortName: "2" });
  });

  it("retires a deferred child under the nearest stamp in a wrapper chain", async () => {
    const fixture = await setup();
    await fixture.start(handlerContext, (tx) => {
      const wrapped = new TransactionWrapper(tx, { nonReactive: true });
      stampSpeculationRunContext(wrapped, {
        actionId: "wrapped-child",
        kind: "event-handler",
        eventId: "wrapped-event",
      });
      return new TransactionWrapper(wrapped);
    });
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });

    fixture.reader.speculationOverlay!.retireIntent(
      fixture.space,
      "parent-event",
    );
    await fixture.finish();
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
    fixture.reader.speculationOverlay!.retireIntent(
      fixture.space,
      "wrapped-event",
    );
    await fixture.finish();
    expect(fixture.argument.get()).toEqual({ shortName: "2" });
  });

  it("persists a deferred authored child through unstamped wrappers", async () => {
    const fixture = await setup();
    await fixture.start(
      undefined,
      (tx) => new TransactionWrapper(new TransactionWrapper(tx)),
    );
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "3" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
  });

  it("persists a deferred authored child argument", async () => {
    const fixture = await setup();
    await fixture.start();
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "3" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
  });

  it("persists a deferred child argument on a serving runtime", async () => {
    const fixture = await setup(true);
    await fixture.start();
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "3" });
    expect(fixture.argument.get()).toEqual({ shortName: "3" });
    expect(fixture.reader.speculationOverlay).toBeUndefined();
  });

  it("keeps a deferred authored start on its original durable read view", async () => {
    const fixture = await setup();
    await fixture.argument.sync();
    const echo = fixture.reader.edit();
    stampSpeculationRunContext(echo, {
      actionId: "argument-echo",
      kind: "event-handler",
      eventId: "argument-event",
    });
    fixture.argument.withTx(echo).set({ shortName: "4" });
    fixture.reader.prepareTxForCommit(echo);
    expect((await echo.commit()).error).toBeUndefined();
    expect(fixture.argument.get()).toEqual({ shortName: "4" });

    await fixture.start(
      { actionId: "parent-instantiation", kind: "bookkeeping" },
      (tx) => {
        markDurableReadTx(tx);
        return new TransactionWrapper(tx, { nonReactive: true });
      },
    );
    await fixture.finish();
    expect(fixture.storedArgument()).toEqual({ shortName: "3" });
    expect(fixture.reader.runner.cancels.has(
      entityKey(
        fixture.reached.getAsNormalizedFullLink(),
        fixture.reader.scopeKeyIdentity,
      ),
    )).toBe(true);
  });

  it("keeps an unmarked deferred caller's speculative read basis subject to refusal", async () => {
    const fixture = await setup();
    await fixture.argument.sync();
    const echo = fixture.reader.edit();
    stampSpeculationRunContext(echo, {
      actionId: "argument-echo",
      kind: "event-handler",
      eventId: "argument-event",
    });
    fixture.argument.withTx(echo).set({ shortName: "4" });
    fixture.reader.prepareTxForCommit(echo);
    expect((await echo.commit()).error).toBeUndefined();
    expect(fixture.argument.get()).toEqual({ shortName: "4" });

    await fixture.start();
    await fixture.reader.idle();
    await fixture.reader.storageManager.synced();
    expect(fixture.failures).toMatchObject([{ name: "SpeculativeBasisError" }]);
    expect(fixture.storedArgument()).toEqual({ shortName: "2" });
    expect(fixture.argument.get()).toEqual({ shortName: "4" });
    expect(
      fixture.reader.runner.cancels.has(
        entityKey(
          fixture.reached.getAsNormalizedFullLink(),
          fixture.reader.scopeKeyIdentity,
        ),
      ),
    ).toBe(false);
  });
});
