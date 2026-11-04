import { assert, pattern, TESTS, UI, type VNode } from "commonfabric";

export default pattern(() => ({
  // Deliberately not a real VNode at run time: this fixture feeds the runner
  // an invalid continuous-UI value to check how it reports one.
  [UI]: {} as VNode,
  [TESTS]: [{ assertion: assert(() => true) }],
}));
