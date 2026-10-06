import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveCfcSchemaRefs } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
import { listPieceCallables } from "../lib/piece.ts";

/**
 * One pattern with one verb and three data fields of different shapes — a
 * scalar with a default, a computed number, and an array. Its result type
 * DECLARES the verb, so the verb reaches the listing through the result cell.
 *
 * The listing's classification is exercised against CELLS THE RUNTIME BUILT,
 * because the defect this pins cannot be reproduced against a double: the
 * forced-stream cast asked a cell "are you a stream?" after casting it to one,
 * and a hand-written double answers from whatever the test decided instead of
 * from the cast. Every data field below was reported as a callable handler,
 * with the field's own schema offered as its input schema.
 */
const DECLARED_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, computed, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "",
      "interface Out {",
      "  label: string;",
      "  count: number;",
      "  items: string[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<string[]>([]);",
      "  const label = cell('untitled');",
      "  const add = action((event: AddEvent) => { items.push(event.title); });",
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

/**
 * The same shape as `packages/cli/integration/pattern/main.tsx`: the result
 * type is the argument schema reused, so it describes the piece's DATA and
 * mentions neither verb — while the pattern returns both, and
 * `integration.sh` calls `increment` and asserts the counter moves.
 *
 * Nothing about these two verbs is hidden or unusual; they are simply absent
 * from the type the result cell reads through, so a walk of that cell never
 * proposes their names and never gets as far as classifying them.
 *
 * `hiddenTool` is the same omission for the OTHER kind of callable. A tool is
 * not a stream and is wired to no handler node, so an enumeration keyed on
 * handler nodes cannot propose it however wide it is — and a candidate the
 * declared result type omits arrives with no evidence of its kind except its
 * own stored value, which is what makes classifying it, rather than assuming
 * it, load-bearing.
 */
const UNDECLARED_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { handler, pattern, patternTool, schema } from "commonfabric";',
      'import "commonfabric/schema";',
      "",
      "const model = schema({",
      "  type: 'object',",
      "  properties: {",
      "    value: { type: 'number', default: 0, asCell: ['cell'] },",
      "    stringField: { type: 'string' },",
      "    arrayField: { type: 'array', items: { type: 'number' } },",
      "  },",
      "  default: { value: 0 },",
      "});",
      "",
      "const increment = handler({}, model, (_, state) => {",
      "  state.value.set(state.value.get() + 1);",
      "});",
      "",
      "const decrement = handler({}, model, (_, state) => {",
      "  state.value.set(state.value.get() - 1);",
      "});",
      "",
      "const echo = pattern<{ query: string }, { echoed: string }>(",
      "  ({ query }) => ({ echoed: query }),",
      ");",
      "",
      "export default pattern((cell) => {",
      "  return {",
      "    increment: increment(cell),",
      "    decrement: decrement(cell),",
      "    hiddenTool: patternTool(echo),",
      "    value: cell.value,",
      "    stringField: cell.stringField,",
      "    arrayField: cell.arrayField,",
      "  };",
      "}, model, model);",
    ].join("\n"),
  }],
};

/**
 * Compile and run `program`, then list the callables of the piece it produces.
 *
 * The result cell is narrowed by `getResultCellWithSourceSchema`, which is the
 * one step `PiecesController.getPieceCell` applies before any `cf` command
 * sees a piece: it recovers the pattern's result schema from the cell's own
 * `schema` metadata and reads through it. Handing the lister the unnarrowed
 * cell instead would hide the whole defect, because an unnarrowed `get()`
 * offers every stored key including the ones the result type omits.
 */
async function listLivePiece(
  program: unknown,
  passphrase: string,
  id: string,
): Promise<Awaited<ReturnType<typeof listPieceCallables>>> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      program as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, id, undefined, tx);
    const root = runtime.run(tx, compiled, {}, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await root.pull();

    // The piece surface `listPieceCallables` walks: a result cell read through
    // the pattern's result schema, an empty input cell, the piece root it
    // sweeps for names the walk rejected, and the compiled pattern.
    const result = getResultCellWithSourceSchema(root);
    const emptyInput = runtime.getCell(space, `${id}-input`);
    const piece = {
      result: { getCell: () => Promise.resolve(result) },
      input: { getCell: () => Promise.resolve(emptyInput) },
      getCell: () => result,
      getPattern: () => Promise.resolve(compiled),
    };

    return await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:live",
        space,
      },
      {
        loadPieces: () => Promise.resolve({ getSpace: () => space } as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
  } finally {
    await runtime.dispose?.();
    await storageManager.close?.();
  }
}

