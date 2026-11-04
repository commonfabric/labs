import { assert, pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [
    { render: [null, undefined, "text", 1, true, false, []] },
    { assertion: assert(() => true) },
  ],
}));
