/** A malformed entry: the run fails before anything runs. */
import { assert, pattern, TESTS } from "commonfabric";

export const llmMocks = [{ txt: "Paris." }];

export default pattern(() => ({
  [TESTS]: [{ assertion: assert(() => 1 === 1) }],
}));
