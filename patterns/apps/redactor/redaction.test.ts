/**
 * Unit tests for the pure redaction logic: matching, stand-ins, restore, and
 * the leak check. Run: deno test patterns/apps/redactor/redaction.test.ts
 */
import { expect } from "@std/expect";
import {
  detections,
  leaksIn,
  type PIIEntry,
  redact,
  restore,
} from "./redaction.ts";
import { describe, it } from "@commonfabric/test-support/test";

const name = (value: string): PIIEntry => ({ category: "name", value });

const run = (text: string, vault: PIIEntry[]) => {
  const found = detections(text, vault, true);
  return { found, ...redact(text, found) };
};

describe("redaction", () => {
  it("gives two people stand-ins that share no word", () => {
    const { redacted, substitutions } = run(
      "Jordan Rivera and Sam Ortiz met. Later Rivera yelled at Ortiz.",
      [name("Jordan Rivera"), name("Sam Ortiz")],
    );
    expect(redacted).toBe(
      "Alice Anderson and Bob Brown met. Later Anderson yelled at Brown.",
    );
    expect(restore("Anderson apologized to Brown.", substitutions)).toBe(
      "Rivera apologized to Ortiz.",
    );
  });

  it("gives every word of a name its own stand-in", () => {
    const { redacted } = run("Mary Ann Smith met Mary and Ann.", [
      name("Mary Ann Smith"),
    ]);
    const [first, middle] = redacted.split(" ");
    expect(first).not.toBe(middle);
    expect(redacted).not.toMatch(/Mary|Ann|Smith/);
  });

  it("restores name parts in a reply that the draft never used alone", () => {
    const { substitutions } = run("Write to Jordan Rivera about rent.", [
      name("Jordan Rivera"),
    ]);
    expect(restore("Dear ALICE, ... Mr. anderson.", substitutions)).toBe(
      "Dear Jordan, ... Mr. Rivera.",
    );
  });

  it("restores whole words only", () => {
    expect(
      restore("Bobby met Bob.", [
        { category: "name", original: "Jordan", standIn: "Bob" },
      ]),
    ).toBe("Bobby met Jordan.");
  });

  it("chooses a stand-in that reveals nothing about the value it hides", () => {
    // "Pat Sanderson" contains "anderson"; its stand-in must not change because
    // of that, or the released draft hints at the hidden name.

    expect(run("Pat Sanderson called.", [name("Pat Sanderson")]).redacted)
      .toBe(run("Pat Smith called.", [name("Pat Smith")]).redacted);
  });

  it("redacts a draft alike whatever else the vault holds", () => {
    // The released draft may depend only on what matched: an unmentioned entry,
    // or the unmentioned surname of a mentioned first name, must not shift any
    // stand-in, or the release hints at what else the vault holds.

    const draft = "Jordan asked Sam Ortiz to call 415-867-5309.";
    const bare = run(draft, [name("Jordan"), name("Sam Ortiz")]).redacted;
    expect(
      run(draft, [
        name("Alice Anderson"),
        name("Jordan Rivera"),
        name("Bob Brown"),
        { category: "phone", value: "(555) 555-0100" },
        name("Sam Ortiz"),
      ]).redacted,
    ).toBe(bare);
  });

  it("restores a hidden word that reads like a stand-in once", () => {
    // "Pat Alice"'s stand-in may use "Alice": restoring swaps each stand-in once,
    // so it cannot turn the restored "Alice" into "Pat" again.

    const { redacted, substitutions } = run("Pat Alice called.", [
      name("Pat Alice"),
    ]);
    expect(redacted).toBe(
      run("Pat Smith called.", [name("Pat Smith")]).redacted,
    );
    expect(restore(redacted, substitutions)).toBe("Pat Alice called.");
  });

  it("leaves an initial standing on its own unredacted", () => {
    expect(run("Plan J is fine.", [name("John J. Smith")]).redacted).toBe(
      "Plan J is fine.",
    );
  });

  it("gives every phone number its own stand-in, past the pool", () => {
    const phones = Array.from(
      { length: 120 },
      (_, i) => `415-867-${String(5000 + i)}`,
    );
    const draft = phones.join(", ");
    const { redacted, substitutions } = run(draft, []);
    expect(new Set(substitutions.map((s) => s.standIn)).size).toBe(120);
    expect(restore(redacted, substitutions)).toBe(draft);
  });

  it("chooses stand-ins that differ from the text left visible", () => {
    const { redacted, substitutions } = run(
      "Ask Jordan Rivera, cc Alice Anderson.",
      [name("Jordan Rivera")],
    );
    expect(redacted).toMatch(/cc Alice Anderson\.$/);
    expect(redacted).not.toMatch(/^Ask Alice/);
    expect(restore(redacted, substitutions)).toBe(
      "Ask Jordan Rivera, cc Alice Anderson.",
    );
  });

  it("redacts a vault value written without its accents or in another case", () => {
    const { redacted } = run("JOSE GARCIA owes me money.", [
      name("José García"),
    ]);
    expect(redacted).not.toMatch(/jose|garcia/i);
  });

  it("redacts a short email address and leaves the words before it", () => {
    const { redacted } = run("Email me at me@x.co tonight.", []);
    expect(redacted).toMatch(/^Email me at /);
    expect(redacted).not.toContain("me@x.co");
  });

  it("replaces detected formats with reserved fictional values", () => {
    const { redacted } = run(
      "SSN 123-45-6789, call 415-867-5309, card 4111 1111 1111 1111.",
      [],
    );
    expect(redacted).toBe(
      "SSN 900-00-0001, call (555) 555-0100, card [REDACTED-001].",
    );
  });

  it("reports what remains of a value as a leak, and not its stand-in", () => {
    const found = detections("call 415-867-5309", [], true);
    const { redacted, substitutions } = redact("call 415-867-5309", found);
    expect(leaksIn(redacted, found, substitutions)).toEqual([]);
    expect(leaksIn("call 867-5309 instead", found, substitutions)).toEqual([
      "415-867-5309",
    ]);
    expect(leaksIn("Ms. Garcia agreed", [name("José García")])).toEqual([
      "José García",
    ]);
  });

  it("leaves a Luhn-valid run longer than any card unredacted", () => {
    // Both numbers pass the Luhn checksum; only the first has a card's length.
    expect(run("card 4111 1111 1111 1111.", []).redacted).toBe(
      "card [REDACTED-001].",
    );
    expect(run("ref 12345678123456781232.", []).redacted).toBe(
      "ref 12345678123456781232.",
    );
  });

  it("replaces each address with its own fictional street and city", () => {
    const home: PIIEntry = {
      category: "address",
      value: "12 Oak Rd, Springfield",
    };
    const work: PIIEntry = {
      category: "address",
      value: "9 Elm Way, Shelbyville",
    };
    const draft =
      "Ship to 12 Oak Rd, Springfield, not 9 Elm Way, Shelbyville. " +
      "Again: 12 Oak Rd, Springfield.";
    const { redacted, substitutions } = run(draft, [home, work]);
    expect(redacted).toBe(
      "Ship to 100 Example St, Anytown, not 101 Test Ave, Somewhere. " +
        "Again: 100 Example St, Anytown.",
    );
    expect(restore(redacted, substitutions)).toBe(draft);
  });
});
