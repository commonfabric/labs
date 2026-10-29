import { computed, type Default, pattern } from "commonfabric";

// FIXTURE: default-survives-path-lowering
// Verifies: Default<…> annotations survive PATH-LOWERED captures. A scalar
// property access (`settings.note`) lowers to `settings.key("note")` with a
// leaf type node rebuilt from the checker type, so the injected lift
// capture schema silently dropped `"default"` for years (the
// destructured-binding form `({ note })` preserved the authored node and
// kept its default; the access-chain form did not). The DEFAULT_MARKER
// brand payload carries V through the rebuild and the schema generator
// reads it back from the expanded type.
interface Settings {
  note: Default<string, "n/a">;
  count: Default<number, 3>;
  // Union-VALUED default: `boolean` distributes the brand across true|false,
  // so the expanded type carries two branded members both paying `true`.
  // The payload recovery must agree across them (regression: dropped before).
  enabled: Default<boolean, true>;
}

interface Input {
  settings: Settings;
}

export default pattern<Input>(({ settings }) => {
  const noteIsUnset = computed(() => settings.note === "n/a");
  const countTimesTwo = computed(() => settings.count * 2);
  const isEnabled = computed(() => settings.enabled === true);
  return { noteIsUnset, countTimesTwo, isEnabled };
});
