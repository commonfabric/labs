import { Writable, computed, pattern } from "commonfabric";

const KEY = "k";

// FIXTURE: computed-element-access-const-key
// Verifies: an element access whose key has a literal type is a static path segment, so a capture read through one is kept
//   computed(() => n.get() === 1 && catalog.get().offers[KEY].space === "room") → lift<{ n; catalog }>(...)({ n, catalog })
//   `offers[KEY]` with `const KEY = "k"` records the same path as `offers.k` and `offers["k"]`, and a lone capture reads the same way
// Context: Two captures, one read through `[KEY]`; the dot and string-literal keys are the controls
export default pattern(() => {
  const catalog = new Writable<Record<string, any>>({ offers: {} });
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
