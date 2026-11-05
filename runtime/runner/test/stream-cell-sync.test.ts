import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchemaPathSelector } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { declareStreamSchema } from "../src/link-utils.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stream cell sync");
const space = signer.did();

/** The event schema of a handler's stream, as a pattern declares it. */
const eventSchema = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    message: { type: "string" },
  },
} as const satisfies JSONSchema;

describe("stream-cell-sync", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Every selector the space's provider is asked to sync, by document. */
  function recordSelectors(): Map<string, SchemaPathSelector[]> {
    const provider = storageManager.open(space);
    const original = provider.sync.bind(provider);
    const selectors = new Map<string, SchemaPathSelector[]>();
    provider.sync = (uri, selector, scope, instance) => {
      const recorded = selectors.get(uri) ?? [];
      recorded.push(selector ?? { path: [], schema: false });
      selectors.set(uri, recorded);
      return original(uri, selector, scope, instance);
    };
    return selectors;
  }

  it("loads a cell whose schema declares a stream as the whole document", async () => {
    const selectors = recordSelectors();
    const stream = runtime.getCell(
      space,
      "a handler's stream",
      declareStreamSchema(eventSchema),
      tx,
    );

    await stream.sync();

    expect(selectors.get(stream.getAsNormalizedFullLink().id)).toEqual([
      { path: [], schema: false },
    ]);
  });

  it("loads a cell whose schema declares no stream under that schema", async () => {
    const selectors = recordSelectors();
    const value = runtime.getCell(space, "a value", eventSchema, tx);

    await value.sync();

    expect(selectors.get(value.getAsNormalizedFullLink().id)).toEqual([
      { path: [], schema: eventSchema },
    ]);
  });

  it("loads the stream a result pointer is written on as the whole document", async () => {
    // The runtime writes each derived internal cell's `result` meta field at
    // setup, and the write starts a load of the cell's document so a
    // conflict can be retried against it.
    const selectors = recordSelectors();
    const result = runtime.getCell(space, "a piece's result", undefined, tx);
    const stream = runtime.getCell(
      space,
      "a derived internal stream",
      declareStreamSchema(eventSchema),
      tx,
    );

    setResultCell(stream, result);
    await storageManager.synced();

    expect(selectors.get(stream.getAsNormalizedFullLink().id)).toEqual([
      { path: [], schema: false },
    ]);
  });
});
