import { assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const ready = new Writable(false);
  return { ready, [TESTS]: [{ assertion: assert(() => ready.get()) }] };
});
