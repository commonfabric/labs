/**
 * A list mapped through a sub-pattern three times, once in each scope a mapped
 * element can take, for `list-scoped-element-multi-runtime.test.ts`. Each
 * element's instance names what it was made from, and each map has a value
 * derived per session that lists those names.
 */

import {
  computed,
  type Default,
  handler,
  pattern,
  type PerSession,
  type Stream,
  Writable,
} from "commonfabric";

interface ElementInput {
  item: string;
}

interface ElementOutput {
  found: string;
}

/** One element's instance: the item it was made from, named. */
const Element = pattern<ElementInput, ElementOutput>(({ item }) => ({
  found: computed(() => `found:${item}`),
}));

/** Appends an item to the list. */
const add = handler<{ item: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.push(event.item);
  },
);

interface ListInput {
  items?: Writable<Default<string[], []>>;
}

interface ListOutput {
  items: string[];

  /** The names of the elements instantiated for each session. */
  sessionFound: PerSession<string[]>;

  /** The names of the elements instantiated for each user. */
  userFound: PerSession<string[]>;

  /** The names of the elements instantiated once for the space. */
  spaceFound: PerSession<string[]>;

  add: Stream<{ item: string }>;
}

export default pattern<ListInput, ListOutput>(({ items }) => {
  const sessionElements = items.map((item) =>
    Element.asScope("session")({ item })
  );
  const userElements = items.map((item) => Element.asScope("user")({ item }));
  const spaceElements = items.map((item) => Element({ item }));
  const sessionFound = computed((): PerSession<string[]> =>
    sessionElements.map((element) => element.found)
  );
  const userFound = computed((): PerSession<string[]> =>
    userElements.map((element) => element.found)
  );
  const spaceFound = computed((): PerSession<string[]> =>
    spaceElements.map((element) => element.found)
  );
  return { items, sessionFound, userFound, spaceFound, add: add({ items }) };
});
