import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CyclicResultError } from "../lib/callable.ts";
import {
  deriveSelectedValue,
  parseSelectionFilter,
  parseSelectionProjection,
  parseSelectProjection,
} from "../lib/cell-selection.ts";
import { executePieceCallable } from "../lib/piece.ts";

/**
 * A work item that carries a back-reference: the doubly-linked shape
 * `docs/common/concepts/self-reference.md` documents, reduced to the two
 * fields that close the circle. `addChild` files a child under this item and
 * hands it back, so the returned piece's `parent` is the container and the
 * container's `children` holds the returned piece.
 *
 * Driven against a COMPILED, RUN pattern rather than a hand-built value,
 * because both halves of what is under test are things the runtime constructs
 * and a double would only assert back. The circle has to be a real one — the
 * same object reached from inside itself, through links the runner resolved —
 * and the bound is derived from a declared result the TRANSFORMER lowered,
 * whose recursion is spelled with `$ref`/`$defs` that no hand-written schema
 * would predict.
 *
 * Five verbs, for the answers a readback can give:
 *
 * - `addChild` returns the new item, and its declared result re-enters itself.
 * - `addChildSelf` returns the CONTAINER, so the circle closes through a
 *   collection rather than through a single field.
 * - `addChildLoose` returns the same container behind `unknown`, which
 *   declares a shape that bounds nothing.
 * - `addChildRow` returns the new item behind a COMPACT declaration — two
 *   scalars, re-entering nowhere — which is the shape a verb takes when its
 *   author means the result to be a row rather than the whole piece. Its
 *   circle is at no position that declaration names.
 * - `addChildren` returns an ARRAY of items, which is the one root a
 *   `--filter` can be applied to and so the only way to reach a filtered
 *   readback of a value that closes a circle.
 *
 * One more answer needs no further verb: `addChild` reached on the piece's
 * INPUT cell, under the name `fileUnder`, is a resolution a declared result
 * cannot be keyed to at all. The harness wires that surface up for it.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, type Default, NAME, pattern, type PatternFactory, SELF, type Stream, Writable } from "commonfabric";',
      "",
      "interface AddChildEvent { title: string; }",
      "interface AddChildResult { item: ItemOutput; }",
      "interface ContainerResult { container: ItemOutput; }",
      "interface LooseResult { container: unknown; }",
      "interface ItemRow { title: string; status: string; }",
      "interface RowResult { row: ItemRow; }",
      "interface FinishEvent { note: string; }",
      "interface FinishResult { status: string; note: string; }",
      "",
      "export interface ItemOutput {",
      "  addChildren: Stream<AddChildEvent, ItemOutput[]>;",
      "  addChild: Stream<AddChildEvent, AddChildResult>;",
      "  addChildSelf: Stream<AddChildEvent, ContainerResult>;",
      "  addChildLoose: Stream<AddChildEvent, LooseResult>;",
      "  addChildRow: Stream<AddChildEvent, RowResult>;",
      "  finish: Stream<FinishEvent, FinishResult>;",
      "  [NAME]: string;",
      "  title: string;",
      "  status: string;",
      "  parent: ItemOutput | null;",
      "  children: ItemOutput[];",
      "}",
      "",
      "interface ItemInput {",
      "  title: string | Default<'Untitled'>;",
      "  parent?: ItemOutput | null | Default<null>;",
      "}",
      "",
      "export const Item: PatternFactory<ItemInput, ItemOutput> = pattern<ItemInput, ItemOutput>(",
      "  ({ title, parent, [SELF]: self }) => {",
      "    const status = new Writable('open');",
      "    const children = new Writable<ItemOutput[]>([]);",
      "    const addChild = action<AddChildEvent, AddChildResult>((event) => {",
      "      const item = Item({ title: event.title, parent: self });",
      "      children.push(item);",
      "      return { item };",
      "    });",
      "    const addChildren = action<AddChildEvent, ItemOutput[]>((event) => {",
      "      const item = Item({ title: event.title, parent: self });",
      "      children.push(item);",
      "      return [item];",
      "    });",
      "    const addChildSelf = action<AddChildEvent, ContainerResult>((event) => {",
      "      children.push(Item({ title: event.title, parent: self }));",
      "      return { container: self };",
      "    });",
      "    const addChildLoose = action<AddChildEvent, LooseResult>((event) => {",
      "      children.push(Item({ title: event.title, parent: self }));",
      "      return { container: self as unknown };",
      "    });",
      "    const addChildRow = action<AddChildEvent, RowResult>((event) => {",
      "      const item = Item({ title: event.title, parent: self });",
      "      children.push(item);",
      "      return { row: item };",
      "    });",
      "    const finish = action<FinishEvent, FinishResult>((event) => {",
      "      status.set('done');",
      "      return { status: 'done', note: event.note };",
      "    });",
      "    return {",
      "      [NAME]: title,",
      "      title,",
      "      status,",
      "      parent,",
      "      children,",
      "      addChildren,",
      "      addChild,",
      "      addChildSelf,",
      "      addChildLoose,",
      "      addChildRow,",
      "      finish,",
      "    };",
      "  },",
      ");",
      "",
      "export default Item;",
    ].join("\n"),
  }],
};

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:live",
  space: "" as string,
};

/** The piece's input cell, carrying one stream. A piece receives streams as
 * arguments, and this is the surface a verb reached there is resolved on. */
