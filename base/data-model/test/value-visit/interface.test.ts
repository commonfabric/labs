import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  type RecurseForm,
} from "@/value-visit";

describe("value-visit/interface", () => {
  describe("the `DO_*` constants", () => {
    const recurseCases: [string, RecurseForm, boolean][] = [
      ["DO_RECURSE_KEYS_VALUES", DO_RECURSE_KEYS_VALUES, true],
      ["DO_RECURSE_VALUES", DO_RECURSE_VALUES, false],
    ];

    for (const [name, form, doKeys] of recurseCases) {
      it(`makes \`${name}\` a frozen \`recurse\` form with \`doKeys\` ${doKeys}`, () => {
        expect(Object.isFrozen(form)).toBe(true);
        expect(form).toStrictEqual({ type: "recurse", doKeys });
      });
    }
  });
});
