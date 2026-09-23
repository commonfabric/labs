import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  DO_RECURSE_KEYS,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  type RecurseForm,
} from "@/value-visit";

describe("value-visit/interface", () => {
  describe("the `DO_*` constants", () => {
    const recurseCases: [string, RecurseForm, boolean, boolean][] = [
      ["DO_RECURSE_KEYS_VALUES", DO_RECURSE_KEYS_VALUES, true, true],
      ["DO_RECURSE_KEYS", DO_RECURSE_KEYS, true, false],
      ["DO_RECURSE_VALUES", DO_RECURSE_VALUES, false, true],
    ];

    for (const [name, form, doKeys, doValues] of recurseCases) {
      it(`makes \`${name}\` a frozen \`recurse\` form with \`doKeys\` ${doKeys} and \`doValues\` ${doValues}`, () => {
        expect(Object.isFrozen(form)).toBe(true);
        expect(form).toEqual({ type: "recurse", doKeys, doValues });
      });
    }
  });
});
