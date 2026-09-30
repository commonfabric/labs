/**
 * A builder's input schema is narrowed to the members its body reads. Each
 * builder here reads only `id` off an element and then hands the element on
 * whole — out of its result, through a cell write, on a stream, as a prop of a
 * node it returns. Every one of those stores the element as a link, so the
 * reader on the other side sees the whole row however narrow the sender's
 * schema was. The narrowing leans on that; these cases hold it in place.
 */

import {
  action,
  assert,
  handler,
  lift,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import { propValue, readValue } from "./test/vnode-helpers.ts";

type Source = { id: string; driver: string };
type Index = { sources: Array<Source | undefined> };
type Boxed = { row?: Source; note?: string };

const firstRow = lift(({ index }: { index: Index }): Source | undefined => {
  const first = index.sources.find((s) => !!s?.id);
  return first?.id ? first : undefined;
});

const driverOf = lift(({ row }: { row: Source | undefined }): string =>
  row ? `${row.id}:${row.driver}` : ""
);

const rowNodes = lift(({ index }: { index: Index }) =>
  index.sources.flatMap((s) =>
    // `author` is typed `unknown`, which takes the element without a cast.
    s?.id ? [<cf-cfc-authorship author={s}>{s.id}</cf-cfc-authorship>] : []
  )
);

const setFirst = handler<
  void,
  { index: Index; out: Writable<Source | undefined> }
>((_, { index, out }) => {
  const first = index.sources.find((s) => !!s?.id);
  if (first?.id) out.set(first);
});

const pushFirst = handler<void, { index: Index; list: Writable<Source[]> }>(
  (_, { index, list }) => {
    const first = index.sources.find((s) => !!s?.id);
    if (first?.id) list.push(first);
  },
);

const boxFirst = handler<void, { index: Index; boxed: Writable<Boxed> }>(
  (_, { index, boxed }) => {
    const first = index.sources.find((s) => !!s?.id);
    if (first?.id) boxed.set({ row: first, note: first.id });
  },
);

const updateFirst = handler<void, { index: Index; updated: Writable<Boxed> }>(
  (_, { index, updated }) => {
    const first = index.sources.find((s) => !!s?.id);
    if (first?.id) updated.update({ row: first });
  },
);

const receive = handler<Source, { received: Writable<Source | undefined> }>(
  (event, { received }) => {
    received.set(event);
  },
);

const sendFirst = handler<void, { index: Index; relay: Stream<Source> }>(
  (_, { index, relay }) => {
    const first = index.sources.find((s) => !!s?.id);
    if (first?.id) relay.send(first);
  },
);

/** The `driver` a reader finds under the first returned node's `author`. */
const driverUnderFirstProp = (nodes: unknown): string => {
  const list = readValue(nodes) as unknown[];
  const author = propValue(list?.[0], "author") as
    | { driver?: unknown }
    | undefined;
  return String(readValue(author?.driver));
};

export default pattern(() => {
  const index = new Writable<Index>({
    sources: [undefined, { id: "a", driver: "x" }, { id: "b", driver: "y" }],
  });
  const out = new Writable<Source | undefined>(undefined);
  const list = new Writable<Source[]>([]);
  const boxed = new Writable<Boxed>({});
  const updated = new Writable<Boxed>({ note: "kept" });
  const received = new Writable<Source | undefined>(undefined);

  const driver = driverOf({ row: firstRow({ index }) });
  const nodes = rowNodes({ index });

  const set = setFirst({ index, out });
  const push = pushFirst({ index, list });
  const box = boxFirst({ index, boxed });
  const update = updateFirst({ index, updated });
  const send = sendFirst({ index, relay: receive({ received }) });

  const action_set = action(() => set.send());
  const action_push = action(() => push.send());
  const action_box = action(() => box.send());
  const action_update = action(() => update.send());
  const action_send = action(() => send.send());

  const assert_returned_row_is_whole = assert(() => driver === "a:x");
  const assert_prop_row_is_whole = assert(() =>
    driverUnderFirstProp(nodes) === "x"
  );
  const assert_set_row_is_whole = assert(() => out.get()?.driver === "x");
  const assert_pushed_row_is_whole = assert(() =>
    list.get()[0]?.driver === "x"
  );
  const assert_boxed_row_is_whole = assert(() =>
    boxed.get().row?.driver === "x"
  );
  const assert_updated_row_is_whole = assert(() =>
    updated.get().row?.driver === "x"
  );
  const assert_sent_row_is_whole = assert(() => received.get()?.driver === "x");

  return {
    [TESTS]: [
      { assertion: assert_returned_row_is_whole },
      { assertion: assert_prop_row_is_whole },
      { action: action_set },
      { assertion: assert_set_row_is_whole },
      { action: action_push },
      { assertion: assert_pushed_row_is_whole },
      { action: action_box },
      { assertion: assert_boxed_row_is_whole },
      { action: action_update },
      { assertion: assert_updated_row_is_whole },
      { action: action_send },
      { assertion: assert_sent_row_is_whole },
    ],
    nodes,
  };
});
