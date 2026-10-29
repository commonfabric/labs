import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { STUCK_NET_MS } from "@commonfabric/test-support/stuck-net";
import { defer } from "@commonfabric/utils/defer";

import { waitForCellValue } from "../wait-for-cell-value.ts";

/** Supplies cell notifications and quiescence under the test's control. */
function fixture<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: Readonly<T>) => unknown>();
  const runtime = { idle: () => Promise.resolve() } as Runtime;
  const cell = {
    get: () => value,
    getAsNormalizedFullLink: () => ({
      space: "did:key:test-space",
      id: "of:test-member",
      path: ["result"],
      scope: "space",
    }),
    sink: (callback: (value: Readonly<T>) => unknown) => {
      listeners.add(callback);
      callback(value);
      return () => {
        listeners.delete(callback);
      };
    },
  } as unknown as Cell<T>;
  return {
    runtime,
    cell,
    listeners,
    publish(next: T) {
      value = next;
      for (const callback of listeners) callback(value);
    },
  };
}

describe("waitForCellValue()", () => {
  it("returns an accepted arrival and removes its subscription", async () => {
    const f = fixture("pending");
    const checked = defer<void>();
    let returned = false;
    const result = waitForCellValue<string>(f.runtime, f.cell, (value) => {
      checked.resolve();
      return value === "ready";
    }).then((value) => {
      returned = true;
      return value;
    });

    await checked.promise;
    expect(returned).toBe(false);
    expect(f.listeners.size).toBe(1);
    f.publish("ready");
    expect(await result).toBe("ready");
    expect(f.listeners.size).toBe(0);
  });

  it("reports the latest rejected value and address when an arrival is stuck", async () => {
    using time = new FakeTime();
    const f = fixture({ title: "First title", shortName: "1" });
    const checked = defer<void>();
    const updated = defer<void>();
    const result = waitForCellValue<{ title: string; shortName: string }>(
      f.runtime,
      f.cell,
      (value) => {
        checked.resolve();
        if (value?.title === "Wrong title") updated.resolve();
        return value?.title === "Expected title" && value.shortName === "2";
      },
      { stuckLabel: "member publication" },
    ).catch((error: unknown) => error);

    await checked.promise;
    f.publish({ title: "Wrong title", shortName: "2" });
    await updated.promise;
    await time.tickAsync(STUCK_NET_MS);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed wait.");
    expect(error.message).toContain("member publication never arrived");
    expect(error.message).toContain("did:key:test-space");
    expect(error.message).toContain("of:test-member");
    expect(error.message).toContain('"result"');
    expect(error.message).toContain('"Wrong title"');
    expect(error.message).toContain('shortName:"2"');
    expect(error.message).not.toContain("First title");
    expect(error.message).toContain("Expected title");
    expect(error.cause).toBeInstanceOf(Error);
    expect(f.listeners.size).toBe(0);
  });

  it("preserves a predicate error as its cause and reports an undefined value", async () => {
    const f = fixture(undefined);
    const cause = new TypeError("Cannot inspect the member.");
    const error = await waitForCellValue(f.runtime, f.cell, () => {
      throw cause;
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed wait.");
    expect(error.name).toBe("TypeError");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("Cannot inspect the member.");
    expect(error.message).toContain(
      "Last read value (rendered at failure): `undefined`",
    );
    expect(f.listeners.size).toBe(0);
  });

  it("distinguishes a failed first read from an undefined value", async () => {
    const f = fixture(undefined);
    const cause = new DOMException("Cannot read the cell.", "AbortError");
    using _get = stub(f.cell, "get", () => {
      throw cause;
    });
    const error = await waitForCellValue(f.runtime, f.cell, () => true).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed wait.");
    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("Cannot read the cell.");
    expect(error.message).toContain(
      "Last read value (rendered at failure): <not read>",
    );
    expect(f.listeners.size).toBe(0);
  });

  it("uses the default error name for a thrown value that is not an Error", async () => {
    const f = fixture(undefined);
    const cause = "Cannot inspect the member.";
    const error = await waitForCellValue(f.runtime, f.cell, () => {
      throw cause;
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed wait.");
    expect(error.name).toBe("Error");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain(cause);
    expect(f.listeners.size).toBe(0);
  });

  it("renders the contents of a runtime cell with bounded detail", async () => {
    const signer = await Identity.fromPassphrase("cell-wait-diagnostics");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const value = {
        title: "Observed title",
        shortName: "2",
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [
            `detail${index}`,
            "x".repeat(200),
          ]),
        ),
        last: "Beyond the cut",
      };
      const cell = runtime.getCell<typeof value>(signer.did(), "member");
      await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set(value);
      });

      const error = await waitForCellValue(runtime, cell, () => {
        throw new Error("Inspect this member.");
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected a failed wait.");
      expect(error.message).toContain('title:"Observed title"');
      expect(error.message).toContain('shortName:"2"');
      expect(error.message).not.toContain("Beyond the cut");
      const rendered = error.message.split(
        "Last read value (rendered at failure): ",
      )[1];
      // A long rendering is cut to 500 characters, inside its code span.
      expect(rendered.length).toBeLessThanOrEqual(502);
      expect(rendered).toMatch(/\.\.\.`$/);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
