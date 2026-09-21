import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFShareSnapshot } from "./index.ts";

Deno.test("cf-share-snapshot presents the exact snapshot and verified audience", async () => {
  const element = document.createElement(
    "cf-share-snapshot",
  ) as CFShareSnapshot;
  element.source = createMockCellHandle<unknown>({
    books: [{ title: "Solaris", author: "Lem" }],
  });
  element.recipient = createMockCellHandle<unknown>({
    name: "Untrusted display name",
  });
  element.result = createMockCellHandle();
  element.runtime = {
    cancelSnapshotShare: () => Promise.resolve(),
    prepareSnapshotShare: () =>
      Promise.resolve({
        id: "preview",
        value: { books: [{ title: "Solaris", author: "Lem" }] },
        audience: {
          type: "https://commonfabric.org/cfc/atom/User",
          subject: "did:key:verified-reader",
        },
      }),
  } as unknown as RuntimeClient;
  document.body.append(element);
  try {
    await element.updateComplete;
    expect(element).toBeInstanceOf(CFShareSnapshot);
    await element.accessForTestingOnly.prepare();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(true);
    expect(element.shadowRoot?.activeElement?.id).toBe("share-title");
    expect(element.shadowRoot?.querySelector("pre")?.textContent).toBe(
      JSON.stringify({ books: [{ title: "Solaris", author: "Lem" }] }, null, 2),
    );
    expect(element.shadowRoot?.querySelector(".audience")?.textContent)
      .toContain("did:key:verified-reader");
    expect(element.shadowRoot?.querySelector(".audience")?.textContent).not
      .toContain("Untrusted display name");
  } finally {
    element.remove();
  }
});

/** Creates host UI with independently controlled preparation and commit calls. */
async function mountShare(overrides: Partial<{
  prepareSnapshotShare: RuntimeClient["prepareSnapshotShare"];
  commitSnapshotShare: (id: string) => Promise<CellHandle>;
  cancelSnapshotShare: (id: string) => Promise<void>;
}> = {}) {
  const released = createMockCellHandle<unknown>({ title: "Solaris" }, {
    id: "of:released",
  });
  const result = createMockCellHandle<unknown>(null);
  const element = document.createElement(
    "cf-share-snapshot",
  ) as CFShareSnapshot;
  const calls: string[] = [];
  element.source = createMockCellHandle<unknown>({ title: "Solaris" });
  element.recipient = createMockCellHandle<unknown>({ name: "Reader" });
  element.result = result;
  element.runtime = {
    prepareSnapshotShare: (
      _source: Parameters<RuntimeClient["prepareSnapshotShare"]>[0],
      audience: Parameters<RuntimeClient["prepareSnapshotShare"]>[1],
    ) => {
      calls.push("prepare");
      return Promise.resolve({
        id: "preview",
        value: { title: "Solaris" },
        audience: {
          type: "user" in audience
            ? "https://commonfabric.org/cfc/atom/User"
            : "https://commonfabric.org/cfc/atom/Space",
          subject: "did:key:verified-reader",
        },
      });
    },
    commitSnapshotShare: () => {
      calls.push("commit");
      return Promise.resolve(released);
    },
    cancelSnapshotShare: () => Promise.resolve(),
    ...overrides,
  } as unknown as RuntimeClient;
  document.body.append(element);
  await element.updateComplete;
  return { element, result, released, calls };
}

