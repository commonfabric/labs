import { Writable, computed, pattern } from "commonfabric";

const ANY_KEY: string = "k";

// FIXTURE: computed-element-access-dynamic-key-fallback
// Verifies: a dynamic-key chain inside a `||` or `??` keeps its capture even when the fallback as a whole resolves by its other operand
//   const v = a.get().p || catalog.get().offers[ANY_KEY].space, and the `??` form, keep catalog in the lift's input
//   the dynamic chain on the left of `||`, and (a.get() ?? catalog.get().offers[ANY_KEY]).p, keep catalog the same way
//   a fallback whose right operand is a static chain, a.get().p || catalog.get().offers.k.space, is the control
// Context: Every lift has three captures, so a dropped read would shrink one out
export default pattern(() => {
  const a = new Writable<{ p: string }>({ p: "" });
  const catalog = new Writable<Record<string, any>>({ offers: {} });
  const n = new Writable<number>(0);

  const orRight = computed(() => {
    const v = a.get().p || catalog.get().offers[ANY_KEY].space;
    return n.get() === 1 && v === "room";
  });
  const nullishRight = computed(() => {
    const v = a.get().p ?? catalog.get().offers[ANY_KEY].space;
    return n.get() === 1 && v === "room";
  });
  const orLeft = computed(() => {
    const v = catalog.get().offers[ANY_KEY].space || a.get().p;
    return n.get() === 1 && v === "room";
  });
  const memberAfterNullish = computed(() =>
    n.get() === 1 && (a.get() ?? catalog.get().offers[ANY_KEY]).p === "room"
  );
  const staticRight = computed(() => {
    const v = a.get().p || catalog.get().offers.k.space;
    return n.get() === 1 && v === "room";
  });

  return { orRight, nullishRight, orLeft, memberAfterNullish, staticRight };
});
