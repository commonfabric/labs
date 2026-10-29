import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("write stack trace test operator");
const space = signer.did();

describe("write stack trace", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.setWriteStackTraceMatchers([]);
  });

  afterEach(async () => {
    runtime.setWriteStackTraceMatchers([]);
    await runtime.dispose();
    await storageManager.close();
  });

  it("captures stacks for matched logical write paths", () => {
    runtime.setWriteStackTraceMatchers([{
      space,
      entityId: "doc:root",
      path: [],
      match: "exact",
      label: "root doc write",
    }]);

    function performMatchedWrite() {
      const tx = runtime.edit();
      try {
        tx.writeValueOrThrow(
          {
            space,
            scope: "space",
            id: "doc:root",
            path: [],
          },
          { title: "Hello" },
        );
      } finally {
        tx.abort();
      }
    }

    performMatchedWrite();

    expect(runtime.getWriteStackTrace()).toEqual([{
      recordedAt: expect.any(Number),
      space,
      entityId: "doc:root",
      path: [],
      match: "exact",
      label: "root doc write",
      result: "ok",
      valueKind: "object",
      stack: expect.stringContaining("performMatchedWrite"),
    }]);
  });

  it("propagates write debug context across async runtime edits", async () => {
    runtime.setWriteStackTraceMatchers([{
      space,
      entityId: "doc:async",
      path: [],
      match: "exact",
      label: "async root doc write",
    }]);

    await runtime.withWriteDebugContext("raw:navigateTo", async () => {
      await Promise.resolve();
      const tx = runtime.edit();
      try {
        tx.writeValueOrThrow(
          {
            space,
            scope: "space",
            id: "doc:async",
            path: [],
          },
          { title: "Later" },
        );
      } finally {
        tx.abort();
      }
    });

    expect(runtime.getWriteStackTrace()).toEqual([{
      recordedAt: expect.any(Number),
      space,
      entityId: "doc:async",
      path: [],
      writerActionId: "raw:navigateTo",
      match: "exact",
      label: "async root doc write",
      result: "ok",
      valueKind: "object",
      stack: expect.stringContaining("writeValueOrThrow"),
    }]);
  });

  it("keeps write debug context isolated across overlapping async work", async () => {
    runtime.setWriteStackTraceMatchers([
      {
        space,
        entityId: "doc:first",
        path: [],
        match: "exact",
        label: "first write",
      },
      {
        space,
        entityId: "doc:second",
        path: [],
        match: "exact",
        label: "second write",
      },
    ]);

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const firstWrite = runtime.withWriteDebugContext("raw:first", async () => {
      await firstGate;
      const tx = runtime.edit();
      try {
        tx.writeValueOrThrow(
          {
            space,
            scope: "space",
            id: "doc:first",
            path: [],
          },
          { title: "First" },
        );
      } finally {
        tx.abort();
      }
    });

    const secondWrite = runtime.withWriteDebugContext(
      "raw:second",
      async () => {
        await secondGate;
        const tx = runtime.edit();
        try {
          tx.writeValueOrThrow(
            {
              space,
              scope: "space",
              id: "doc:second",
              path: [],
            },
            { title: "Second" },
          );
        } finally {
          tx.abort();
        }
      },
    );

    releaseFirst();
    await firstWrite;
    releaseSecond();
    await secondWrite;

    expect(runtime.getWriteStackTrace()).toEqual([
      {
        recordedAt: expect.any(Number),
        space,
        entityId: "doc:first",
        path: [],
        writerActionId: "raw:first",
        match: "exact",
        label: "first write",
        result: "ok",
        valueKind: "object",
        stack: expect.stringContaining("writeValueOrThrow"),
      },
      {
        recordedAt: expect.any(Number),
        space,
        entityId: "doc:second",
        path: [],
        writerActionId: "raw:second",
        match: "exact",
        label: "second write",
        result: "ok",
        valueKind: "object",
        stack: expect.stringContaining("writeValueOrThrow"),
      },
    ]);
  });

  it("keeps write trace state isolated per runtime", async () => {
    const secondStorageManager = StorageManager.emulate({ as: signer });
    const secondRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorageManager,
    });

    try {
      runtime.setWriteStackTraceMatchers([{
        space,
        entityId: "doc:primary",
        path: [],
        match: "exact",
        label: "primary write",
      }]);
      secondRuntime.setWriteStackTraceMatchers([{
        space,
        entityId: "doc:secondary",
        path: [],
        match: "exact",
        label: "secondary write",
      }]);

      const firstTx = runtime.edit();
      try {
        firstTx.writeValueOrThrow(
          {
            space,
            scope: "space",
            id: "doc:primary",
            path: [],
          },
          { title: "Primary" },
        );
      } finally {
        firstTx.abort();
      }

      const secondTx = secondRuntime.edit();
      try {
        secondTx.writeValueOrThrow(
          {
            space,
            scope: "space",
            id: "doc:secondary",
            path: [],
          },
          { title: "Secondary" },
        );
      } finally {
        secondTx.abort();
      }

      expect(runtime.getWriteStackTrace().map((entry) => entry.entityId))
        .toEqual([
          "doc:primary",
        ]);
      expect(
        secondRuntime.getWriteStackTrace().map((entry) => entry.entityId),
      ).toEqual(["doc:secondary"]);
    } finally {
      secondRuntime.setWriteStackTraceMatchers([]);
      await secondRuntime.dispose();
      await secondStorageManager.close();
    }
  });
});
