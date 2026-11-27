import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { linksOf } from "../../src/builder/links-of.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { txToReactivityLog } from "../../src/scheduler.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("links-of");
const space = signer.did();

/** The schema of a row a list links. */
const rowSchema = {
  type: "object",
  properties: { badge: { type: "string" } },
  required: ["badge"],
} as const satisfies JSONSchema;

describe("linksOf()", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let openTxs: IExtendedStorageTransaction[];

  beforeEach(() => {
    openTxs = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    for (const tx of openTxs) tx.abort(new Error("test-only"));
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Calls `linksOf(target)` in a computation's frame. */
  const callIn = (target: unknown) => {
    const tx = runtime.edit();
    openTxs.push(tx);
    const frame = pushFrame({ runtime, tx, space, frameKind: "lift" });
    try {
      return linksOf(target);
    } finally {
      popFrame(frame);
    }
  };

  /**
   * Stores `value` at the document `cause` names, and returns its cell, read
   * under `schema` where one is given.
   */
  const seed = async (cause: string, value: unknown, schema?: JSONSchema) => {
    const cell = runtime.getCell<unknown>(space, cause, schema);
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell;
  };

  const idOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;

  it("returns the cells a list's links name, and a cell at an element holding a value", async () => {
    const first = await seed("first", { title: "first" });
    const second = await seed("second", { title: "second" });
    const list = await seed("list", [
      first.getAsLink(),
      second.getAsLink(),
      "plain",
    ]);

    const cells = callIn(list);

    expect(cells?.map((cell) => idOf(cell))).toEqual([
      idOf(first),
      idOf(second),
      idOf(list),
    ]);
    expect(cells?.[2].getAsNormalizedFullLink().path).toEqual(["2"]);
  });

  it("returns cells that read the values their links name, and the value an element holds", async () => {
    const row = await seed("row", { badge: "" }, rowSchema);
    const list = await seed("list", [row, "plain"]);

    const cells = callIn(list);

    expect(cells?.[0].key("badge").get()).toBe("");
    expect(cells?.[1].get()).toBe("plain");
  });

  it("returns cells that write as the links the list holds", async () => {
    // A cell written into a slot stores its own schema on the link. Each
    // cell has to carry the schema the list's link declares, or a reader of
    // the written link reads the row under a schema the row never had.
    const row = await seed("row", { badge: "" }, rowSchema);
    const list = await seed("list", [row]);
    const copy = runtime.getCell<unknown>(space, "copy");

    const cells = callIn(list) ?? [];
    const tx = runtime.edit();
    copy.withTx(tx).set([...cells]);
    expect((await tx.commit().settled).error).toBeUndefined();

    const linkAt = (cell: Cell<unknown>) => {
      const { id, path, schema } = parseLink(
        (cell.getRaw() as unknown[])[0],
        cell,
      )!;
      return { id, path, schema };
    };
    expect(linkAt(copy)).toEqual(linkAt(list));
  });

  it("reads the list's document and none of the documents its links name", async () => {
    const row = await seed("row", { badge: "" }, rowSchema);
    const chained = await seed("chained", undefined);
    const tx = runtime.edit();
    chained.withTx(tx).setRaw(row.getAsLink());
    expect((await tx.commit().settled).error).toBeUndefined();
    const list = await seed("list", [row, chained]);

    callIn(list);

    const { reads, shallowReads } = txToReactivityLog(openTxs.at(-1)!);
    expect([...new Set([...reads, ...shallowReads].map(({ id }) => id))])
      .toEqual([idOf(list)]);
  });

  it("returns no cells for a target that holds no list, and `undefined` for a target of `undefined`", async () => {
    expect(callIn(await seed("record", { title: "record" }))).toEqual([]);
    expect(callIn(undefined)).toBeUndefined();
  });

  it("throws when called outside a handler or a reactive computation", async () => {
    const list = await seed("list", []);

    expect(() => linksOf(list)).toThrow(
      "`linksOf(target)` can only be called from a handler or a reactive computation.",
    );
  });

  it("throws in a computation whose frame holds no runtime", () => {
    const frame = pushFrame({
      runtime: undefined,
      tx: undefined,
      frameKind: "lift",
    });
    try {
      expect(() => linksOf(undefined)).toThrow(
        "`linksOf(target)` requires an executing runtime.",
      );
    } finally {
      popFrame(frame);
    }
  });
});
