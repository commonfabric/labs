/** Exercises receipt selections against a cold replica of a shared store. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type IExtendedStorageTransaction,
  type JSONSchema,
  type MemorySpace,
  Runtime,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  type CallableExecutionDeps,
  type CallableResolution,
  executeResolvedCallable,
} from "../lib/callable.ts";
import {
  parseSelectionFilter,
  parseSelectionProjection,
  parseSelectProjection,
} from "../lib/cell-selection.ts";
import { sendThroughStandIn } from "./utils.ts";

/** Cells seeded on one replica and inspected from another. */
interface Fixture {
  /** The durable outcome supplied by the dispatch double. */
  receipt: Cell<unknown>;

  /** Linked documents whose delivery the test observes. */
  targets: Cell<unknown>[];
}

/** Runs production readback over stored cells; only dispatch is a double. */
async function withReceipt(
  seed: (
    runtime: Runtime,
    space: MemorySpace,
    tx: IExtendedStorageTransaction,
  ) => Fixture,
  check: (
    execute: (deps?: CallableExecutionDeps) => ReturnType<
      typeof executeResolvedCallable
    >,
    received: (cell: Cell<unknown>) => boolean,
    fixture: Fixture,
  ) => Promise<void>,
  declaredResult?: CallableResolution["declaredResult"],
): Promise<void> {
  const signer = await Identity.fromPassphrase("receipt-selection");
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const writerStorage = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const readerStorage = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const errors: string[] = [];
  const writer = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: writerStorage,
  });
  const reader = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: readerStorage,
    errorHandlers: [(error) => errors.push(error.message)],
  });
  try {
    const tx = writer.edit();
    const fixture = seed(writer, signer.did(), tx);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();
    const link = fixture.receipt.getAsNormalizedFullLink();
    const resolution = {
      callableCell: {
        schema: { asCell: ["stream"] },
        send: (_value: unknown, onCommit?: (tx: unknown) => void) => {
          // A same-id collision reads the winner's stored outcome. No handler
          // or derived computation runs on the reader to populate its cache.
          onCommit?.({
            status: () => ({
              status: "error",
              error: Object.assign(new Error("Receipt exists"), {
                precondition: "receipt-exists",
              }),
            }),
            handlingReceiptLink: link,
          });
        },
      },
      callableKind: "handler",
      declaredResult,
      cellKey: "create",
      pieces: { runtime: reader, getSpace: () => signer.did() },
      space: signer.did(),
    } as unknown as CallableResolution;
    await check(
      (deps = {}) =>
        executeResolvedCallable(resolution, {}, {
          sendEvent: sendThroughStandIn,
          invocation: { id: "inv:receipt", session: "ses:receipt" },
          ...deps,
        }),
      (cell) =>
        readerStorage.open(signer.did()).replica.getDocument(
          cell.getAsNormalizedFullLink().id,
        ) !== undefined,
      fixture,
    );
    expect(errors).toEqual([]);
  } finally {
    await reader.dispose();
    await writer.dispose();
    await readerStorage.close();
    await writerStorage.close();
    await server.close();
  }
}

/** Stores a record receipt with cold linked content beneath each field. */
function seedRecord(
  runtime: Runtime,
  space: MemorySpace,
  tx: IExtendedStorageTransaction,
  schema: JSONSchema | undefined = {
    type: "object",
    properties: { topic: true, other: true },
  },
): Fixture {
  const body = runtime.getCell<unknown>(space, "body", undefined, tx);
  body.set("Unselected body");
  const topic = runtime.getCell<unknown>(space, "topic", undefined, tx);
  topic.set({ title: "Stored title", body: body.getAsLink() });
  const other = runtime.getCell<unknown>(space, "other", undefined, tx);
  other.set({ title: "Unselected sibling" });
  const receipt = runtime.getCell<unknown>(space, "receipt", undefined, tx);
  receipt.set({ topic: topic.getAsLink(), other: other.getAsLink() });
  if (schema !== undefined) {
    receipt.setMetaRaw("schema", schema, rawMetaWriteAuthorization);
  }
  return { receipt, targets: [topic, body, other] };
}

