import { Writable, computed, pattern } from "commonfabric";

const KEY = "k";

// FIXTURE: computed-element-access-const-key-optional
// Verifies: an optional chain through an element access with a literal-typed key keeps the capture it reads
//   catalog.get().offers[KEY]?.space and catalog.get().offers?.[KEY]?.space both keep catalog in the lift's input
// Context: Two captures, so a capture whose read went unrecorded would be shrunk out of the lift's input
export default pattern(() => {
  const catalog = new Writable<Record<string, any>>({ offers: {} });
  const n = new Writable<number>(0);

  const optionalMember = computed(() =>
    n.get() === 1 && catalog.get().offers[KEY]?.space === "room"
  );
  const optionalElement = computed(() =>
    n.get() === 1 && catalog.get().offers?.[KEY]?.space === "room"
  );

  return { optionalMember, optionalElement };
});
