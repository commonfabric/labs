/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

interface Input {
  note: string;
}

// Ruling Z7. `copy` writes one cell the compiler names, so it is an
// ordinary node, demanded through its write target. Nothing reads `unseen`
// and the result does not hold it, so nothing demands `copy`.
export default pattern<Input>(({ note }) => {
  const unseen = Writable.of("");
  const _copy = computed(() => {
    unseen.set(note);
  });
  return { note };
});
