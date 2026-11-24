import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isStoredArgumentSchemaRefusal,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
  storedArgumentRefusalDetail,
} from "../src/stored-argument-refusal.ts";

describe("setup's refusal of a piece's stored argument", () => {
  const refusal = `${STORED_ARGUMENT_SCHEMA_REFUSAL}: missing required ` +
    `property profiles`;

  it("recognizes the refusal by the prefix it opens with", () => {
    expect(isStoredArgumentSchemaRefusal(new Error(refusal))).toBe(true);
  });

  it("is not fooled by a message that merely contains the prefix", () => {
    // The prefix is code-controlled and sits at the start; a validation
    // detail carrying user-influenced text is appended after it. A value that
    // quotes the prefix later in the message is some other failure.
    expect(
      isStoredArgumentSchemaRefusal(
        new Error(`could not read: ${STORED_ARGUMENT_SCHEMA_REFUSAL}: x`),
      ),
    ).toBe(false);
    expect(isStoredArgumentSchemaRefusal(new Error("something else"))).toBe(
      false,
    );
    expect(isStoredArgumentSchemaRefusal(refusal)).toBe(false);
    expect(isStoredArgumentSchemaRefusal(undefined)).toBe(false);
  });

  it("hands back the part of the message worth reading", () => {
    // What a reader needs is which property does not fit; the prefix names
    // the rule, which whatever shows the message has already said.
    expect(storedArgumentRefusalDetail(refusal)).toBe(
      "missing required property profiles",
    );
  });

  it("leaves a message that is not one of these alone", () => {
    expect(storedArgumentRefusalDetail("nothing answers there")).toBe(
      "nothing answers there",
    );
    // The prefix without its separator is not the prefix.
    expect(storedArgumentRefusalDetail(STORED_ARGUMENT_SCHEMA_REFUSAL)).toBe(
      STORED_ARGUMENT_SCHEMA_REFUSAL,
    );
  });
});
