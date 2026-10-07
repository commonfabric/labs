/**
 * Computeds and a handler that read a captured cell through an element access
 * — `catalog.get().offers[KEY].space` — beside a second capture. A key of
 * literal type names one member, and a key that can name any member (a cell's
 * value, a `string`) reads the whole cell; either way the read cell has to
 * arrive in the lift's or the handler's input, or the body reads it as
 * `undefined`. A lone capture read the same way is the control.
 *
 * Run: deno task cf test packages/patterns/computed-element-key-captures.test.tsx
 */
import {
  action,
  assert,
  computed,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

type Offers = Record<string, { space: string }>;

const KEY = "k";
const ANY_KEY: string = "k";

const countIfRoom = handler<
  void,
  { catalog: Writable<{ offers: Offers }>; hits: Writable<number> }
>((_, { catalog, hits }) => {
  if (catalog.get().offers[ANY_KEY]?.space === "room") {
    hits.set(hits.get() + 1);
  }
});

export default pattern(() => {
  const catalog = new Writable<{ offers: Offers }>({ offers: {} });
  const n = new Writable<number>(0);
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
  const countHit = countIfRoom({ catalog, hits });

  const fillCatalog = action(() => {
    catalog.set({ offers: { [KEY]: { space: "room" } } });
    n.set(1);
  });

  const assert_lone_capture = assert(() => loneCapture === true);
  const assert_const_key = assert(() => constKey === true);
  const assert_const_key_optional = assert(() => constKeyOptional === true);
  const assert_cell_key = assert(() => cellKey === true);
  const assert_string_key = assert(() => stringKey === true);
  const assert_handler_read = assert(() => hits.get() === 1);

  return {
    [TESTS]: [
      { action: fillCatalog },
      { assertion: assert_lone_capture },
      { assertion: assert_const_key },
      { assertion: assert_const_key_optional },
      { assertion: assert_cell_key },
      { assertion: assert_string_key },
      { action: countHit },
      { assertion: assert_handler_read },
    ],
  };
});
