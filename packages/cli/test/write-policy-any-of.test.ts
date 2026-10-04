import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { cf } from "./utils.ts";

describe("write-policy-any-of", () => {
  // The fixture's steps admit each named writer through its own reviewed
  // action and assert that each wrong pairing, a missing gesture, and an
  // unnamed writer leave the note as it was. That runs through the compiled
  // pattern, the renderer-trusted events a step's `trustedUi` sends, and the
  // commit gate, none of which a direct runner test reaches together.

  it("admits each named writer through its own action and refuses the rest", async () => {
    const fixture = resolve(
      import.meta.dirname!,
      "fixtures/write-policy-any-of/two-writers.test.tsx",
    );
    const { code, stdout } = await cf(`test "${fixture}"`);
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/^7 passed, 0 failed \(/m);
  });
});
