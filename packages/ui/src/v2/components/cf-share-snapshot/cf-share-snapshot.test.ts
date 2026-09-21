/** Sharing workflow state transitions under Lit's headless element shim. */

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFShareSnapshot } from "./index.ts";

type Preview = Awaited<ReturnType<RuntimeClient["prepareSnapshotShare"]>>;

/** Supplies connection state and completed rendering without claiming DOM behavior. */
class HeadlessSnapshot extends CFShareSnapshot {
  connected = true;

  override get isConnected(): boolean {
    return this.connected;
  }

  override get updateComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const preview: Preview = {
  id: "review-token",
  value: { books: [{ title: "Solaris", author: "Lem" }] },
  audience: {
    type: "https://commonfabric.org/cfc/atom/User",
    subject: "did:key:verified-reader",
  },
};

/** Gives each workflow independent handles and controllable host operations. */
function setup(overrides: Partial<{
  prepare: RuntimeClient["prepareSnapshotShare"];
  commit: (id: string) => Promise<CellHandle>;
  cancel: RuntimeClient["cancelSnapshotShare"];
}> = {}) {
  const element = new HeadlessSnapshot();
  const source = createMockCellHandle<unknown>(preview.value, {
    id: "of:source",
  });
  const recipient = createMockCellHandle<unknown>({}, { id: "of:recipient" });
  const result = createMockCellHandle<unknown>(null, { id: "of:result" });
  const released = createMockCellHandle<unknown>(preview.value, {
    id: "of:released",
  });
  const prepared: Parameters<RuntimeClient["prepareSnapshotShare"]>[] = [];
  const committed: string[] = [];
  const canceled: string[] = [];
  const runtime = {
    prepareSnapshotShare: (
      ...args: Parameters<RuntimeClient["prepareSnapshotShare"]>
    ) => {
      prepared.push(args);
      return overrides.prepare?.(...args) ?? Promise.resolve(preview);
    },
    commitSnapshotShare: (id: string) => {
      committed.push(id);
      return overrides.commit?.(id) ?? Promise.resolve(released);
    },
    cancelSnapshotShare: (id: string) => {
      canceled.push(id);
      return overrides.cancel?.(id) ?? Promise.resolve();
    },
  } as unknown as RuntimeClient;
  element.source = source;
  element.recipient = recipient;
  element.result = result;
  element.runtime = runtime;
  element.willUpdate(new Map([["source", undefined]]));
  return {
    element,
    source,
    recipient,
    result,
    released,
    runtime,
    prepared,
    committed,
    canceled,
    [Symbol.dispose]() {
      element.connected = false;
      element.disconnectedCallback();
    },
  };
}

/** Invokes the cancel action exposed by the component's rendered template. */
function cancelReview(element: CFShareSnapshot): void {
  const rendered = element.render();
  const index = rendered.strings.findIndex((part) => part.includes("@cancel="));
  const cancel = rendered.values[index];
  if (typeof cancel !== "function") {
    throw new Error("The review needs a cancel action");
  }
  cancel();
}

describe("CFShareSnapshot workflow", () => {
  it("prepares the exact source and user audience without publishing", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    expect(state.prepared).toEqual([[state.source.ref(), {
      user: state.recipient.ref(),
    }]]);
    expect(state.element.accessForTestingOnly.preview).toEqual(preview);
    expect(state.committed).toEqual([]);
    expect(state.result.get()).toBeNull();
    expect(state.element.render().values).toContain(
      JSON.stringify(preview.value, null, 2),
    );
  });

  it("prepares a space audience and cancels the retained review", async () => {
    using state = setup();
    state.element.audienceKind = "space";
    await state.element.accessForTestingOnly.prepare();
    expect(state.prepared).toEqual([[state.source.ref(), {
      space: state.recipient.ref(),
    }]]);
    cancelReview(state.element);
    await state.element.accessForTestingOnly.commitReviewed();
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
    expect(state.committed).toEqual([]);
  });

  for (const field of ["source", "recipient", "result", "runtime"] as const) {
    it(`does not prepare when ${field} is absent`, async () => {
      using state = setup();
      state.element[field] = undefined;
      await state.element.accessForTestingOnly.prepare();
      await state.element.accessForTestingOnly.commitReviewed();
      expect(state.prepared).toEqual([]);
      expect(state.committed).toEqual([]);
    });
  }

  it("rejects an unsupported audience supplied by an attribute", async () => {
    using state = setup();
    state.element.attributeChangedCallback("audience-kind", "user", "everyone");
    await state.element.accessForTestingOnly.prepare();
    expect(state.element.accessForTestingOnly.error).toBe(
      "Choose a supported sharing audience.",
    );
    expect(state.prepared).toEqual([]);
  });

  it("does not prepare a disconnected component", async () => {
    using state = setup();
    state.element.connected = false;
    await state.element.accessForTestingOnly.prepare();
    expect(state.prepared).toEqual([]);
  });

  it("ignores concurrent prepare calls and releases a stale response", async () => {
    const pending = Promise.withResolvers<Preview>();
    using state = setup({ prepare: () => pending.promise });
    const preparing = state.element.accessForTestingOnly.prepare();
    await state.element.accessForTestingOnly.prepare();
    state.element.source = createMockCellHandle();
    state.element.willUpdate(new Map([["source", state.source]]));
    pending.resolve(preview);
    await preparing;
    expect(state.prepared).toHaveLength(1);
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
  });

  for (const failure of [new Error("Preparation refused"), "opaque failure"]) {
    it(`reports ${failure instanceof Error ? "host" : "non-Error"} preparation failures`, async () => {
      using state = setup({ prepare: () => Promise.reject(failure) });
      await state.element.accessForTestingOnly.prepare();
      expect(state.element.accessForTestingOnly.error).toBe(
        failure instanceof Error
          ? failure.message
          : "The snapshot could not be prepared.",
      );
      expect(state.element.accessForTestingOnly.preview).toBeUndefined();
      expect(state.committed).toEqual([]);
      state.element.render();
    });
  }

  it("does not display a preparation failure after rebinding", async () => {
    const pending = Promise.withResolvers<Preview>();
    using state = setup({ prepare: () => pending.promise });
    const preparing = state.element.accessForTestingOnly.prepare();
    state.element.result = createMockCellHandle();
    state.element.willUpdate(new Map([["result", state.result]]));
    pending.reject(new Error("Old request"));
    await preparing;
    expect(state.element.accessForTestingOnly.error).toBe("");
  });

  it("writes the released link before emitting a payload-free completion", async () => {
    using state = setup();
    const events: unknown[] = [];
    state.element.addEventListener("cf-shared", (event) => {
      expect(state.result.get()).toBe(state.released);
      events.push((event as CustomEvent).detail);
    });
    await state.element.accessForTestingOnly.prepare();
    await state.element.accessForTestingOnly.commitReviewed();
    expect(state.committed).toEqual([preview.id]);
    expect(events).toEqual([undefined]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
  });

  it("does not duplicate a pending commit or write its result after rebinding", async () => {
    const pending = Promise.withResolvers<CellHandle>();
    using state = setup({ commit: () => pending.promise });
    await state.element.accessForTestingOnly.prepare();
    const committing = state.element.accessForTestingOnly.commitReviewed();
    await state.element.accessForTestingOnly.commitReviewed();
    const replacement = createMockCellHandle<unknown>(null);
    state.element.result = replacement;
    state.element.willUpdate(new Map([["result", state.result]]));
    pending.resolve(state.released);
    await committing;
    expect(state.committed).toEqual([preview.id]);
    expect(state.result.get()).toBeNull();
    expect(replacement.get()).toBeNull();
  });

  it("does not emit completion when rebinding during the result write", async () => {
    const written = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    using state = setup();
    using write = stub(state.result, "setStrict", () => {
      started.resolve();
      return written.promise;
    });
    const events: Event[] = [];
    state.element.addEventListener("cf-shared", (event) => events.push(event));
    await state.element.accessForTestingOnly.prepare();
    const committing = state.element.accessForTestingOnly.commitReviewed();
    await started.promise;
    state.element.recipient = createMockCellHandle();
    state.element.willUpdate(new Map([["recipient", state.recipient]]));
    written.resolve();
    await committing;
    expect(write.calls).toHaveLength(1);
    expect(events).toEqual([]);
  });

  for (const failure of [new Error("Sharing refused"), "opaque failure"]) {
    it(`reports ${failure instanceof Error ? "host" : "non-Error"} commit failures`, async () => {
      using state = setup({ commit: () => Promise.reject(failure) });
      await state.element.accessForTestingOnly.prepare();
      await state.element.accessForTestingOnly.commitReviewed();
      expect(state.element.accessForTestingOnly.error).toBe(
        failure instanceof Error
          ? failure.message
          : "The snapshot could not be shared.",
      );
      expect(state.element.accessForTestingOnly.preview).toBeUndefined();
      expect(state.result.get()).toBeNull();
    });
  }

  it("reports a refused result write without emitting completion", async () => {
    using state = setup();
    using write = stub(
      state.result,
      "setStrict",
      () => Promise.reject(new Error("Write refused")),
    );
    const events: Event[] = [];
    state.element.addEventListener("cf-shared", (event) => events.push(event));
    await state.element.accessForTestingOnly.prepare();
    await state.element.accessForTestingOnly.commitReviewed();
    expect(write.calls).toHaveLength(1);
    expect(state.element.accessForTestingOnly.error).toBe("Write refused");
    expect(events).toEqual([]);
    expect(state.result.get()).toBeNull();
  });

  it("releases a disconnected review even when cancellation fails", async () => {
    using state = setup({
      cancel: () => Promise.reject(new Error("Connection closed")),
    });
    await state.element.accessForTestingOnly.prepare();
    state.element.connected = false;
    state.element.disconnectedCallback();
    await state.element.accessForTestingOnly.commitReviewed();
    expect(state.canceled).toEqual([preview.id]);
    expect(state.element.accessForTestingOnly.preview).toBeUndefined();
    expect(state.committed).toEqual([]);
  });

  it("ignores a commit failure from an obsolete runtime binding", async () => {
    const pending = Promise.withResolvers<CellHandle>();
    using state = setup({ commit: () => pending.promise });
    await state.element.accessForTestingOnly.prepare();
    const committing = state.element.accessForTestingOnly.commitReviewed();
    state.element.runtime = undefined;
    state.element.willUpdate(new Map([["runtime", state.runtime]]));
    pending.reject(new Error("Obsolete host"));
    await committing;
    expect(state.element.accessForTestingOnly.error).toBe("");
  });

  it("does not publish after an untrusted confirmation event", async () => {
    using state = setup();
    await state.element.accessForTestingOnly.prepare();
    await state.element.accessForTestingOnly.confirm(new Event("click"));
    expect(state.committed).toEqual([]);
    expect(state.result.get()).toBeNull();
  });
});
