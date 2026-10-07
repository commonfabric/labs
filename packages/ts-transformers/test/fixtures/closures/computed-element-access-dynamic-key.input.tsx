import { Writable, computed, pattern } from "commonfabric";

const KEY = "k";
const ANY_KEY: string = "k";

// FIXTURE: computed-element-access-dynamic-key
// Verifies: an element access whose key can name any member leaves its `.get()` chain unresolved, so the receiver is read in full
//   catalog.get().offers[key.get()].space, offers[ANY_KEY], offers[String(KEY)], and offers[k] in a map callback each record a full read of catalog
//   items.get()[idx.get()] directly on the `.get()` result reads items in full the same way
// Context: Every lift has at least two captures, so a dropped read would shrink one out
export default pattern(() => {
  const catalog = new Writable<Record<string, any>>({ offers: {} });
  const n = new Writable<number>(0);
  const key = new Writable<string>("k");
  const items = new Writable<number[]>([]);
  const idx = new Writable<number>(0);
  const keys = new Writable<string[]>(["k"]);

  const captureKey = computed(() =>
    n.get() === 1 && catalog.get().offers[key.get()].space === "room"
  );
  const stringTypedKey = computed(() =>
    n.get() === 1 && catalog.get().offers[ANY_KEY].space === "room"
  );
  const callKey = computed(() =>
    n.get() === 1 && catalog.get().offers[String(KEY)].space === "room"
  );
  const callbackParameterKey = computed(() =>
    keys.get().map((k) => n.get() === 1 && catalog.get().offers[k].space)
  );
  const indexOnGetResult = computed(() => n.get() + items.get()[idx.get()]!);

  return { captureKey, stringTypedKey, callKey, callbackParameterKey, indexOnGetResult };
});
