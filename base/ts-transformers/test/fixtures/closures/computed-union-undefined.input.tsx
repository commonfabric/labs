import { Writable, computed, pattern } from "commonfabric";

interface Config {
  required: number;
  unionUndefined: number | undefined;
}

// FIXTURE: computed-union-undefined
// Verifies: captured properties with `number | undefined` union types produce correct schemas
//   computed(() => ...) → lift(...)({ value, config: { required, unionUndefined } })
// Context: `unionUndefined` schema is `type: ["number", "undefined"]`; `required` is plain `number`
export default pattern((config: Config) => {
  const value = new Writable(10);

  const result = computed(() =>
    value.get() + config.required + (config.unionUndefined ?? 0)
  );

  return result;
});