const INPUT_CELL_SCHEMA = {
  type: "object",
  properties: { fileUnder: { asCell: ["stream"] } },
} as const satisfies JSONSchema;

interface Tracker {
  /** Dispatch `verb` the way `cf piece call` does, under an invocation id so
   * the outcome is read back off the handling's receipt. */
  call: (
    verb: string,
    rawArgs: string[],
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;

  /** How many times a caller reached for the compiled pattern. The declared
   * result is behind it, so this is what a readback pays to bound itself. */
  patternLoads: () => number;

  root: Cell<any>;
}

/** Run the program above as a root item and hand a driver to `body`. */
async function withTracker<T>(
  passphrase: string,
  body: (tracker: Tracker) => Promise<T>,
): Promise<T> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, "cyclic-live", undefined, tx);
    const root = runtime.run(tx, compiled, { title: "Root" }, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await root.pull();

    // The same stream the pattern put on `addChild`, reached on the piece's
    // INPUT cell under a name the result cell does not carry. `cf piece call`
    // resolves a name on the result cell first, so `fileUnder` is the
    // input-cell resolution — and a declared result is keyed by the PATTERN's
    // result properties, which is why that resolution can match none.
    const inputTx = runtime.edit();
    const inputCell = runtime.getCell(
      space,
      "cyclic-live-input",
      INPUT_CELL_SCHEMA,
      inputTx,
    );
    inputCell.setRaw({ fileUnder: root.key("addChild").getAsLink() } as never);
    runtime.prepareTxForCommit(inputTx);
    expect((await inputTx.commit()).error).toBeUndefined();

    let patternLoads = 0;
    const piece = {
      result: { getCell: () => Promise.resolve(root) },
      input: {
        getCell: () =>
          Promise.resolve(
            runtime.getCell(space, "cyclic-live-input", INPUT_CELL_SCHEMA),
          ),
      },
      getCell: () => root,
      getPattern: () => {
        patternLoads++;
        return Promise.resolve(compiled);
      },
    };
    const deps = {
      loadPieces: () =>
        Promise.resolve({ getSpace: () => space, runtime } as never),
      loadPiece: () => Promise.resolve(piece as never),
    };

    let dispatched = 0;
    return await body({
      root,
      patternLoads: () => patternLoads,
      call: async (verb, rawArgs, extra = {}) => {
        dispatched++;
        const executed = await executePieceCallable(
          { ...CONFIG, space },
          verb,
          rawArgs,
          {
            ...deps,
            invocation: { id: `inv-${dispatched}`, session: "sess" },
            ...extra,
          } as never,
        );
        return executed.invocation?.result;
      },
    });
  } finally {
    await runtime.dispose?.();
    await storageManager.close?.();
  }
}

/** The item titles the root currently files beneath it, read straight off the
 * cell rather than through any rendering, so it says what committed. */
function childTitles(root: Cell<any>): string[] {
  return (root.key("children").get() ?? []).map((child: any) => child.title);
}

