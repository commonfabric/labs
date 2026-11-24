import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { INBOX_ADOPTION_REFUSALS } from "@commonfabric/piece/ops";
import { refusalReasonText } from "./private-inbox-refusal-text.ts";

describe("refusalReasonText()", () => {
  for (const code of INBOX_ADOPTION_REFUSALS) {
    it(`has a sentence for the host's code ${code}`, () => {
      expect(refusalReasonText(code)).toEqual(expect.any(String));
      expect(refusalReasonText(code)?.trim()).not.toBe("");
    });
  }

  it("has no sentence for a code the host does not send", () => {
    expect(refusalReasonText("inbox-from-a-newer-host")).toBeUndefined();
  });
});
