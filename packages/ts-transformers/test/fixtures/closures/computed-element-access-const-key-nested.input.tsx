import { Writable, computed, pattern } from "commonfabric";

const KEY = "k";
const INNER = "j";

// FIXTURE: computed-element-access-const-key-nested
// Verifies: literal-typed element keys compose into one static path in each position they can take
//   offers[KEY][INNER].space → catalog.offers.k.j.space; offers[KEY] with no member after it → catalog.offers.k
//   two captures each read through offers[KEY] are both kept; a typed capture shrinks to offers, dropping the unread meta
// Context: Every lift has two captures, so a dropped read would shrink one out
export default pattern(() => {
  const catalog = new Writable<Record<string, any>>({ offers: {} });
  const other = new Writable<Record<string, any>>({ offers: {} });
  const typed = new Writable<{
    offers: Record<string, { space: string }>;
    meta: { x: number };
  }>({ offers: {}, meta: { x: 1 } });
  const n = new Writable<number>(0);

  const nestedKeys = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY][INNER].space === "room"
  );
  const noMemberAfterKey = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY] !== undefined
  );
  const twoCapturesSameShape = computed(() =>
    catalog.get().offers[KEY].space === other.get().offers[KEY].space
  );
  const typedRecord = computed(() =>
    n.get() === 1 && typed.get().offers[KEY]?.space === "room"
  );

  return { nestedKeys, noMemberAfterKey, twoCapturesSameShape, typedRecord };
});
