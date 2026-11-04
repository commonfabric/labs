import { computed, Default, pattern, Writable } from "commonfabric";

export default pattern<{
  values: Writable<string[] | Default<["session-ready"]>>;
}>(({ values }) => {
  const value = computed(() => values.get()[0] ?? "");
  return { value };
});
