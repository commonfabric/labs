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

Deno.test("cf-share-snapshot invalidates confirmation when a bound prop changes", async () => {
  const { element, calls, result } = await mountShare();
  try {
    await element.accessForTestingOnly.prepare();
    element.recipient = createMockCellHandle<unknown>({
      name: "Another reader",
    });
    await element.accessForTestingOnly.confirm(new Event("click"));
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

Deno.test("cf-share-snapshot reports preparation failures", async () => {
  const { element, result } = await mountShare({
    prepareSnapshotShare: () =>
      Promise.reject(new Error("Source is unavailable")),
  });
  try {
    await element.accessForTestingOnly.prepare();
    expect(element.accessForTestingOnly.error).toBe("Source is unavailable");
    expect(result.get()).toBeNull();
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
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
    await element.accessForTestingOnly.confirm(new Event("click"));
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
