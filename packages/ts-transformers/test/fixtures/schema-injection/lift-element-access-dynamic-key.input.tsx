import { lift, pattern, Writable } from "commonfabric";

const KEY = "k";
const ANY_KEY: string = "k";

type Catalog = {
  offers: Record<string, { space: string }>;
  meta: { x: number };
};

// FIXTURE: lift-element-access-dynamic-key
// Verifies: a module-scope lift keeps an input member it reads through an element access, beside a second member
//   catalog.get().offers[KEY]?.space shrinks catalog to offers, dropping the unread meta
//   catalog.get().offers[ANY_KEY]?.space, whose key can name any member, reads catalog in full
// Context: Explicitly typed lift inputs, as opposed to the closure-extracted computed inputs
const constKey = lift((
  { catalog, n }: { catalog: Writable<Catalog>; n: Writable<number> },
) => n.get() === 1 && catalog.get().offers[KEY]?.space === "room");

const anyKey = lift((
  { catalog, n }: { catalog: Writable<Catalog>; n: Writable<number> },
) => n.get() === 1 && catalog.get().offers[ANY_KEY]?.space === "room");

export default pattern(() => {
  const catalog = new Writable<Catalog>({ offers: {}, meta: { x: 1 } });
  const n = new Writable<number>(0);
  return {
    constKey: constKey({ catalog, n }),
    anyKey: anyKey({ catalog, n }),
  };
});
