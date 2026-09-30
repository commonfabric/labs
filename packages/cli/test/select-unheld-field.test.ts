/**
 * Pins the refusal a `--select`/`--schema` field list gets when it names a
 * field the source schema proves cannot be there: which positions it fires at,
 * the wording a caller reads, and — in equal measure — the positions it passes
 * over, each asserted as the read still returning a value.
 *
 * The gate is `firstUnheldSelectionField` (../lib/cell-selection.ts), reached
 * through `deriveSelectedValue`, which is the path every read flag takes. The
 * root case is driven against a COMPILED, RUN pattern, because the schema a
 * piece is read through is one the transformer emits and a hand-built schema
 * could only assert back what this file assumed. The shapes the transformer
 * does not emit — an open position, a disjunction, a union of scalars — are
 * written out, since a caller reaches them through `handler` schemas and
 * hand-written cells.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
import {
  deriveSelectedValue,
  parseSelectionProjection,
  parseSelectProjection,
} from "../lib/cell-selection.ts";

/**
 * A pattern whose result type names a scalar, a computed number, an array and
 * a verb — the four positions a field list can be pointed at, as the
 * transformer spells them. The verb reaches the result schema as
 * `{asCell: ["stream"], $ref: "#/$defs/AddEvent"}`, which is the shape the
 * stream check has to see through the reference beside it.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, computed, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "",
      "interface Item { title: string; done: boolean; }",
      "",
      "interface Out {",
      "  label: string;",
      "  count: number;",
      "  items: Item[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<Item[]>([{ title: 'First', done: false }]);",
      "  const label = cell('untitled');",
      "  const add = action((event: AddEvent) => {",
      "    items.push({ title: event.title, done: false });",
      "  });",
      "  return {",
      "    label,",
      "    count: computed(() => items.get().length),",
      "    items,",
      "    add,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

const signer = await Identity.fromPassphrase("cf-select-unheld-field");
const space = signer.did();

describe("select-unheld-field", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** The result cell of a live piece, read through the schema the pattern
   * declares — the one narrowing `cf` applies before any command sees it. */
  const livePieceResult = async (id: string): Promise<Cell<unknown>> => {
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const tx = runtime.edit();
    const root = runtime.run(
      tx,
      compiled,
      {},
      runtime.getCell(space, id, undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await root.pull();
    return getResultCellWithSourceSchema(root);
  };

  /** A cell holding `value` under `schema`, which is the source a hand-written
   * shape is read through. */
  const sourceCell = async (
    id: string,
    schema: JSONSchema,
    value: unknown,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, schema, tx);
    cell.set(value as never);
    expect((await tx.commit()).ok).toBeDefined();
    return cell;
  };

  const selected = (source: Cell<unknown>, select: string) =>
    deriveSelectedValue(runtime, space, source, {
      projection: parseSelectProjection(select),
    });

  it("refuses a misspelled field, naming the near miss and the whole vocabulary", async () => {
    const source = await livePieceResult("unheld-root");
    await expect(selected(source, "labl")).rejects.toThrow(
      'Invalid --select at <root>: "labl" is not a field the source holds. ' +
        'Did you mean "label"? <root> declares "label", "count", "items", "add"',
    );
    // A misspelling asked for an address is the same misspelling.
    await expect(selected(source, "labl@")).rejects.toThrow(
      'Invalid --select at <root>: "labl" is not a field the source holds',
    );
  });

  it("refuses a dotted path at the first segment the source cannot hold", async () => {
    const source = await livePieceResult("unheld-dotted");
    await expect(selected(source, "add.v1")).rejects.toThrow(
      'Invalid --select at <root>.add: "v1" is not a field the source holds',
    );
    await expect(selected(source, "bump.v1")).rejects.toThrow(
      'Invalid --select at <root>: "bump" is not a field the source holds',
    );
  });

  it("refuses a field named below a scalar, naming the type the position holds", async () => {
    const source = await livePieceResult("unheld-scalar");
    await expect(selected(source, "label.first")).rejects.toThrow(
      'Invalid --select at <root>.label: "first" is not a field the source ' +
        'holds. <root>.label holds "string", which has no fields',
    );
  });

  it("refuses a field named below a verb, which holds no value to select from", async () => {
    const source = await livePieceResult("unheld-stream");
    await expect(selected(source, "add.title")).rejects.toThrow(
      'Invalid --select at <root>.add: "title" is not a field the source ' +
        "holds. <root>.add is a verb, which dispatches rather than holding a " +
        "value to select from",
    );
  });

  it("refuses a field named below a verb a referenced definition carries", async () => {
    const source = await sourceCell(
      "unheld-referenced-stream",
      {
        type: "object",
        properties: { add: { $ref: "#/$defs/Add" } },
        $defs: {
          Add: {
            asCell: ["stream"],
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
      {},
    );
    await expect(selected(source, "add.title")).rejects.toThrow(
      'Invalid --select at <root>.add: "title" is not a field the source ' +
        "holds. <root>.add is a verb, which dispatches rather than holding a " +
        "value to select from",
    );
  });

  it("crosses an array to name the position an element field was named at", async () => {
    const source = await livePieceResult("unheld-element");
    await expect(selected(source, "items.titel")).rejects.toThrow(
      'Invalid --select at <root>.items[]: "titel" is not a field the source ' +
        'holds. Did you mean "title"? <root>.items[] declares "title", "done"',
    );
    expect(await selected(source, "items.title")).toEqual({
      items: [{ title: "First" }],
    });
  });

  it("reads every field the piece does declare, and the address of one asked for it", async () => {
    const source = await livePieceResult("unheld-declared");
    expect(await selected(source, "label,count")).toEqual({
      label: "untitled",
      count: 1,
    });
    // A marked position names a field without descending into it, so nothing
    // below it is judged — and `@` alone names the read's own source, which is
    // above every field.
    expect(await selected(source, "add@")).toMatchObject({
      add: { $link: expect.any(String) },
    });
    expect(await selected(source, "@")).toMatchObject({
      $link: expect.any(String),
    });
  });

  it("reads a field the source declares nothing about, at a position that admits one", async () => {
    const source = await sourceCell(
      "unheld-open",
      {
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: true,
      },
      { title: "First", extra: "kept" },
    );
    expect(await selected(source, "extra")).toEqual({ extra: "kept" });
  });

  it("reads a field named at a position with no property map at all", async () => {
    const source = await sourceCell(
      "unheld-untyped",
      { type: "object" },
      { title: "First" },
    );
    expect(await selected(source, "title")).toEqual({ title: "First" });
  });

  it("refuses a field named at a position that declares an empty field map", async () => {
    const source = await sourceCell(
      "unheld-empty-map",
      {
        type: "object",
        properties: { holder: { type: "object", properties: {} } },
      },
      { holder: {} },
    );
    await expect(selected(source, "holder.title")).rejects.toThrow(
      'Invalid --select at <root>.holder: "title" is not a field the source ' +
        "holds. <root>.holder declares no fields at all",
    );
  });

  it("reads a field named across an array whose element shape is left open", async () => {
    const source = await sourceCell(
      "unheld-open-array",
      {
        type: "object",
        properties: { items: { type: "array" } },
      },
      { items: [{ title: "First", other: "dropped" }] },
    );
    expect(await selected(source, "items.title")).toEqual({
      items: [{ title: "First" }],
    });
  });

  it("reads a field only a tuple's prefix element declares", async () => {
    const source = await sourceCell(
      "unheld-tuple",
      {
        type: "array",
        prefixItems: [{
          type: "object",
          properties: { title: { type: "string" } },
        }],
        items: { type: "object", properties: { count: { type: "number" } } },
      },
      [{ title: "First" }, { count: 2 }],
    );
    // `items` describes the elements past the prefix, so it is the vocabulary
    // of some elements rather than of all of them.
    expect(await selected(source, "title")).toEqual([{ title: "First" }, {}]);
    expect(await selected(source, "count")).toEqual([{}, { count: 2 }]);
  });

  it("reads a field named across an array whose `items` is a list of schemas", async () => {
    const source = await sourceCell(
      "unheld-draft-07-tuple",
      {
        type: "array",
        items: [
          { type: "object", properties: { title: { type: "string" } } },
          { type: "object", properties: { count: { type: "number" } } },
        ],
      } as never,
      [{ title: "First" }, { count: 2 }],
    );
    // A list of schemas is not a schema, so it states no element vocabulary
    // for the walk to judge a name against — including a name no element
    // declares.
    expect(await selected(source, "nope")).toEqual([{}, {}]);
  });

  it("reads a field named at an untyped position beside an `items` schema", async () => {
    const source = await sourceCell(
      "unheld-untyped-items",
      { items: { type: "object", properties: { title: { type: "string" } } } },
      { extra: "kept" },
    );
    // The position may hold an array and holds an object, so the name belongs
    // to the position itself rather than to an element, and the element
    // schema's vocabulary says nothing about it: the gate passes the name
    // through, and a schema that omits `type` admits the value at any key it
    // names nothing about, in either spelling of the request.
    expect(await selected(source, "extra")).toEqual({ extra: "kept" });
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"type":"object","properties":{"extra":true}}',
        ),
      }),
    ).toEqual({ extra: "kept" });
  });

  it("reads a field named at a position typed as both an array and an object", async () => {
    const source = await sourceCell(
      "unheld-array-or-object",
      {
        type: ["array", "object"],
        items: { type: "object", properties: { title: { type: "string" } } },
      },
      { extra: "kept" },
    );
    expect(await selected(source, "extra")).toEqual({ extra: "kept" });
  });

  it("reads a field named at a position that matches names by pattern", async () => {
    const source = await sourceCell(
      "unheld-pattern-properties",
      {
        type: "object",
        properties: { title: { type: "string" } },
        patternProperties: { "^x-": { type: "string" } },
      },
      { title: "First", "x-trace": "kept" },
    );
    expect(await selected(source, "x-trace")).toEqual({ "x-trace": "kept" });
  });

  it("reads a field named under a disjunction, whose branches need not agree", async () => {
    const source = await sourceCell(
      "unheld-disjunction",
      {
        type: "object",
        properties: {
          holder: {
            anyOf: [
              { type: "object", properties: { title: { type: "string" } } },
              { type: "object", properties: { name: { type: "string" } } },
            ],
          },
        },
      },
      { holder: { name: "Ada" } },
    );
    expect(await selected(source, "holder.name")).toEqual({
      holder: { name: "Ada" },
    });
  });

  it("reads a field named under a union that admits an object", async () => {
    const source = await sourceCell(
      "unheld-union",
      {
        type: "object",
        properties: { holder: { type: ["object", "null"] } },
      },
      { holder: { name: "Ada" } },
    );
    expect(await selected(source, "holder.name")).toEqual({
      holder: { name: "Ada" },
    });
  });

  it("refuses a field named under a union of scalars, which admits no object", async () => {
    const source = await sourceCell(
      "unheld-scalar-union",
      {
        type: "object",
        properties: { title: { type: ["string", "null"] } },
      },
      { title: null },
    );
    await expect(selected(source, "title.first")).rejects.toThrow(
      'Invalid --select at <root>.title: "first" is not a field the source ' +
        'holds. <root>.title holds "string", "null", which has no fields',
    );
  });

  it("reads a field only a conjunction member declares", async () => {
    const source = await sourceCell(
      "unheld-conjunction",
      {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [{
          type: "object",
          properties: { subtitle: { type: "string" } },
        }],
      },
      { title: "First", subtitle: "Second" },
    );
    // A conjunction constrains one value from every member at once, so a field
    // any member declares is a field the position declares, and the gate lets
    // it through. The read reaches it too: traversal evaluates every member
    // and merges what the members produced.
    expect(await selected(source, "subtitle")).toEqual({ subtitle: "Second" });
    await expect(selected(source, "subtitel")).rejects.toThrow(
      'Did you mean "subtitle"? <root> declares "title", "subtitle"',
    );
  });

  it("reads a field a referenced definition declares, and refuses one it does not", async () => {
    const source = await sourceCell(
      "unheld-reference",
      {
        type: "object",
        properties: { holder: { $ref: "#/$defs/Holder" } },
        $defs: {
          Holder: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
      { holder: { title: "First" } },
    );
    expect(await selected(source, "holder.title")).toEqual({
      holder: { title: "First" },
    });
    await expect(selected(source, "holder.titel")).rejects.toThrow(
      'Invalid --select at <root>.holder: "titel" is not a field the source ' +
        'holds. Did you mean "title"? <root>.holder declares "title"',
    );
  });

  it("reads a field named at a reference site that declares fields of its own", async () => {
    const source = await sourceCell(
      "unheld-reference-site",
      {
        type: "object",
        properties: {
          holder: {
            $ref: "#/$defs/Holder",
            properties: { extra: { type: "string" } },
          },
        },
        $defs: {
          Holder: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
      { holder: { title: "First", extra: "beside" } },
    );
    // The read draws on both accounts of the position, so neither is the
    // vocabulary a refusal could name.
    expect(await selected(source, "holder.title")).toEqual({
      holder: { title: "First" },
    });
    expect(await selected(source, "holder.extra")).toEqual({
      holder: { extra: "beside" },
    });
  });

  it("names no unheld field where the source's own reference does not resolve", async () => {
    const source = await sourceCell(
      "unheld-unresolved-reference",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          holder: { $ref: "#/$defs/Missing" },
        },
      },
      { title: "First" },
    );
    // The position is passed over rather than refused, so what the caller
    // reads is the source schema's own problem, named as that.
    await expect(selected(source, "holder.title")).rejects.toThrow(
      "Could not resolve source schema reference for --select",
    );
  });

  it("reads a field two accounts of one position both declare", async () => {
    const source = await sourceCell(
      "unheld-twice-declared",
      {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [{
          type: "object",
          properties: { title: { type: "string" } },
        }],
      },
      { title: "First" },
    );
    // Which account governs what sits below `title` is unsettled, so nothing
    // below it is judged.
    expect(await selected(source, "title.first")).toEqual({ title: "First" });
  });

  it("reads a field a JSON `--schema` names, which states a shape rather than naming the source's", async () => {
    const source = await sourceCell(
      "unheld-json-schema",
      {
        type: "object",
        properties: { title: { type: "string" } },
      },
      { title: "First" },
    );
    await expect(
      deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("extra"),
      }),
    ).rejects.toThrow(
      'Invalid --schema at <root>: "extra" is not a field the source holds',
    );
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"type":"object","properties":{"title":true}}',
        ),
      }),
    ).toEqual({ title: "First" });
  });
});
