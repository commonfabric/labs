/**
 * Fixture for the caller-supplied storage host. Writes durable state through a
 * real handler, so a caller reading the store after the run has something the
 * pattern actually reached to find — which is the whole point of the option
 * (the pattern-vintage capture snapshots the store afterwards).
 */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const count = new Writable(0).for("count");
  const bump = action(() => count.set(count.get() + 1));

  return {
    count,
    [TESTS]: [
      { action: bump },
      { action: bump },
      { assertion: assert(() => count.get() === 2) },
    ],
  };
});
