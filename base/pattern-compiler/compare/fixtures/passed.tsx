/// <cts-enable />
import { computed, type Confidential, pattern } from "commonfabric";

interface Input {
  secret: Confidential<string, ["alice"]>;
  items: Confidential<string[], ["carol"]>;
}

// Each output is a `computed` whose template is not a `derive`: a slot
// passed on, the membership of a collection, and a constructed value.
export default pattern<Input>(({ secret, items }) => {
  const same = computed(() => secret);
  const count = computed(() => items.length);
  const tagged = computed(() => ({ who: secret, n: 1 }));
  return { same, count, tagged };
});
