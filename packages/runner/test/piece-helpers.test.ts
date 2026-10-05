import { assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getResultCellWithSourceSchema,
  parseCellPath,
  resolveCellPath,
} from "../src/piece-helpers.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("test piece helpers");
const space = signer.did();

interface FakeCell {
  get(): unknown;
  key(segment: string | number): FakeCell;
}

function makeCell(
  value: unknown,
  children: Record<string, FakeCell> = {},
): FakeCell {
  return {
    get() {
      return value;
    },
    key(segment: string | number) {
      // `Object.hasOwn`, not plain indexing: for a segment named after an
      // `Object.prototype` member this stub would otherwise hand back the
      // inherited function instead of "no such child" — the same defect the
      // code under test has, quietly reproduced in the harness.
      const name = String(segment);
      return Object.hasOwn(children, name)
        ? children[name]
        : makeCell(undefined);
    },
  };
}

describe("parseCellPath", () => {
  it("parses slash paths and numeric array indexes", () => {
    assertEquals(parseCellPath("users/0/name"), ["users", 0, "name"]);
    assertEquals(parseCellPath("value/3.14/pi"), ["value", "3.14", "pi"]);
    assertEquals(parseCellPath("values/-1/negative"), [
      "values",
      "-1",
      "negative",
    ]);
    assertEquals(parseCellPath(""), []);
  });

  it("converts only the segments that are canonical array indexes", () => {
    expect(parseCellPath("items/01/1e3/ 1 /4294967295")).toEqual([
      "items",
      "01",
      "1e3",
      " 1 ",
      "4294967295",
    ]);
  });
});

describe("resolveCellPath", () => {
  it("resolves schema-backed child cells when the parent object is sparse", () => {
    const cell = makeCell(undefined, {
      messageCount: makeCell(1),
    });

    assertEquals(resolveCellPath(cell as never, ["messageCount"]), 1);
  });

  it("throws when the requested path is missing", () => {
    const cell = makeCell(undefined);

    assertThrows(
      () => resolveCellPath(cell as never, ["missing"]),
      Error,
      'property "missing" not found',
    );
  });

  it("throws for a missing segment named after an Object.prototype member", () => {
    // `toString` is ordinary data, but membership was tested with `in`, which
    // walks the prototype chain — so an absent segment with that name looked
    // present and this returned `undefined` instead of raising. The
    // `availableKeys` hint in the same error already used `Object.keys`, so
    // the two disagreed about what the record carries.
    //
    // The parent must hold a real object: with a parent of `undefined` the
    // throw comes from the `resolvedValue === undefined` fall-through instead,
    // the membership check is never reached, and this passes whichever
    // operator the source uses.
    const cell = makeCell({ name: "John" }, { name: makeCell("John") });

    assertThrows(
      () => resolveCellPath(cell as never, ["toString"]),
      Error,
      'property "toString" not found',
    );
  });

  it("resolves a segment the record genuinely owns at such a name", () => {
    // The mirror of the above: narrowing membership must not have made a
    // stored value at one of these names unreachable.
    const cell = makeCell({ toString: "stored" }, {
      toString: makeCell("stored"),
    });

    assertEquals(resolveCellPath(cell as never, ["toString"]), "stored");
  });

  it("throws when traversing through a non-object value", () => {
    const cell = makeCell({
      settings: "plain-text",
    }, {
      settings: makeCell("plain-text"),
    });

    assertThrows(
      () => resolveCellPath(cell as never, ["settings", "theme"]),
      Error,
      'encountered non-object at "theme"',
    );
  });
});

