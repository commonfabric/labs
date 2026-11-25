import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { renderInProcess } from "../src/in-process.ts";
import { MockDoc } from "../src/mock-doc.ts";

Deno.test("in-process render empties a list when debounce expires during continuation", async (t) => {
  const signer = await Identity.fromPassphrase("in-process-debounce");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverExecution: false },
  });
  const mock = new MockDoc(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
  );
  const container = mock.document.getElementById("root")!;
  const access = runtime.scheduler.accessForTestingOnly;
  const originalNow = performance.now.bind(performance);
  const originalQueue = runtime.scheduler.queueExecution;
  const originalEligible = access.gates.getNextEligibleRunTime;
  const originalSubmit = runtime.telemetry.submit;
  let render: ReturnType<typeof renderInProcess> | undefined;
  try {
    const tx = runtime.edit();
    // Separate row documents keep their values when the list drops their
    // links, so only the list sink is owed a new render.
    const rows = Array.from({ length: 50 }, (_, index) => {
      const row = runtime.getCell<unknown>(
        space,
        `row-${index}`,
        undefined,
        tx,
      );
      row.set({ type: "vnode", name: "i", props: {}, children: [0] });
      return row;
    });
    const list = runtime.getCell<unknown>(space, "list", undefined, tx);
    list.set(rows);
    const page = runtime.getCell<unknown>(space, "page", undefined, tx);
    page.set({
      type: "vnode",
      name: "div",
      props: { id: "items" },
      children: [list],
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    render = renderInProcess(container, page, {
      document: mock.document,
      setProp: mock.renderOptions.setProp,
    });
    await runtime.idle();
    render.flush();
    expect(container.getElementsByTagName("i").length).toBe(50);

    const listRef = list.getAsNormalizedFullLink();
    const sinks = [...access.nodes.nodes()].filter(({ action }) =>
      access.dependencyUpdateState.dependencies.get(action)?.reads.some(
        ({ id }) => id === listRef.id,
      )
    );
    expect(sinks.length).toBe(1);
    const sink = sinks[0];

    // Hold dispatch while publishing the new value; the continuation below
    // owns the decision to wake the renderer after its deadline.
    runtime.scheduler.queueExecution = () => {};
    const update = runtime.edit();
    list.withTx(update).set([]);
    expect((await update.commit().settled).error).toBeUndefined();
    await storageManager.synced();
    runtime.scheduler.queueExecution = originalQueue;
    expect(sink.status).toBe("invalid");
    expect(list.withTx(runtime.readTx()).get()).toEqual([]);
    expect(container.getElementsByTagName("i").length).toBe(50);
    access.gates.cancelWake();
    expect(access.gates.hasWakeTimer()).toBe(false);

    let now = originalNow();
    const deadline = now + 50;
    sink.gate.debounceReadyAt = deadline;
    performance.now = () => now;
    let crossedDeadline = false;
    let settled = false;
    runtime.telemetry.submit = function (event) {
      originalSubmit.call(this, event);
      if (event.type === "scheduler.settle") settled = true;
    };
    access.gates.getNextEligibleRunTime = function (action, sampledNow) {
      const result = originalEligible.call(this, action, sampledNow);
      if (settled && action === sink.action && !crossedDeadline) {
        expect(result).toBe(deadline);
        crossedDeadline = true;
        now = deadline + 1;
      }
      return result;
    };

    expect(access.pending.size).toBe(0);
    await access.execute();
    expect(crossedDeadline).toBe(true);

    // Drain the wake the continuation scheduled. Calling `runtime.idle()`
    // here could itself discover and revive the stranded sink.
    await t.settle();
    render.flush();
    expect(container.getElementsByTagName("i").length).toBe(0);
    expect(sink.status).toBe("clean");
  } finally {
    performance.now = originalNow;
    runtime.scheduler.queueExecution = originalQueue;
    access.gates.getNextEligibleRunTime = originalEligible;
    runtime.telemetry.submit = originalSubmit;
    render?.cancel();
    await runtime.dispose();
    await storageManager.close();
  }
});
