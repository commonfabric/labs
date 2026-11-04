import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  literalToValue,
  parseModule,
} from "../transformed-ast.ts";
import { transformSource } from "../utils.ts";

// What a function does through a value is charged to every tracked ref the
// value may be. These tests pin the values ref resolution has to see through
// to find those refs: a cell method returning the cell it is called on, and a
// fallback or a conditional whose operands are different cells. A write the
// analysis misses there is recorded nowhere, so a handler's schema declares a
// cell it writes `readonly`, and a computed that writes it gets no
// `materializerWriteInputPaths` and never runs to write it.

/**
 * The properties of the event and state schemas the module's one handler
 * emits.
 */
async function handlerProperties(source: string): Promise<{
  event: Record<string, Record<string, unknown>>;
  state: Record<string, Record<string, unknown>>;
}> {
  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const [event, state] = callSchemas(parseModule(output), "handler");
  if (!event || !state) throw new Error("No emitted handler schemas");
  return {
    event: event.properties as Record<string, Record<string, unknown>>,
    state: state.properties as Record<string, Record<string, unknown>>,
  };
}

/** The properties of the state schema the module's one handler emits. */
async function stateProperties(
  source: string,
): Promise<Record<string, Record<string, unknown>>> {
  return (await handlerProperties(source)).state;
}

/**
 * The argument schema's properties and the scheduler options of the module's
 * one computed's lift.
 */
async function computedLift(
  source: string,
): Promise<{
  properties: Record<string, Record<string, unknown>>;
  options: Record<string, unknown>;
}> {
  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const root = parseModule(output);
  const lift = callsNamed(root, "lift").find((call) =>
    call.arguments.length === 4
  );
  if (!lift) throw new Error("No emitted lift with scheduler options");
  const [argument] = callSchemas(root, "lift");
  return {
    properties: argument!.properties as Record<
      string,
      Record<string, unknown>
    >,
    options: literalToValue(lift.arguments[3]!) as Record<string, unknown>,
  };
}

/**
 * The argument schema's properties and the scheduler options, absent when it
 * has none, of the module's only lift.
 */
async function onlyLift(
  source: string,
): Promise<{
  properties: Record<string, Record<string, unknown>>;
  options: Record<string, unknown> | undefined;
}> {
  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const root = parseModule(output);
  const lifts = callsNamed(root, "lift");
  if (lifts.length !== 1) throw new Error(`Emitted ${lifts.length} lifts`);
  const [argument] = callSchemas(root, "lift");
  const options = lifts[0]!.arguments[3];
  return {
    properties: argument!.properties as Record<
      string,
      Record<string, unknown>
    >,
    options: options
      ? literalToValue(options) as Record<string, unknown>
      : undefined,
  };
}

/**
 * The fields of an element of `rows` that the argument schema of the module's
 * only lift keeps.
 */
async function liftRowFields(source: string): Promise<string[]> {
  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const [argument] = callSchemas(parseModule(output), "lift");
  const definitions = argument!.$defs as
    | Record<string, Record<string, unknown>>
    | undefined;
  const resolve = (schema: Record<string, unknown>) =>
    typeof schema.$ref === "string"
      ? definitions![schema.$ref.replace("#/$defs/", "")]!
      : schema;
  const rows = resolve(
    (argument!.properties as Record<string, Record<string, unknown>>).rows!,
  );
  const element = resolve(rows.items as Record<string, unknown>);
  return Object.keys(element.properties as Record<string, unknown>).sort();
}

