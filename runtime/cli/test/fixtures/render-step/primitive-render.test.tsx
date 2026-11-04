import { assert, pattern, TESTS } from "commonfabric";

export default pattern(() => ({
  [TESTS]: [
    { render: null },
    { render: "text" },
    { render: 1 },
    { render: true },
    { assertion: assert(() => true) },
  ],
}));
