import { Writable, computed, pattern } from "commonfabric";

const KEY = "k";

type Catalog = {
  offers: { k: { space: string; size: number }; other: { space: string } };
  meta: { x: number };
};

// FIXTURE: computed-element-access-const-key
// Verifies: an element access whose key has a literal type is a static path segment, so a capture read through one is kept and shrunk to that path
//   computed(() => n.get() === 1 && catalog.get().offers[KEY].space === "room") → lift<{ n; catalog: { offers: { k: { space } } } }>
//   `offers[KEY]` with `const KEY = "k"` shrinks catalog exactly as `offers.k` and `offers["k"]` do, and a lone capture reads the same way
// Context: Two captures, one read through `[KEY]`; the dot and string-literal keys are the controls; `size`, `other` and `meta` go unread
export default pattern(() => {
  const catalog = new Writable<Catalog>({
    offers: { k: { space: "", size: 0 }, other: { space: "" } },
    meta: { x: 1 },
  });
  const n = new Writable<number>(0);

  const constKey = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY].space === "room"
  );
  const dotKey = computed(() =>
    n.get() === 1 && catalog.get().offers.k.space === "room"
  );
  const literalKey = computed(() =>
    n.get() === 1 && catalog.get().offers["k"].space === "room"
  );
  const loneCapture = computed(() =>
    catalog.get().offers[KEY].space === "room"
  );

  return { constKey, dotKey, literalKey, loneCapture };
});
