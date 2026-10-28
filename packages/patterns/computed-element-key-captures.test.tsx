/**
 * Computeds, a module-scope lift and a handler that read a captured cell
 * through an element access — `catalog.get().offers[KEY].space` — beside a
 * second capture. A key of literal type names one member, and a key that can
 * name any member (a cell's value, a `string`) reads the whole cell; either
 * way the read cell has to arrive in the lift's or the handler's input, or the
 * body reads it as `undefined`. The same holds for such a chain inside a `||`
 * or `??`. The module-scope lift reads a fixed-key type, so its compiled
 * input keeps only the member the key names, and a schema that kept a
 * different member fails here. A lone capture read the same way is the
 * control.
 *
 * Run: deno task cf test packages/patterns/computed-element-key-captures.test.tsx
 */
import {
  action,
  assert,
  computed,
  handler,
  lift,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

type Offers = Record<string, { space: string }>;
type Catalog = { offers: Offers; meta: { x: number } };
type FixedCatalog = {
  offers: { k: { space: string }; other: { space: string } };
  meta: { x: number };
};

const KEY = "k";
const ANY_KEY: string = "k";

const countIfRoom = handler<
  void,
  { catalog: Writable<Catalog>; hits: Writable<number> }
>((_, { catalog, hits }) => {
  if (catalog.get().offers[ANY_KEY]?.space === "room") {
    hits.set(hits.get() + 1);
  }
});

const typedConstKey = lift((
  { fixed, n }: { fixed: Writable<FixedCatalog>; n: Writable<number> },
) => n.get() === 1 && fixed.get().offers[KEY].space === "room");

export default pattern(() => {
  const catalog = new Writable<Catalog>({ offers: {}, meta: { x: 1 } });
  const n = new Writable<number>(0);
  const a = new Writable<{ p?: string }>({});
  const fixed = new Writable<FixedCatalog>({
    offers: { k: { space: "" }, other: { space: "" } },
    meta: { x: 1 },
  });
  const key = new Writable<string>(KEY);
  const hits = new Writable<number>(0);

  const loneCapture = computed(() =>
    catalog.get().offers[KEY]?.space === "room"
  );
  const constKey = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY]!.space === "room"
  );
  const constKeyOptional = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY]?.space === "room"
  );
  const cellKey = computed(() =>
    n.get() === 1 && catalog.get().offers[key.get()]?.space === "room"
  );
  const stringKey = computed(() =>
    n.get() === 1 && catalog.get().offers[ANY_KEY]?.space === "room"
  );
  const orRight = computed(() => {
    const v = a.get().p || catalog.get().offers[ANY_KEY]?.space;
    return n.get() === 1 && v === "room";
  });
  const nullishRight = computed(() => {
    const v = a.get().p ?? catalog.get().offers[ANY_KEY]?.space;
    return n.get() === 1 && v === "room";
  });
  const orLeft = computed(() => {
    const v = catalog.get().offers[ANY_KEY]?.space || a.get().p;
    return n.get() === 1 && v === "room";
  });
  const moduleLift = typedConstKey({ fixed, n });
  const countHit = countIfRoom({ catalog, hits });

  const fillCatalog = action(() => {
    catalog.set({ offers: { [KEY]: { space: "room" } }, meta: { x: 1 } });
    fixed.set({
      offers: { k: { space: "room" }, other: { space: "" } },
      meta: { x: 1 },
    });
    n.set(1);
  });

  const assert_lone_capture = assert(() => loneCapture === true);
  const assert_const_key = assert(() => constKey === true);
  const assert_const_key_optional = assert(() => constKeyOptional === true);
  const assert_cell_key = assert(() => cellKey === true);
  const assert_string_key = assert(() => stringKey === true);
  const assert_or_right = assert(() => orRight === true);
  const assert_nullish_right = assert(() => nullishRight === true);
  const assert_or_left = assert(() => orLeft === true);
  const assert_module_lift = assert(() => moduleLift === true);
  const assert_handler_read = assert(() => hits.get() === 1);

  return {
    [TESTS]: [
      { action: fillCatalog },
      { assertion: assert_lone_capture },
      { assertion: assert_const_key },
      { assertion: assert_const_key_optional },
      { assertion: assert_cell_key },
      { assertion: assert_string_key },
      { assertion: assert_or_right },
      { assertion: assert_nullish_right },
      { assertion: assert_or_left },
      { assertion: assert_module_lift },
      { action: countHit },
      { assertion: assert_handler_read },
    ],
  };
});