describe("resolveCellPath through linked slots", () => {
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

  it("reads a leaf through multiple sparse projections with repeated path segments", () => {
    const raw = runtime.getCell(
      space,
      "nested sparse projection",
      undefined,
      tx,
    );
    raw.set({ value: { value: { value: 7 } } });
    const cell = raw.asSchema({
      type: "object",
      properties: {
        missing: { type: "string" },
        value: {
          type: "object",
          properties: {
            missing: { type: "string" },
            value: {
              type: "object",
              properties: { value: { type: "number" } },
            },
          },
          required: ["missing"],
        },
      },
      required: ["missing"],
    });
    expect(cell.get()).toBeUndefined();
    expect(cell.key("value").get()).toBeUndefined();
    expect(resolveCellPath(cell, ["value", "value", "value"])).toBe(7);
    expect(() => resolveCellPath(cell, ["value", "missing"]))
      .toThrow('property "missing" not found');
    expect(() =>
      resolveCellPath(cell, ["value", "value", "value"], {
        requireProjection: true,
      })
    ).toThrow('property "value" not found');
  });

  it("reads through a cell link at an intermediate segment", () => {
    // The deploy shape that hit this: a piece whose `status` field is a
    // LINK to another cell (`cf piece link`), read back as
    // `status/spaceName`. The leaf already derefs a cell-valued result;
    // an intermediate segment must do the same or the traversal inspects
    // the Cell instance's own JS properties and reports its internals as
    // "available keys".
    const statusCell = runtime.getCell(
      space,
      "linked status source",
      undefined,
      tx,
    );
    statusCell.set({ spaceName: "test-space" });

    const pieceCell = runtime.getCell(
      space,
      "piece with linked status",
      undefined,
      tx,
    );
    pieceCell.set({ status: statusCell });

    assertEquals(
      resolveCellPath(pieceCell as never, ["status", "spaceName"]),
      "test-space",
    );
  });

  it("reads through an asCell-schema slot at an intermediate segment", () => {
    // A piece result whose schema declares the linked field asCell (the
    // Writable<...> output shape) surfaces the slot as a Cell from get():
    // the parent's value then holds a live Cell instance, and traversal
    // must read through it rather than inspecting the Cell's own JS
    // properties (which reports runner internals as "available keys").
    const statusCell = runtime.getCell(
      space,
      "asCell status source",
      undefined,
      tx,
    );
    statusCell.set({ spaceName: "test-space" });

    const pieceCell = runtime.getCell(
      space,
      "piece with asCell status",
      {
        type: "object",
        properties: {
          status: {
            type: "object",
            properties: { spaceName: { type: "string" } },
            asCell: ["cell"],
          },
        },
      } as const,
      tx,
    );
    pieceCell.set({ status: statusCell as never });

    assertEquals(
      resolveCellPath(pieceCell as never, ["status", "spaceName"]),
      "test-space",
    );
  });

  it("still reports non-object traversal through a cell-valued slot", () => {
    // Reading through the cell must not weaken the non-object guard: a
    // linked slot holding a scalar still errors when the path continues.
    const scalarCell = runtime.getCell(
      space,
      "linked scalar source",
      undefined,
      tx,
    );
    scalarCell.set("plain-text");

    const pieceCell = runtime.getCell(
      space,
      "piece with linked scalar",
      undefined,
      tx,
    );
    pieceCell.set({ settings: scalarCell });

    assertThrows(
      () => resolveCellPath(pieceCell as never, ["settings", "theme"]),
      Error,
      'encountered non-object at "theme"',
    );
  });
});

describe("getResultCellWithSourceSchema", () => {
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

  it("uses result schema metadata to annotate child result cells", () => {
    const resultSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: {
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
        },
      },
      required: ["title", "detail"],
    } as const;
    const resultCell = runtime.getCell(
      space,
      "piece helper result schema metadata",
      undefined,
      tx,
    );
    resultCell.setMetaRaw("schema", resultSchema, rawMetaWriteAuthorization);

    const titleCell = getResultCellWithSourceSchema(
      resultCell.key("title"),
    );
    const countCell = getResultCellWithSourceSchema(
      resultCell.key("detail").key("count"),
    );

    assertEquals(titleCell.getAsNormalizedFullLink().schema, {
      type: "string",
    });
    assertEquals(countCell.getAsNormalizedFullLink().schema, {
      type: "number",
    });
  });

  it("keeps an explicit link schema instead of replacing it from metadata", () => {
    const resultSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    } as const;
    const explicitSchema = { type: "number" } as const;
    const resultCell = runtime.getCell(
      space,
      "piece helper explicit schema",
      undefined,
      tx,
    );
    resultCell.setMetaRaw("schema", resultSchema, rawMetaWriteAuthorization);

    const explicitCell = resultCell.key("title").asSchema(explicitSchema);
    const annotated = getResultCellWithSourceSchema(explicitCell);

    assertEquals(annotated.getAsNormalizedFullLink().schema, explicitSchema);
  });
});
