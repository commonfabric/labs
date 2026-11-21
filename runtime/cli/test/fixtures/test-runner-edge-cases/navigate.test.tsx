/**
 * Fixture: an action that navigates to a named pattern instance, so the run
 * records one navigation.
 */

import {
  action,
  assert,
  NAME,
  navigateTo,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

const Target = pattern(() => ({ [NAME]: "Navigation target" }));

export default pattern(() => {
  const went = new Writable(false);
  const go = action(() => {
    went.set(true);
    return navigateTo(Target({}));
  });
  return {
    [TESTS]: [
      { action: go },
      { assertion: assert(() => went.get()) },
    ],
  };
});