Deno.test("cf-share-snapshot rejects synthetic confirmation clicks", async () => {
  const { element, calls, result } = await mountShare();
  try {
    await element.accessForTestingOnly.prepare();
    element.shadowRoot?.querySelector<HTMLButtonElement>(".confirm")?.click();
    await element.accessForTestingOnly.confirm(new Event("click"));
    expect(calls).toEqual(["prepare"]);
    expect(result.get()).toBeNull();
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(true);
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot stores the released link before emitting a payload-free event", async () => {
  const { element, result, released, calls } = await mountShare();
  const events: unknown[] = [];
  element.addEventListener("cf-shared", (event) => {
    expect(result.get()).toBe(released);
    events.push((event as CustomEvent).detail);
  });
  try {
    await element.accessForTestingOnly.prepare();
    await element.accessForTestingOnly.commitReviewed();
    expect(calls).toEqual(["prepare", "commit"]);
    expect(result.get()).toBe(released);
    expect(events).toEqual([null]);
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot invalidates confirmation when a bound prop changes", async () => {
  const { element, calls, result } = await mountShare();
  try {
    await element.accessForTestingOnly.prepare();
    element.recipient = createMockCellHandle<unknown>({
      name: "Another reader",
    });
    await element.accessForTestingOnly.commitReviewed();
    await element.updateComplete;
    expect(calls).toEqual(["prepare"]);
    expect(result.get()).toBeNull();
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot ignores a prepared preview after the source changes", async () => {
  const deferred = Promise.withResolvers<
    Awaited<ReturnType<RuntimeClient["prepareSnapshotShare"]>>
  >();
  const { element } = await mountShare({
    prepareSnapshotShare: () => deferred.promise,
  });
  try {
    const preparing = element.accessForTestingOnly.prepare();
    element.source = createMockCellHandle<unknown>({ title: "Changed" });
    deferred.resolve({
      id: "stale",
      value: { title: "Solaris" },
      audience: {
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:key:verified-reader",
      },
    });
    await preparing;
    await element.updateComplete;
    expect(element.accessForTestingOnly.preview).toBeUndefined();
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot does not publish an in-flight result into a new binding", async () => {
  const deferred = Promise.withResolvers<
    ReturnType<typeof createMockCellHandle>
  >();
  const { element, result, released } = await mountShare({
    commitSnapshotShare: () =>
      deferred.promise as ReturnType<RuntimeClient["commitSnapshotShare"]>,
  });
  const replacement = createMockCellHandle<unknown>(null);
  try {
    await element.accessForTestingOnly.prepare();
    const committing = element.accessForTestingOnly.commitReviewed();
    element.result = replacement;
    deferred.resolve(released);
    await committing;
    expect(result.get()).toBeNull();
    expect(replacement.get()).toBeNull();
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot reports preparation and stale snapshot failures", async () => {
  const { element, result } = await mountShare({
    prepareSnapshotShare: () =>
      Promise.reject(new Error("Source is unavailable")),
  });
  try {
    await element.accessForTestingOnly.prepare();
    expect(element.accessForTestingOnly.error).toBe("Source is unavailable");
    element.runtime = {
      cancelSnapshotShare: () => Promise.resolve(),
      prepareSnapshotShare: () =>
        Promise.resolve({
          id: "expired",
          value: { title: "Solaris" },
          audience: {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:verified-reader",
          },
        }),
      commitSnapshotShare: () =>
        Promise.reject(new Error("Snapshot changed; review again")),
    } as unknown as RuntimeClient;
    await element.updateComplete;
    await element.accessForTestingOnly.prepare();
    await element.accessForTestingOnly.commitReviewed();
    expect(result.get()).toBeNull();
    expect(element.accessForTestingOnly.error).toBe(
      "Snapshot changed; review again",
    );
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot prevents duplicate publication while commit is pending", async () => {
  const deferred = Promise.withResolvers<
    ReturnType<typeof createMockCellHandle>
  >();
  let commits = 0;
  const { element, released } = await mountShare({
    commitSnapshotShare: () => {
      commits++;
      return deferred.promise as ReturnType<
        RuntimeClient["commitSnapshotShare"]
      >;
    },
  });
  try {
    await element.accessForTestingOnly.prepare();
    const committing = element.accessForTestingOnly.commitReviewed();
    await element.accessForTestingOnly.commitReviewed();
    expect(commits).toBe(1);
    deferred.resolve(released);
    await committing;
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot prepares a space audience and cancels without publishing", async () => {
  const { element, calls, result } = await mountShare();
  try {
    element.audienceKind = "space";
    await element.updateComplete;
    await element.accessForTestingOnly.prepare();
    expect(element.accessForTestingOnly.preview?.audience).toEqual({
      type: "https://commonfabric.org/cfc/atom/Space",
      subject: "did:key:verified-reader",
    });
    const buttons = Array.from(
      element.shadowRoot?.querySelectorAll("button") ?? [],
    );
    buttons.find((button) => button.textContent === "Cancel")?.click();
    await element.accessForTestingOnly.commitReviewed();
    expect(calls).toEqual(["prepare"]);
    expect(result.get()).toBeNull();
  } finally {
    element.remove();
  }
});

Deno.test("cf-share-snapshot releases a canceled preview and a late disconnected preview", async () => {
  const canceled: string[] = [];
  const deferred = Promise.withResolvers<
    Awaited<ReturnType<RuntimeClient["prepareSnapshotShare"]>>
  >();
  const { element } = await mountShare({
    cancelSnapshotShare: (id) => {
      canceled.push(id);
      return Promise.resolve();
    },
  });
  await element.accessForTestingOnly.prepare();
  element.remove();
  expect(canceled).toEqual(["preview"]);

  const late = await mountShare({
    prepareSnapshotShare: () => deferred.promise,
    cancelSnapshotShare: (id) => {
      canceled.push(id);
      return Promise.resolve();
    },
  });
  const preparing = late.element.accessForTestingOnly.prepare();
  late.element.remove();
  deferred.resolve({
    id: "late",
    value: null,
    audience: {
      type: "https://commonfabric.org/cfc/atom/User",
      subject: "did:key:verified-reader",
    },
  });
  await preparing;
  expect(canceled).toEqual(["preview", "late"]);
});

Deno.test("cf-share-snapshot reports a refused result write without a success event", async () => {
  const { element, result } = await mountShare();
  const events: Event[] = [];
  element.addEventListener("cf-shared", (event) => events.push(event));
  result.setStrict = () => Promise.reject(new Error("Result is read-only"));
  try {
    await element.accessForTestingOnly.prepare();
    await element.accessForTestingOnly.commitReviewed();
    expect(element.accessForTestingOnly.error).toBe("Result is read-only");
    expect(result.get()).toBeNull();
    expect(events).toHaveLength(0);
  } finally {
    element.remove();
  }
});
