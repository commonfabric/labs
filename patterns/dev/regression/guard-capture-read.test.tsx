/**
 * A computed that tests the truthiness of a captured value sees the value,
 * whatever the value's type, when that test is all the computed does with it.
 *
 * The test needs only the value's presence, so the transformer keeps it from
 * widening what the computed's other uses of the value retain. With no other
 * use, the value is read for the test, or the computed's input schema leaves
 * it out and the test sees `undefined`. Each case here comes out differently
 * when the test sees `undefined`.
 *
 * Run: deno task cf test patterns/dev/regression/guard-capture-read.test.tsx
 */
import {
  assert,
  computed,
  pattern,
  type PerSession,
  TESTS,
  Writable,
} from "commonfabric";

export default pattern(() => {
  const other = new Writable<number | undefined>(1);
  const scoped = computed((): PerSession<boolean> => other.get() === 1);
  // deno-lint-ignore no-explicit-any
  const loose = computed((): any => ({ ok: true }));
  const text = computed((): string | undefined => "x");
  const record = computed((): { a: number } | undefined => ({ a: 1 }));

  const scopedAnd = computed(() => scoped && other.get() !== undefined ? 1 : 2);
  const looseNot = computed(() => !loose && other.get() !== undefined ? 1 : 2);
  const textCondition = computed(() => text ? other.get() : 2);
  const recordIf = computed(() => {
    if (record) return other.get();
    return 0;
  });

  return {
    [TESTS]: [
      { assertion: assert(() => scopedAnd === 1) },
      { assertion: assert(() => looseNot === 2) },
      { assertion: assert(() => textCondition === 1) },
      { assertion: assert(() => recordIf === 1) },
    ],
  };
});