describe("piece call receipt selection", () => {
  it("returns a stored child address without delivering that child or its siblings", async () => {
    await withReceipt(seedRecord, async (execute, received, fixture) => {
      const output = await execute({
        selection: { projection: parseSelectProjection("topic@") },
      });
      const topicAddress = `/${
        fixture.targets[0].getAsNormalizedFullLink().id
      }`;
      expect(output.invocation?.deduplicated).toBe(true);
      expect(output.invocation?.result).toEqual({
        topic: { $link: topicAddress },
      });
      expect(received(fixture.receipt)).toBe(true);
      expect(fixture.targets.map(received)).toEqual([false, false, false]);
    });
  });

  it("returns a JSON-schema address selection without delivering the target", async () => {
    await withReceipt(seedRecord, async (execute, received, fixture) => {
      const output = await execute({
        selection: {
          projection: await parseSelectionProjection(
            '{"properties":{"topic":{"$link":true}}}',
          ),
        },
      });
      expect(output.invocation?.result).toEqual({
        topic: { $link: `/${fixture.targets[0].getAsNormalizedFullLink().id}` },
      });
      expect(fixture.targets.map(received)).toEqual([false, false, false]);
    });
  });

  it("returns a selected field from a cold receipt", async () => {
    await withReceipt(seedRecord, async (execute) => {
      const output = await execute({
        selection: { projection: parseSelectProjection("topic.title") },
      });
      expect(output.invocation?.result).toEqual({
        topic: { title: "Stored title" },
      });
    });
  });

  it("returns a caller-selected field outside the verb's declared result", async () => {
    await withReceipt(
      seedRecord,
      async (execute) => {
        const output = await execute({
          selection: { projection: parseSelectProjection("other.title") },
        });
        expect(output.invocation?.result).toEqual({
          other: { title: "Unselected sibling" },
        });
      },
      () =>
        Promise.resolve({
          type: "object",
          properties: {
            topic: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
          additionalProperties: false,
        }),
    );
  });

  it("filters and projects a stored array", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx);
        fixture.receipt.set([
          {
            keep: true,
            title: "Kept",
            details: fixture.targets[0].getAsLink(),
          },
          {
            keep: false,
            title: "Dropped",
            details: fixture.targets[2].getAsLink(),
          },
        ]);
        fixture.receipt.setMetaRaw(
          "schema",
          { type: "array" },
          rawMetaWriteAuthorization,
        );
        return fixture;
      },
      async (execute) => {
        const output = await execute({
          selection: {
            filter: parseSelectionFilter(".keep == true"),
            projection: parseSelectProjection("title"),
          },
        });
        expect(output.invocation?.result).toEqual([{ title: "Kept" }]);
      },
    );
  });

  it("keeps an empty witness absent from the selected invocation result", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx, {
          type: "object",
          properties: {},
        });
        fixture.receipt.set({});
        return fixture;
      },
      async (execute) => {
        const output = await execute({
          selection: { projection: parseSelectProjection("@") },
        });
        expect(output.invocation?.result).toBeUndefined();
      },
    );
  });

  it("collects backing links from the selected result", async () => {
    await withReceipt(seedRecord, async (execute, _received, fixture) => {
      const output = await execute({
        selection: { projection: parseSelectProjection("topic@") },
        showLinks: true,
      });
      expect(output.invocation?.links).toEqual({
        "/": `/${fixture.receipt.getAsNormalizedFullLink().id}`,
        "/topic": `/${fixture.targets[0].getAsNormalizedFullLink().id}`,
      });
    });
  });

  it("reads a legacy receipt whose root shape has no schema", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx);
        fixture.receipt.setMetaRaw(
          "schema",
          undefined,
          rawMetaWriteAuthorization,
        );
        return fixture;
      },
      async (execute, _received, fixture) => {
        const output = await execute({
          selection: { projection: parseSelectProjection("topic@") },
        });
        expect(output.invocation?.result).toEqual({
          topic: {
            $link: `/${fixture.targets[0].getAsNormalizedFullLink().id}`,
          },
        });
      },
    );
  });

  it("materializes a root link before selecting its target", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx);
        fixture.receipt.set(fixture.targets[0].getAsLink());
        fixture.receipt.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        return fixture;
      },
      async (execute, received, fixture) => {
        const output = await execute({
          selection: { projection: parseSelectProjection("title") },
        });
        expect(output.invocation?.result).toEqual({ title: "Stored title" });
        expect(received(fixture.targets[0])).toBe(true);
      },
    );
  });

  it("omits a result when a root link resolves to an absent document", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx);
        const absent = runtime.getCell(space, "absent", undefined, tx);
        fixture.receipt.set(absent.getAsLink());
        fixture.receipt.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        return fixture;
      },
      async (execute) => {
        const output = await execute({
          selection: { projection: parseSelectProjection("@") },
        });
        expect(output.invocation?.result).toBeUndefined();
      },
    );
  });

  it("keeps JSON null distinct from a value-less receipt", async () => {
    await withReceipt(
      (runtime, space, tx) => {
        const fixture = seedRecord(runtime, space, tx);
        fixture.receipt.set(null);
        fixture.receipt.setMetaRaw(
          "schema",
          undefined,
          rawMetaWriteAuthorization,
        );
        return fixture;
      },
      async (execute) => {
        const output = await execute({
          selection: { projection: await parseSelectionProjection("true") },
        });
        expect(output.invocation?.result).toBe(null);
      },
    );
  });
});