describe("listPieceCallables against a live piece", () => {
  it("lists the verb and none of the data fields", async () => {
    const listing = await listLivePiece(
      DECLARED_PROGRAM,
      "piece-verbs-live",
      "listing-live",
    );

    // The pattern declares exactly one verb; every other name is data. The
    // listing must never offer data as callable, and this equality is what
    // fails against a listing that classifies on the forced-stream cast: that
    // cast passes `count`, `items` and `label` too.
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["add"]);
    expect(listing.verbs[0].kind).toBe("handler");
    // The verb's input schema is the event's, not the property's own.
    expect(listing.verbs[0].inputSchema).toMatchObject({
      properties: { title: { type: "string" } },
    });
  });

  it("returns a resolvable author schema for a compiled anonymous event", async () => {
    // The compiler puts `Author` in the result root's `$defs`, while the
    // anonymous event carries a reference to it in a nested property.

    const listing = await listLivePiece(
      {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            'import { action, cell, pattern, Stream } from "commonfabric";',
            "",
            "interface Author { name: string }",
            "interface Out { add: Stream<{ author: Author }> }",
            "",
            "export default pattern<Record<string, never>, Out>(() => {",
            "  const names = cell<string[]>([]);",
            "  const add = action((event: { author: Author }) => {",
            "    names.push(event.author.name);",
            "  });",
            "  return { add };",
            "});",
          ].join("\n"),
        }],
      },
      "piece-verbs-live-inline-event",
      "listing-live-inline-event",
    );

    expect(listing.verbs.map((verb) => verb.name)).toEqual(["add"]);
    const event = listing.verbs[0].inputSchema;
    expect(event).toMatchObject({
      type: "object",
      properties: { author: { $ref: expect.any(String) } },
      required: ["author"],
    });
    if (typeof event !== "object") throw new Error("Expected an event schema");
    const author = event.properties?.author;
    if (typeof author !== "object") {
      throw new Error("Expected an author schema");
    }
    expect(resolveCfcSchemaRefs(author, event)).toMatchObject(
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    );
  });

  it("lists a verb the pattern's declared result type omits", async () => {
    const listing = await listLivePiece(
      UNDECLARED_PROGRAM,
      "piece-verbs-live-undeclared",
      "listing-live-undeclared",
    );

    // Both handlers, the tool, and none of the three data fields. The halves
    // of this equality fail against opposite implementations, which is why
    // they are asserted together: enumerating candidates from the result cell
    // alone loses all three and leaves the listing EMPTY — what a caller sees
    // today on a piece that accepts every one of them — while classifying a
    // candidate on the forced-stream cast rather than on a stored stream adds
    // `arrayField`, `stringField` and `value` back. `hiddenTool` fails a third
    // way: an enumeration that proposes only the properties matching a handler
    // node's `$event` never reaches a tool at all, since a tool compiles to no
    // node and stores no stream.
    expect(listing.verbs.map((verb) => verb.name)).toEqual([
      "decrement",
      "hiddenTool",
      "increment",
    ]);
    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect(byName.get("decrement")?.kind).toBe("handler");
    expect(byName.get("increment")?.kind).toBe("handler");
    // Classified, not assumed: a fallback that hard-codes `"handler"` lists
    // this row with the wrong kind and with a handler's `invoke` command spec,
    // so `cf piece verbs` and `cf piece call` disagree about what it is.
    expect(byName.get("hiddenTool")?.kind).toBe("tool");
    // A tool's input schema rides its own callable cell, so a correctly
    // classified row carries the sub-pattern's arguments; the handler branch
    // of `callableCommandSpec` would offer the cell's own schema instead.
    expect(byName.get("hiddenTool")?.inputSchema).toMatchObject({
      properties: { query: { type: "string" } },
    });
    for (const verb of listing.verbs) {
      // The result cell is where the graph exposes them and where
      // `cf piece call` resolves them, whatever the result TYPE says.
      expect(verb.on).toBe("result");
    }
  });
});