describe("capability-analysis-value-refs", () => {
  describe("a cell method that returns a cell for its receiver's data", () => {
    it("charges a `.set()` chained onto `.for()` as a write alone", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { count: Writable<number> }>((_, { count }) => {
  count.for("cause").set(5);
});
`);
      expect(state.count!.asCell).toEqual(["writeonly"]);
    });

    it("charges a write through `.key()` after `.for()` to the receiver", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { counts: Writable<number[]> }>(
  (_, { counts }) => {
    counts.for("cause").key(1).set(7);
  },
);
`);
      expect(state.counts!.asCell).toEqual(["writeonly"]);
    });

    it("charges a write through a local bound to `.for()` to the receiver", async () => {
      // Binding a cell to a local is a read of it, as `const t = count` is.
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { count: Writable<number> }>((_, { count }) => {
  const target = count.for("cause");
  target.set(5);
});
`);
      expect(state.count!.asCell).toEqual(["cell"]);
    });

    it("reads through `.for()` only the member read", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
interface Obj { a: number; b: string }
export default handler<void, { obj: Writable<Obj>; out: Writable<number> }>(
  (_, { obj, out }) => {
    out.set(obj.for("cause").key("a").get());
  },
);
`);
      expect(state.obj!.asCell).toEqual(["readonly"]);
      expect(Object.keys(state.obj!.properties as object)).toEqual(["a"]);
    });

    it("charges a write through a local bound to `.resolveAsCell()` to the receiver", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { message: Writable<{ body: string }> }>(
  (_, { message }) => {
    const target = message.resolveAsCell();
    target.set({ body: "deleted" });
  },
);
`);
      expect(state.message!.asCell).toEqual(["cell"]);
    });
  });

  describe("a value that is one of several cells", () => {
    it("charges a write through a fallback to each cell", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<
  void,
  { a: Writable<number> | undefined; b: Writable<number> }
>((_, state) => {
  (state.a ?? state.b).set(5);
});
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["cell"]);
    });

    it("charges a write through a conditional to each cell", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<
  { useA: boolean },
  { a: Writable<number>; b: Writable<number> }
>((event, state) => {
  (event.useA ? state.a : state.b).set(5);
});
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["cell"]);
    });

    it("charges a write through `.key()` on a local bound to a conditional to each cell", async () => {
      // The shape of `sendMessage` in `scoped-group-chat`.
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
interface Room { messages: string[] }
export default handler<
  void,
  { selected: Writable<Room | undefined>; rooms: Writable<Room[]> }
>((_, { selected, rooms }) => {
  const room = selected.get() ? selected : rooms.key(0);
  room.key("messages").push("hello");
});
`);
      expect(state.selected!.asCell).toEqual(["cell"]);
      expect(state.rooms!.asCell).toEqual(["cell"]);
    });

    it("charges a write through a fallback to a fresh cell to the tracked cell alone", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<
  void,
  { a: Writable<number> | undefined; b: Writable<number> }
>((_, state) => {
  (state.a ?? new Writable(0)).set(5);
  state.b.get();
});
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["readonly"]);
    });

    it("charges a write through a `for…of` variable over an array literal to each cell", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { a: Writable<number>; b: Writable<number> }>(
  (_, state) => {
    for (const cell of [state.a, state.b]) cell.set(0);
  },
);
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["cell"]);
    });

    it("charges a write through an element of a local array to each cell pushed into it", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { a: Writable<number>; b: Writable<number> }>(
  (_, state) => {
    const cells: Writable<number>[] = [];
    cells.push(state.a);
    cells.push(state.b);
    for (const cell of cells) cell.set(0);
  },
);
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["cell"]);
    });

    it("reads what the rest of an array literal a `for…of` iterates reads", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { a: Writable<number>; b: Writable<number> }>(
  (_, state) => {
    for (const cell of [state.a, new Writable(state.b.get())]) cell.set(0);
  },
);
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["readonly"]);
    });

    it("charges a write through the element `.find()` returns from an array literal to each cell", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { a: Writable<number>; b: Writable<number> }>(
  (_, state) => {
    const found = [state.a, state.b].find((cell) => cell.get() > 0);
    found?.set(1);
  },
);
`);
      expect(state.a!.asCell).toEqual(["cell"]);
      expect(state.b!.asCell).toEqual(["cell"]);
    });

    it("charges a write through a member of the element `.find()` returns from a local array to the cell put there", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { a: Writable<number> }>((_, state) => {
  const rows: { cell: Writable<number> }[] = [];
  rows.push({ cell: state.a });
  rows.find((row) => !!row)?.cell.set(1);
});
`);
      expect(state.a!.asCell).toEqual(["cell"]);
    });

    it("charges a write through `.resolveAsCell()` on a fallback of an event cell and a state cell to both", async () => {
      const { event, state } = await handlerProperties(`
import { handler, Writable } from "commonfabric";
interface Message { body: string }
export default handler<
  { message?: Writable<Message> },
  { message: Writable<Message> }
>((event, state) => {
  const target = (event.message ?? state.message).resolveAsCell();
  target.set({ body: "deleted" });
});
`);
      expect(event.message!.asCell).toEqual(["cell"]);
      expect(state.message!.asCell).toEqual(["cell"]);
    });
  });

  describe("a computed that writes through a value that is one of several cells", () => {
    it("lists each cell among the paths it writes", async () => {
      const { options } = await computedLift(`
import { computed, pattern, Writable } from "commonfabric";
export default pattern(() => {
  const flag = new Writable<boolean>(true);
  const a = new Writable<number>(0);
  const b = new Writable<number>(0);
  computed(() => {
    (flag.get() ? a : b).set(5);
  });
  return { a, b };
});
`);
      expect(options.materializerWriteInputPaths).toEqual([["a"], ["b"]]);
    });

    it("lists each cell a helper's argument may be among the paths it writes", async () => {
      const { properties, options } = await computedLift(`
import { computed, pattern, Writable } from "commonfabric";
function reset(target: Writable<number>) {
  target.set(0);
}
export default pattern(() => {
  const flag = new Writable<boolean>(true);
  const a = new Writable<number>(1);
  const b = new Writable<number>(1);
  computed(() => {
    reset(flag.get() ? a : b);
  });
  return { a, b };
});
`);
      expect(options.materializerWriteInputPaths).toEqual([["a"], ["b"]]);
      expect(properties.a!.asCell).toEqual(["cell"]);
      expect(properties.b!.asCell).toEqual(["cell"]);
    });

    it("lists the receiver of a write through a local bound to `.for()`", async () => {
      const { options } = await computedLift(`
import { computed, pattern, Writable } from "commonfabric";
export default pattern(() => {
  const obj = new Writable<{ a: number }>({ a: 0 });
  computed(() => {
    const target = obj.for("cause");
    target.key("a").set(5);
  });
  return { obj };
});
`);
      expect(options.materializerWriteInputPaths).toEqual([["obj", "a"]]);
    });
  });

  describe("a conditional that resolves to one cell", () => {
    it("reads what its condition reads when a `for…of` iterates it", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<
  void,
  { flag: Writable<boolean>; items: Writable<number>[]; total: Writable<number> }
>((_, state) => {
  for (const item of state.flag.get() ? state.items : []) {
    state.total.set(item.get());
  }
});
`);
      expect(state.flag!.asCell).toEqual(["readonly"]);
    });

    it("reads what the left of `&&` reads when a `for…of` iterates its right", async () => {
      const { properties } = await onlyLift(`
import { computed, pattern } from "commonfabric";
interface Row { id: number; name: string }
export default pattern<{ enabled: boolean; rows: Row[] }>(({ enabled, rows }) => {
  const names = computed(() => {
    let joined = "";
    for (const row of (enabled && rows) as Row[]) joined += row.name;
    return joined;
  });
  return { names };
});
`);
      expect(Object.keys(properties).sort()).toEqual(["enabled", "rows"]);
    });

    it("reads what its condition reads when a member is read through it", async () => {
      const { properties } = await onlyLift(`
import { computed, pattern } from "commonfabric";
interface Point { x: number; y: number }
export default pattern<{ flag: boolean; point: Point }>(({ flag, point }) => {
  const x = computed(() => (flag ? point : undefined)?.x ?? 0);
  return { x };
});
`);
      expect(Object.keys(properties).sort()).toEqual(["flag", "point"]);
    });

    it("leaves a computed that reads through `.key()` with a key no static path names without a complete scheduler summary", async () => {
      const { options } = await onlyLift(`
import { computed, pattern, Writable } from "commonfabric";
interface Place { replies: number }
export default pattern<{ id?: string; places: Writable<Record<string, Place>> }>(
  ({ id, places }) => {
    const replies = computed(() =>
      (id === undefined ? undefined : places.key(id).get())?.replies ?? 0
    );
    return { replies };
  },
);
`);
      expect(options?.completeSchedulerScopeSummary).toBeUndefined();
    });
  });

  describe("a map a `set` hands back", () => {
    it("keeps every field of a value read through the map the `set` returns", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows }: { rows: Row[] }): string => {
  const byId = new Map<number, Row>();
  const same = byId.set(rows[0]!.id, rows[0]!);
  return same.get(1)?.name ?? "";
});
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });
  });

  describe("a map a `set` whose result is dropped fills", () => {
    it("narrows a value a `forEach` callback's `return` puts in the map to the field read back", async () => {
      // `forEach` drops what its callback returns.

      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows }: { rows: Row[] }): string => {
  const byId = new Map<number, Row>();
  rows.forEach((row) => {
    return byId.set(row.id, row);
  });
  return byId.get(1)?.name ?? "";
});
`);
      expect(fields).toEqual(["id", "name"]);
    });

    it("narrows a value a `set` on the left of a comma puts in the map to the field read back", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows }: { rows: Row[] }): string => {
  const byId = new Map<number, Row>();
  const ids = rows.map((row) => (byId.set(row.id, row), row.id));
  return \`\${ids.length}:\${byId.get(1)?.name ?? ""}\`;
});
`);
      expect(fields).toEqual(["id", "name"]);
    });
  });

  describe("the array an array callback is handed", () => {
    it("reads through it only what the callback reads, for each array a conditional may be", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows, other }: { rows: Row[]; other: Row[] }): Row[] =>
  (rows.length > 0 ? rows : other)
    .filter((row, _, all) => row.name === all[0]!.name)
);
`);
      expect(fields).toEqual(["name"]);
    });

    it("keeps every field of the values either of two array literals of objects holds", async () => {
      // The element is no one ref, so the values leave whole where each
      // literal puts them.

      const output = await transformSource(
        `
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ first, second, enabled }: {
  first: Row;
  second: Row;
  enabled: boolean;
}): string[] =>
  (enabled ? [{ row: first }] : [{ row: second, extra: 1 }])
    .map((entry) => entry.row.name)
);
`,
        { types: COMMONFABRIC_TYPES },
      );
      const [argument] = callSchemas(parseModule(output), "lift");
      const properties = argument!.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties.first).toEqual({ $ref: "#/$defs/Row" });
      expect(properties.second).toEqual({ $ref: "#/$defs/Row" });
    });
  });

  describe("an array literal a spread fills", () => {
    it("keeps every field a later read of a local sorted copy reads", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows }: { rows: Row[] }): string => {
  const copy = [...rows].sort((a, b) => a.id - b.id);
  return copy.map((row) => row.name).join(",");
});
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });

    it("keeps every field of a sorted copy handed to a helper", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
const namesOf = (rows: Row[]) => rows.map((row) => row.name).join(",");
export default lift(({ rows }: { rows: Row[] }): string =>
  namesOf([...rows].sort((a, b) => a.id - b.id))
);
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });

    it("keeps every field of a copy handed to a helper beside a lookup that reads one", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
const namesOf = (rows: Row[]) => rows.map((row) => row.name).join(",");
export default lift(({ rows }: { rows: Row[] }): string => {
  const first = rows.find((row) => row.id === 1);
  return \`\${first?.id}:\${namesOf([...rows])}\`;
});
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });

    it("narrows a builder's returned sorted copy to the fields its comparator reads", async () => {
      // A builder's result is handed on by reference, so whoever reads the
      // copy's elements reads the stored rows whole
      // (`patterns/dev/checks/kept-element-references.test.tsx`).

      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows }: { rows: Row[] }): Row[] =>
  [...rows].sort((a, b) => a.id - b.id)
);
`);
      expect(fields).toEqual(["id"]);
    });

    it("keeps every field of a returned sorted copy a callback passed by name filters", async () => {
      // The callback runs in the builder over the copy's elements, before the
      // result is handed on.

      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
const keep = (row: Row) => row.name === "A";
export default lift(({ rows }: { rows: Row[] }): Row[] =>
  [...rows].sort((a, b) => a.id - b.id).filter(keep)
);
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });

    it("keeps every field of a returned sorted copy a callback passed by name filters through a conditional", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
const keep = (row: Row) => row.name === "A";
export default lift(({ rows, enabled }: { rows: Row[]; enabled: boolean }): Row[] =>
  (enabled ? [...rows].sort((a, b) => a.id - b.id) : []).filter(keep)
);
`);
      expect(fields).toEqual(["id", "name", "note"]);
    });

    it("keeps the field an inline callback reads through elements of a copy or another array", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows, other }: { rows: Row[]; other: Row[] }): Row[] =>
  (rows.length > 0 ? [...rows].sort((a, b) => a.id - b.id) : other)
    .filter((row) => row.name === "A")
);
`);
      expect(fields).toEqual(["id", "name"]);
    });

    it("keeps the elements of a primitive array a shifted copy of it writes back as values", async () => {
      // An element written back by identity becomes a link to the slot it was
      // read from; a number has no identity, and `slice(-3)` moves it to
      // another slot, so the link would name the value now there.

      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { history: Writable<number[]> }>(
  (_, { history }) => {
    const updated = [...history.get(), 1].slice(-3);
    history.set(updated);
  },
);
`);
      expect(state.history!.items).toEqual({ type: "number" });
    });

    it("keeps the elements of a primitive array a shifted copy of it writes back as values through a conditional", async () => {
      // `Array.isArray` types the copy's source `any[]`; the declared type of
      // `history` says its elements are numbers.

      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { history: Writable<number[]> }>(
  (_, { history }) => {
    const current = history.get();
    const list = Array.isArray(current) ? current : [];
    const updated = [...list, 1].slice(-3);
    history.set(updated);
  },
);
`);
      expect(state.history!.items).toEqual({ type: "number" });
    });

    it("keeps the elements of a nullable primitive array a shifted copy of it writes back as values", async () => {
      // `null` has no identity either.

      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { history: Writable<(number | null)[]> }>(
  (_, { history }) => {
    const current = history.get();
    const list = Array.isArray(current) ? current : [];
    const updated = [...list, 1].slice(-3);
    history.set(updated);
  },
);
`);
      expect(state.history!.items).toEqual({
        anyOf: [{ type: "number" }, { type: "null" }],
      });
    });

    it("keeps the elements of an array mixing primitives and objects a shifted copy of it writes back as values", async () => {
      // One element type without identity is enough: the numbers among the
      // objects would otherwise go back as links to the slots they left.

      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { history: Writable<(number | { label: string })[]> }>(
  (_, { history }) => {
    const current = history.get();
    const list = Array.isArray(current) ? current : [];
    const updated = [...list, 1].slice(-3);
    history.set(updated);
  },
);
`);
      expect(state.history!.items).toEqual({
        anyOf: [{ type: "number" }, {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        }],
      });
    });

    it("keeps the elements of a primitive array a prepended copy of it writes back as values", async () => {
      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<void, { history: Writable<number[]> }>(
  (_, { history }) => {
    const updated = [1, ...history.get()];
    history.set(updated);
  },
);
`);
      expect(state.history!.items).toEqual({ type: "number" });
    });

    it("keeps the elements of a primitive array a key picks at run time as values when a shifted copy of it is written back", async () => {
      // No parameter's declared type names the list the key picks, so the
      // copy's own type decides.

      const state = await stateProperties(`
import { handler, Writable } from "commonfabric";
export default handler<
  void,
  { histories: Writable<Record<string, number[]>>; key: Writable<string> }
>((_, { histories, key }) => {
  const updated = [...histories.get()[key.get()]!, 1].slice(-3);
  histories.key(key.get()).set(updated);
});
`);
      expect(state.histories!.additionalProperties).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("keeps the field a destructured callback parameter compares through elements of a copy or another array", async () => {
      const fields = await liftRowFields(`
import { lift } from "commonfabric";
interface Row { id: number; name: string; note: string }
export default lift(({ rows, other }: { rows: Row[]; other: Row[] }): Row[] =>
  (rows.length > 0 ? [...rows].sort((a, b) => a.id - b.id) : other)
    .filter(({ name }) => name === "A")
);
`);
      expect(fields).toEqual(["id", "name"]);
    });

    it("keeps comparing the elements of a copy the body only splices and writes back", async () => {
      const state = await stateProperties(`
import { equals, handler, Writable } from "commonfabric";
interface Row { id: number; name: string }
export default handler<void, { rows: Writable<Row[]>; gone: Writable<Row> }>(
  (_, { rows, gone }) => {
    const list = rows.get();
    const index = list.findIndex((row) => equals(row, gone.get()));
    const copy = [...list];
    copy.splice(index, 1);
    rows.set(copy);
  },
);
`);
      expect(state.rows!.items).toEqual({
        type: "unknown",
        asCell: ["comparable"],
      });
    });

    it("keeps comparing the elements of a copy the body only measures and writes an element into before writing it back", async () => {
      const state = await stateProperties(`
import { equals, handler, Writable } from "commonfabric";
interface Row { id: number; name: string }
export default handler<void, { rows: Writable<Row[]>; gone: Writable<Row> }>(
  (_, { rows, gone }) => {
    const list = rows.get();
    const index = list.findIndex((row) => equals(row, gone.get()));
    const copy = [...list];
    if (index >= 0 && index < copy.length) copy[index] = { id: 0, name: "" };
    rows.set(copy);
  },
);
`);
      expect(state.rows!.items).toEqual({
        type: "unknown",
        asCell: ["comparable"],
      });
    });

    it("keeps every field of a copy the body reads before writing it back", async () => {
      const state = await stateProperties(`
import { equals, handler, Writable } from "commonfabric";
interface Row { id: number; name: string }
export default handler<
  void,
  { rows: Writable<Row[]>; gone: Writable<Row>; names: Writable<string> }
>((_, { rows, gone, names }) => {
  const list = rows.get();
  const index = list.findIndex((row) => equals(row, gone.get()));
  const copy = [...list];
  copy.splice(index, 1);
  names.set(copy.map((row) => row.name).join(","));
  rows.set(copy);
});
`);
      expect(state.rows!.items).toEqual({ $ref: "#/$defs/Row" });
    });
  });
});
