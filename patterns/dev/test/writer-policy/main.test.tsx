/// <cts-enable />
/**
 * The named handlers write the room's writer-policied state again and again
 * from one runtime: each append and each re-freeze reads back the envelope
 * the write before it stored, a merged envelope with definition maps of its
 * own and references into another document's.
 */
import { action, assert, computed, pattern, TESTS } from "commonfabric";
import Room from "./main.tsx";

export default pattern(() => {
  const room = Room({});
  const count = computed(() => (room.entries ?? []).length);
  const submitOne = action(() => room.submit.send({ seat: 1 }));
  const submitTwo = action(() => room.submit.send({ seat: 2 }));
  const freezeFirst = action(() => room.freeze.send({ digest: "first" }));
  const freezeSecond = action(() => room.freeze.send({ digest: "second" }));
  return {
    [TESTS]: [
      { action: submitOne },
      { assertion: assert(() => count === 1) },
      { action: submitTwo },
      { assertion: assert(() => count === 2) },
      { assertion: assert(() => room.entries?.[1]?.seat === 2) },
      { action: freezeFirst },
      { assertion: assert(() => room.frozen?.digest === "first") },
      { action: freezeSecond },
      { assertion: assert(() => room.frozen?.digest === "second") },
    ],
  };
});
