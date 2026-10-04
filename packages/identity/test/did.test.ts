import { assertEquals, assertThrows } from "@std/assert";

import {
  assertNotDID,
  DID_KEY_PREFIX,
  DID_PREFIX,
  isDID,
  isDIDKey,
  isWellFormedDID,
  parseDID,
} from "../src/did.ts";

// The whole rule: the exact prefix `did:`, and nothing else about the string.
// These tests are the place that rule is pinned, so each case names the
// property it holds rather than a DID that happens to be handy.

Deno.test("isDID accepts any string carrying the exact `did:` prefix", () => {
  assertEquals(isDID("did:key:z6MkExample"), true);
  assertEquals(isDID("did:web:example.com"), true);
  // No second colon, no method-specific id, no method at all: still a DID.
  assertEquals(isDID("did:key"), true);
  assertEquals(isDID("did:"), true);
  // Extra colons are the caller's business, not this predicate's.
  assertEquals(isDID("did:key:z6Mk:more:parts"), true);
  // Whitespace and control characters after the prefix do not disqualify it.
  assertEquals(isDID("did:key:z6Mk\n"), true);
});

Deno.test("isDID rejects a string whose prefix differs in any character", () => {
  assertEquals(isDID("DID:key:z6MkExample"), false);
  assertEquals(isDID("Did:key:z6MkExample"), false);
  assertEquals(isDID(" did:key:z6MkExample"), false);
  assertEquals(isDID("xdid:key:z6MkExample"), false);
  assertEquals(isDID("did"), false);
  assertEquals(isDID(""), false);
});

Deno.test("isDID rejects a value that is not a string", () => {
  assertEquals(isDID(undefined), false);
  assertEquals(isDID(null), false);
  assertEquals(isDID(42), false);
  assertEquals(isDID({ toString: () => "did:key:z6Mk" }), false);
  assertEquals(isDID(["did:key:z6Mk"]), false);
});

Deno.test("isDIDKey accepts only the `did:key:` prefix", () => {
  assertEquals(isDIDKey("did:key:z6MkExample"), true);
  assertEquals(isDIDKey("did:key:"), true);
  assertEquals(isDIDKey("did:web:example.com"), false);
  assertEquals(isDIDKey("did:key"), false);
  assertEquals(isDIDKey("DID:key:z6MkExample"), false);
  assertEquals(isDIDKey(undefined), false);
});

Deno.test("parseDID splits a DID into its method and identifier", () => {
  assertEquals(parseDID("did:key:z6MkExample"), {
    did: "did:key:z6MkExample",
    method: "key",
    id: "z6MkExample",
  });
  // Everything after the method's colon is the identifier, colons included.
  assertEquals(parseDID("did:web:example.com%3A8080#frag"), {
    did: "did:web:example.com%3A8080#frag",
    method: "web",
    id: "example.com%3A8080#frag",
  });
  assertEquals(parseDID("did:key:a:b"), {
    did: "did:key:a:b",
    method: "key",
    id: "a:b",
  });
});

Deno.test("parseDID reports an empty identifier when no colon follows the method", () => {
  assertEquals(parseDID("did:key"), {
    did: "did:key",
    method: "key",
    id: "",
  });
  assertEquals(parseDID("did:"), { did: "did:", method: "", id: "" });
});

Deno.test("parseDID returns `undefined` for anything that is not a DID", () => {
  assertEquals(parseDID("DID:key:z6MkExample"), undefined);
  assertEquals(parseDID("my-space"), undefined);
  assertEquals(parseDID(undefined), undefined);
});

Deno.test("assertNotDID throws for a DID, naming the role and the value", () => {
  const error = assertThrows(
    () => assertNotDID("did:key:z6MkExample", "A space name"),
    Error,
    "A space name must not be a DID",
  );
  assertEquals(error.message.includes('"did:key:z6MkExample"'), true);
  assertEquals(error.message.includes("DIDs are not accepted here"), true);
});

Deno.test("assertNotDID returns for a value that is not a DID", () => {
  assertNotDID("my-space", "A space name");
  assertNotDID("DID:key:z6MkExample", "A space name");
  assertNotDID("", "A space name");
});

Deno.test("the prefixes are the literal strings the rule is written against", () => {
  assertEquals(DID_PREFIX, "did:");
  assertEquals(DID_KEY_PREFIX, "did:key:");
});

Deno.test("isWellFormedDID accepts a DID in DID Core syntax as written", () => {
  assertEquals(isWellFormedDID("did:key:z6MkExample"), true);
  assertEquals(isWellFormedDID("did:web:example.com:user%20a"), true);
});

Deno.test("isWellFormedDID refuses every other spelling isDID admits", () => {
  // Each passes isDID, and each could be shown or compared as a principal it
  // is not.
  for (
    const spelling of [
      "did:key:z6MkExample ",
      "did:key:z6MkExample\n",
      "did:key:z6Mk\u200bExample",
      "did:key:z6Mk Example",
      "did:KEY:z6MkExample",
      "did:key:",
      "did:key",
      "did:key:z6MkExample:",
      `did:key:${"z".repeat(256)}`,
    ]
  ) {
    assertEquals(isDID(spelling), true, spelling);
    assertEquals(isWellFormedDID(spelling), false, spelling);
  }
  assertEquals(isWellFormedDID(" did:key:z6MkExample"), false);
  assertEquals(isWellFormedDID(undefined), false);
});