describe("cf piece call on a piece that points back at its container", () => {
  it("renders the returned piece, with the back-reference as an address", async () => {
    await withTracker("cyclic-returns-child", async ({ call }) => {
      const result = await call("addChild", [
        "--title",
        "Rotate signing key",
      ]) as any;

      // The whole point: this is what the command writes to stdout, and it
      // used to be the throw.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.item.title).toBe("Rotate signing key");
      expect(result.item.status).toBe("open");
      // `parent` is where the declared type re-enters itself, so it renders an
      // address rather than being followed back into the container. The
      // address names the deepest link the walk crossed plus the segments
      // below it, which is the child's own document and the field on it.
      // One string carries the whole address, so read it back with the
      // parser the CLI's own intake uses. The space and the scope are
      // implicit — the piece is in the space the call targeted, at space
      // scope — and the path is the field that closes the circle.
      const parent = parseLLMFriendlyLink(result.item.parent.$link);
      expect(parent.id?.startsWith("of:")).toBe(true);
      expect(parent.space).toBeUndefined();
      expect(parent.scope).toBeUndefined();
      expect(parent.path).toEqual(["parent"]);
      // A stream is a dispatch surface, not a value, and carries nothing to
      // read at the position it occupies.
      expect(Object.hasOwn(result.item, "addChild")).toBe(false);
    });
  });

  it("returns one address per element for a collection that re-enters", async () => {
    await withTracker("cyclic-returns-container", async ({ call }) => {
      await call("addChildSelf", ["--title", "First"]);
      const result = await call("addChildSelf", ["--title", "Second"]) as any;

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.container.title).toBe("Root");
      // Each child is addressed by its own document rather than by the slot it
      // sits in, so the answers survive a reordering of the collection.
      const ids = result.container.children.map((child: any) =>
        parseLLMFriendlyLink(child.$link).id
      );
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((id: string) => id.startsWith("of:"))).toBe(true);
    });
  });

  it("renders a compact declaration's shape where the circle is past it", async () => {
    await withTracker("cyclic-compact-declaration", async ({ call, root }) => {
      const result = await call("addChildRow", ["--title", "Filed"]) as any;

      // `RowResult` declares two scalars over a value that is a whole piece,
      // so the circle is at `row.parent.children[0]` — a position the
      // declaration does not name and its recursion cannot reach, because it
      // has none. The declaration read as the shape it states is what bounds
      // this: the row comes back, and nothing the row does not declare comes
      // back beside it.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result).toEqual({ row: { title: "Filed", status: "open" } });
      // No address anywhere, and that is the distinction from the recursion
      // bound rather than a detail: nothing here re-enters, so there is no
      // position for a `$link` to stand in for.
      expect(JSON.stringify(result)).not.toContain("$link");
      // And the write landed. A bound is a rendering, so the handling it
      // renders is the same one either way.
      expect(childTitles(root)).toEqual(["Filed"]);
    });
  });

  it("leaves a caller's own shape in charge over a compact declaration", async () => {
    await withTracker("cyclic-compact-selection", async ({ call }) => {
      const result = await call("addChildRow", ["--title", "Named"], {
        selection: { projection: parseSelectProjection("row.title") },
      }) as any;

      // The caller narrowed past the circle, so their shape renders on its own
      // and no bound engages. An implementation that applied the declaration
      // to every result would hand back `status` here, which the caller did
      // not name.
      expect(result).toEqual({ row: { title: "Named" } });
    });
  });

  //
  // A selection that asks for an address and keeps a circle
  //
  // The pair here asks for an ADDRESS at one position and keeps the circle at
  // another. The address is the caller's whole answer where they asked for it,
  // and a bound that closed the object over the declared fields instead would
  // answer `{}` there — contents where an address was asked for, which reads as
  // a successful answer to a question nobody asked. Both bounds reach that
  // position, so both halves are here.
  //

  it("keeps an address the caller asked for while the shape bounds the rest", async () => {
    await withTracker("cyclic-compact-marked", async ({ call }) => {
      const result = await call("addChildRow", ["--title", "Marked"], {
        selection: {
          projection: parseSelectProjection("row@,row.parent"),
        },
      }) as any;

      // `row.parent` is the container, which files the row under `children`,
      // so the caller's own shape still closes a circle and the compact
      // declaration is what bounds it. `row@` is the address of the row, and
      // it survives that bound.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(typeof result.row.$link).toBe("string");
      // The row is a piece of its own, so the deepest link the walk crossed is
      // that piece's document and there is no path below it.
      const row = parseLLMFriendlyLink(result.row.$link);
      expect(row.id?.startsWith("of:")).toBe(true);
      expect(row.path).toEqual([]);
      // `parent` is where the circle was, and the declaration does not name
      // it, so the bound removes it. Nothing the caller did not name comes
      // back in its place.
      expect(Object.keys(result.row)).toEqual(["$link"]);
    });
  });

  it("keeps an address the caller asked for while the recursion bounds the rest", async () => {
    await withTracker("cyclic-container-marked", async ({ call }) => {
      await call("addChildSelf", ["--title", "First"]);
      const result = await call("addChildSelf", ["--title", "Second"], {
        selection: {
          projection: parseSelectProjection("container@,container.children"),
        },
      }) as any;

      // `container.children` holds the pieces that point back at the
      // container, so the caller's shape keeps the circle and the declared
      // recursion cuts it: each child renders its own address. The
      // container's own address is the caller's, and stands beside them.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(typeof result.container.$link).toBe("string");
      expect(parseLLMFriendlyLink(result.container.$link).id?.startsWith("of:"))
        .toBe(true);
      expect(
        result.container.children.map((child: any) =>
          parseLLMFriendlyLink(child.$link).id?.startsWith("of:")
        ),
      ).toEqual([true, true]);
      // And no position the caller did not name: `title` is declared, was not
      // selected, and does not come back.
      expect(Object.keys(result.container).sort()).toEqual([
        "$link",
        "children",
      ]);
    });
  });

  //
  // `item.title` against `item`: narrowing past the circle, or naming it whole
  //
  // The pair below is one contrast, and it is the whole point of both halves:
  // `item.title` narrows PAST the position where the declared type re-enters,
  // so the value it produces holds no circle and nothing derived touches it;
  // `item` names the re-entering subtree WHOLE, so the circle the caller
  // selected is still in the value and the bound has to engage. Both spellings
  // are a selection, and only one of them leaves a readback with nothing to do
  // — a suite holding either alone tests half of that and reads like it tests
  // all of it.
  //

  it("leaves a caller's own selection in charge of the shape", async () => {
    await withTracker("cyclic-explicit-selection", async ({ call }) => {
      const result = await call("addChild", ["--title", "Selected"], {
        selection: { projection: parseSelectProjection("item.title") },
      }) as any;

      // Exactly what was asked for, and only that: the caller's shape narrowed
      // past the circle, so there is nothing for a bound to do and no derived
      // address anywhere. An implementation that bounded every selected result
      // would answer with the declaration's shape here — `status`, `parent`
      // and `children` beside the one field asked for — and fail.
      expect(result).toEqual({ item: { title: "Selected" } });
    });
  });

  it("returns an address at the closing position for a `--select` that keeps the circle", async () => {
    await withTracker("cyclic-selection-retains", async ({ call }) => {
      const result = await call("addChild", ["--title", "Retained"], {
        selection: { projection: parseSelectProjection("item") },
      }) as any;

      // `--select item` selects the whole re-entering subtree, so the value the
      // caller's own shape produces closes the same circle the unshaped
      // readback does. It reaches stdout as JSON either way.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.item.title).toBe("Retained");
      // The closing position renders its address, exactly as it does with no
      // selection at all: this is the declared bound answering.
      expect(
        parseLLMFriendlyLink(result.item.parent.$link).id?.startsWith(
          "of:",
        ),
      ).toBe(true);
      expect(parseLLMFriendlyLink(result.item.parent.$link).path)
        .toEqual(["parent"]);
      // And the answer is the DECLARATION's shape, not the caller's: their
      // shape had no rendering at all, so the one in reach that does answers in
      // its place. A verb's streams are dropped by that derivation and are
      // present in what `--select item` selects on its own, so this is what
      // separates the bound engaging from the raw selection going out.
      expect(Object.hasOwn(result.item, "addChild")).toBe(false);
    });
  });

  //
  // The `--filter` pair
  //
  // A predicate hands back the elements themselves, so it can only keep a
  // circle, never narrow past one. What decides between the two is the
  // projection written beside it.
  //

  it("returns the elements a `--filter` keeps where the projection beside it renders", async () => {
    await withTracker("cyclic-filter-renders", async ({ call }) => {
      const result = await call("addChildren", ["--title", "Kept"], {
        selection: {
          filter: parseSelectionFilter('.title == "Kept"'),
          projection: parseSelectProjection("title"),
        },
      }) as any;

      // The projection beside the predicate narrows past the circle, so the
      // surviving element renders and nothing is derived. An implementation
      // that refused every cyclic-verb `--filter` outright would fail here.
      expect(result).toEqual([{ title: "Kept" }]);
    });
  });

  it("refuses a `--filter` that keeps the circle, naming the committed write", async () => {
    await withTracker(
      "cyclic-filter-retains",
      async ({ call, patternLoads, root }) => {
        const error = await call("addChildren", ["--title", "Filtered"], {
          selection: { filter: parseSelectionFilter('.title == "Filtered"') },
        }).then(() => undefined, (thrown: unknown) => thrown);

        // Without the projection above, the predicate's survivor is the item
        // itself, circle and all. Nothing can bound it: the bound is written in
        // addresses, and the selection step refuses an address beside a
        // `--filter` because a filtered array's elements no longer say which
        // positions they came from. So the answer here is a refusal rather than
        // a bound — and a legible one, rather than the `JSON.stringify` throw
        // an unrenderable result reaches the terminal as, which says nothing
        // about the write.
        expect(error).toBeInstanceOf(CyclicResultError);
        const message = (error as Error).message;
        expect(message).toContain(
          'closes a circle at "/0/parent/children/0/parent"',
        );
        expect(message).toContain(
          "This call's --filter is answered with the elements themselves",
        );
        expect(message).toContain("COMMITTED");
        // Neither of the other two wordings: the declaration is never consulted
        // here, so a refusal claiming it bounds nothing would be a false
        // statement about the verb.
        expect(message).not.toContain("declares no result");
        expect(message).not.toContain("leaves the closing position");
        // And no compiled pattern was loaded to reach that declaration with. A
        // derivation that cannot be applied is not worth a pattern load, which
        // is why the `--filter` is decided before the declaration is reached
        // for.
        expect(patternLoads()).toBe(0);
        // The handling landed, which is what the refusal says and what makes it
        // a rendering failure rather than a failed call.
        expect(childTitles(root)).toEqual(["Filtered"]);
      },
    );
  });

  //
  // When the result will not render, and what that costs
  //
  // A result the command cannot render is refused with the committed write
  // named, and the declaration behind that bound is reached for only where
  // the refusal needs it.
  //

  it("refuses legibly, naming the committed write, where the declaration bounds nothing", async () => {
    await withTracker("cyclic-undeclared", async ({ call, root }) => {
      const error = await call("addChildLoose", ["--title", "Unbounded"])
        .then(() => undefined, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(CyclicResultError);
      const message = (error as Error).message;
      // Where the circle closes, so a caller can see which field to bound.
      expect(message).toContain(
        'closes a circle at "/container/children/0/parent/children"',
      );
      // The property worth not losing: an unrenderable result is not a failed
      // mutation, and the message says so rather than leaving a stack trace to
      // read as "the call failed".
      expect(message).toContain("COMMITTED");
      expect(message).toContain("cf cell get --cell of:");
      expect(message).toContain("declared result leaves the closing position");

      // And the write did land.
      expect(childTitles(root)).toEqual(["Unbounded"]);
    });
  });

  it("refuses a verb it can match no declaration to without consulting a pattern", async () => {
    await withTracker(
      "cyclic-no-declaration",
      async ({ call, patternLoads, root }) => {
        // `fileUnder` is the piece's own `addChild`, reached on the input cell.
        // The dispatch and the circle are identical; what differs is that this
        // resolution carries no declared result to bound the readback with.
        const error = await call("fileUnder", ["--title", "Undeclared"])
          .then(() => undefined, (thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(CyclicResultError);
        const message = (error as Error).message;
        expect(message).toContain(
          "This verb declares no result for `cf` to bound the readback with.",
        );
        // Nothing bounds the readback, so the position named is where the walk
        // itself closes: the returned item, reached again from inside its own
        // container. With a declaration in hand the cut lands at `parent` and
        // the walk never gets this far.
        expect(message).toContain(
          'closes a circle at "/item/parent/children/0/parent"',
        );
        expect(message).toContain("COMMITTED");
        expect(message).toContain("cf cell get --cell of:");
        expect(message).not.toContain("leaves the closing position");
        // No pattern was loaded to look for a declaration, because this
        // resolution attaches no thunk to reach one through.
        expect(patternLoads()).toBe(0);
        // And the handling landed. The refusal is a rendering failure over a
        // write that committed, which is why it is a throw and not an
        // invocation whose `result` is quietly omitted — an omitted `result`
        // reports a verb that returned nothing.
        expect(childTitles(root)).toEqual(["Undeclared"]);
      },
    );
  });

  it("pays for the declared result only where the result will not render", async () => {
    await withTracker(
      "cyclic-pattern-load-cost",
      async ({ call, patternLoads }) => {
        await call("finish", ["--note", "Shipped"]);
        // A result that renders is written out exactly as it was read: nothing
        // is derived, so no compiled pattern is loaded to derive it from.
        expect(patternLoads()).toBe(0);

        await call("addChild", ["--title", "Bounded"]);
        expect(patternLoads()).toBe(1);
      },
    );
  });

  //
  // Miscellaneous cases
  //
  // Cases that belong to none of the groups above.
  //

  it("returns that position alone for a `--select` naming the closing position", async () => {
    await withTracker("cyclic-selection-names-cut", async ({ call }) => {
      const result = await call("addChild", ["--title", "Pointed"], {
        selection: { projection: parseSelectProjection("item.parent") },
      }) as any;

      expect(() => JSON.stringify(result)).not.toThrow();
      // `item.parent` IS the position where the declared type re-enters, so
      // this caller asked for exactly the thing that has no rendering. The
      // address stands in for it, which is the whole of what a bound does.
      expect(
        parseLLMFriendlyLink(result.item.parent.$link).id?.startsWith(
          "of:",
        ),
      ).toBe(true);
      expect(parseLLMFriendlyLink(result.item.parent.$link).path)
        .toEqual(["parent"]);
      // And nothing else comes back. Naming the absent fields is the point: an
      // assertion that only checked `parent` would pass just as well against a
      // bound that answered with the declaration's whole shape, which is a
      // projection handing back MORE than the caller named.
      expect(Object.hasOwn(result.item, "$NAME")).toBe(false);
      expect(Object.hasOwn(result.item, "title")).toBe(false);
      expect(Object.hasOwn(result.item, "status")).toBe(false);
      expect(Object.hasOwn(result.item, "children")).toBe(false);
      expect(Object.keys(result.item)).toEqual(["parent"]);
      expect(Object.keys(result)).toEqual(["item"]);
    });
  });

  it("bounds a readback off the value in hand rather than reading a second one", async () => {
    await withTracker("cyclic-bound-read-cost", async ({ call }) => {
      let reads = 0;
      const counted: typeof deriveSelectedValue = (...args) => {
        reads++;
        return deriveSelectedValue(...args);
      };

      await call("addChild", ["--title", "Unshaped"], {
        deriveSelectedValue: counted,
      });
      // Nothing was asked of the selection step, and the bound is a cut into
      // the value the readback already holds: it runs no pattern graph and
      // commits no transaction, so this call derives nothing at all.
      expect(reads).toBe(0);

      await call("addChild", ["--title", "Shaped"], {
        selection: { projection: parseSelectProjection("item") },
        deriveSelectedValue: counted,
      });
      // Exactly the caller's own read. The bound adds none.
      expect(reads).toBe(1);
    });
  });

  it("returns the same address for a `--schema` projection that keeps the circle", async () => {
    await withTracker("cyclic-schema-retains", async ({ call }) => {
      // The same hole through the other projection spelling. It is a separate
      // grammar rather than an alias — a JSON Schema states its own depth where
      // a concise field list traverses arrays implicitly — so it is driven
      // rather than assumed to follow.
      const result = await call("addChild", ["--title", "Schema"], {
        selection: {
          projection: await parseSelectionProjection(
            '{"properties":{"item":true}}',
          ),
        },
      }) as any;

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.item.title).toBe("Schema");
      expect(parseLLMFriendlyLink(result.item.parent.$link).path)
        .toEqual(["parent"]);
    });
  });
});
