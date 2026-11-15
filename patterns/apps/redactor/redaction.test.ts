/**
 * Unit tests for the pure redaction logic: matching, stand-ins, restore, and
 * the leak check. Run: deno test patterns/apps/redactor/redaction.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  detections,
  leaksIn,
  type PIIEntry,
  redact,
  restore,
} from "./redaction.ts";

const name = (value: string): PIIEntry => ({ category: "name", value });

const run = (text: string, vault: PIIEntry[]) => {
  const found = detections(text, vault, true);
  return { found, ...redact(text, found) };
};

Deno.test("two people never share a stand-in word", () => {
  const { redacted, substitutions } = run(
    "Jordan Rivera and Sam Ortiz met. Later Rivera yelled at Ortiz.",
    [name("Jordan Rivera"), name("Sam Ortiz")],
  );
  assertEquals(
    redacted,
    "Alice Anderson and Bob Brown met. Later Anderson yelled at Brown.",
  );
  assertEquals(
    restore("Anderson apologized to Brown.", substitutions),
    "Rivera apologized to Ortiz.",
  );
});

Deno.test("every word of a name gets its own stand-in", () => {
  const { redacted } = run("Mary Ann Smith met Mary and Ann.", [
    name("Mary Ann Smith"),
  ]);
  const [first, middle] = redacted.split(" ");
  assert(first !== middle, redacted);
  assert(!/Mary|Ann|Smith/.test(redacted), redacted);
});

Deno.test("a reply restores name parts the draft never used alone", () => {
  const { substitutions } = run("Write to Jordan Rivera about rent.", [
    name("Jordan Rivera"),
  ]);
  assertEquals(
    restore("Dear ALICE, ... Mr. anderson.", substitutions),
    "Dear Jordan, ... Mr. Rivera.",
  );
});

Deno.test("restore replaces whole words only", () => {
  assertEquals(
    restore("Bobby met Bob.", [
      { category: "name", original: "Jordan", standIn: "Bob" },
    ]),
    "Bobby met Jordan.",
  );
});

Deno.test("a stand-in reveals nothing about the value it hides", () => {
  // "Pat Sanderson" contains "anderson"; its stand-in must not change because
  // of that, or the released draft hints at the hidden name.
  assertEquals(
    run("Pat Sanderson called.", [name("Pat Sanderson")]).redacted,
    run("Pat Smith called.", [name("Pat Smith")]).redacted,
  );
});

Deno.test("a stand-in never collides with text that stays visible", () => {
  const { redacted, substitutions } = run(
    "Ask Jordan Rivera, cc Alice Anderson.",
    [name("Jordan Rivera")],
  );
  assert(redacted.endsWith("cc Alice Anderson."), redacted);
  assert(!redacted.startsWith("Ask Alice"), redacted);
  assertEquals(
    restore(redacted, substitutions),
    "Ask Jordan Rivera, cc Alice Anderson.",
  );
});

Deno.test("accents and case do not hide a vault value", () => {
  const { redacted } = run("JOSE GARCIA owes me money.", [
    name("José García"),
  ]);
  assert(!/jose|garcia/i.test(redacted), redacted);
});

Deno.test("a short email local part does not swallow ordinary words", () => {
  const { redacted } = run("Email me at me@x.co tonight.", []);
  assert(redacted.startsWith("Email me at "), redacted);
  assert(!redacted.includes("me@x.co"), redacted);
});

Deno.test("detected formats are replaced with reserved fictional values", () => {
  const { redacted } = run(
    "SSN 123-45-6789, call 415-867-5309, card 4111 1111 1111 1111.",
    [],
  );
  assertEquals(
    redacted,
    "SSN 900-00-0001, call (555) 555-0100, card [REDACTED-001].",
  );
});

Deno.test("the leak check ignores stand-ins and catches what remains", () => {
  const found = detections("call 415-867-5309", [], true);
  const { redacted, substitutions } = redact("call 415-867-5309", found);
  assertEquals(leaksIn(redacted, found, substitutions), []);
  assertEquals(
    leaksIn("call 867-5309 instead", found, substitutions),
    ["415-867-5309"],
  );
  assertEquals(
    leaksIn("Ms. Garcia agreed", [name("José García")]),
    ["José García"],
  );
});
