import { assert, pattern, TESTS } from "commonfabric";

export const readBudgets = {};
export default pattern(() => ({
  [TESTS]: [{ assertion: assert(() => false) }],
}));
