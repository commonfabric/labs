// Contract tests for the shared scope_key vocabulary (ledger LD3, owner
// 2026-08-03; docs/specs/server-side-execution/key-vocabulary.md §3).
// These bind the WIRE-VOCABULARY semantics: the one definition in the
// wire-shape module, its format, its throw conditions, its parse/inspect
// helpers, and the single-definition property (the engine re-exports the
// same objects — no second definition exists to drift).
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  canResolveScopeKey,
  isScopeKey,
  principalOfSessionKey,
  ProtocolError,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  scopeOfScopeKey,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";

const identity = {
  principal: "did:key:z6MkAlice",
  sessionId: "session-1",
};

Deno.test("scope_key format: space, user:<principal>, session:<principal>:<sessionId>", () => {
  assertEquals(resolveScopeKey("space", {}), "space");
  assertEquals(resolveScopeKey(undefined, {}), "space");
  // Space needs no identity; supplying one changes nothing.
  assertEquals(resolveScopeKey("space", identity), "space");
  assertEquals(
    resolveScopeKey("user", identity),
    "user:did%3Akey%3Az6MkAlice",
  );
  assertEquals(
    resolveScopeKey("session", identity),
    "session:did%3Akey%3Az6MkAlice:session-1",
  );
});

Deno.test("scope_key segments are encodeURIComponent-encoded — ':' splits exactly, no '/' survives", () => {
  const tricky = resolveScopeKey("session", {
    principal: "did:web:example.com:alice",
    sessionId: "a/b:c",
  });
  // Splitting on ":" yields exactly three segments.
  assertEquals(tricky.split(":").length, 3);
  // No "/" survives encoding, so composite `a/b/c` keys stay 3-way
  // splittable.
  assert(!tricky.includes("/"));
  assertEquals(
    principalOfSessionKey(tricky),
    "did:web:example.com:alice",
  );
});

Deno.test("scope_key construction throws ProtocolError on missing identity components — never invents one", () => {
  assertThrows(
    () => resolveScopeKey("user", {}),
    ProtocolError,
    "user scoped memory operations require a principal",
  );
  assertThrows(
    () => resolveScopeKey("session", { sessionId: "s" }),
    ProtocolError,
    "session scoped memory operations require a principal",
  );
  assertThrows(
    () => resolveScopeKey("session", { principal: "did:key:x" }),
    ProtocolError,
    "session scoped memory operations require a session id",
  );
});

Deno.test("canResolveScopeKey is the predicate twin of the constructor's throws", () => {
  for (
    const [scope, id] of [
      ["space", {}],
      ["user", {}],
      ["user", identity],
      ["session", {}],
      ["session", { principal: identity.principal }],
      ["session", identity],
      [undefined, {}],
    ] as const
  ) {
    let threw = false;
    try {
      resolveScopeKey(scope, id);
    } catch {
      threw = true;
    }
    assertEquals(
      canResolveScopeKey(scope, id),
      !threw,
      `predicate disagrees with constructor for ${scope}`,
    );
  }
});

Deno.test("scopeOfScopeKey inverts the constructor's scope; isScopeKey validates", () => {
  for (const scope of ["space", "user", "session"] as const) {
    const key = resolveScopeKey(scope, identity);
    assertEquals(scopeOfScopeKey(key), scope);
    assert(isScopeKey(key));
  }
  // The scope NAMES themselves are not instance keys (except space, whose
  // one shared instance IS its name).
  assert(isScopeKey("space"));
  assert(!isScopeKey("user"));
  assert(!isScopeKey("session"));
  assert(!isScopeKey("user:"));
  assert(!isScopeKey("session:x"));
  assert(!isScopeKey("session:x:"));
  assert(!isScopeKey("something-else"));
});

Deno.test("isScopeKey accepts ONLY the constructor's image — canonical escape casing pinned to what the encoder emits", () => {
  // Canon pin: the encoder is encodeURIComponent, whose escapes use
  // UPPERCASE hex — "/" encodes as "%2F", ":" as "%3A". The rejection
  // set below is stated relative to THIS casing; if the encoder ever
  // changes, this pin fails first and names the drift.
  assertEquals(resolveScopeKey("user", { principal: "/" }), "user:%2F");
  assertEquals(
    resolveScopeKey("session", { principal: ":", sessionId: "/" }),
    "session:%3A:%2F",
  );
  // Every constructed key is accepted, including keys whose identity
  // components look pre-encoded (they re-encode, staying distinct).
  const principals = [
    "did:key:z6MkAlice",
    "a/b",
    "a%2Fb",
    "a:b",
    "user with spaces",
    "ünïcode:∆",
    "a+b",
  ];
  const sessionIds = ["s-1", "b:c", "s/1", "s%2F1", "s ü:∆"];
  for (const principal of principals) {
    assert(isScopeKey(resolveScopeKey("user", { principal })));
    for (const sessionId of sessionIds) {
      assert(isScopeKey(resolveScopeKey("session", { principal, sessionId })));
    }
  }
});

Deno.test("isScopeKey rejects non-canonical keys — raw delimiters, malformed escapes, non-canonical escapes; refusal, never a throw", () => {
  const rejected = [
    // Raw "/" in a segment: a "/"-delimited composite key built from an
    // admitted key would split at the wrong boundary.
    "user:a/b",
    "session:a/b:c",
    "session:a:b/c",
    // Raw ":" in a segment (the canonical form is %3A): ":" must split
    // segments EXACTLY, so a user key has no second ":".
    "user:did:key:alice",
    "session:a:b:c",
    // Malformed percent escapes: percent-decoding an admitted key must
    // never throw downstream.
    "user:%",
    "user:%2",
    "user:%GG",
    "session:%GG:s",
    "session:p:%",
    // Decodable but NOT what the encoder emits: lowercase hex, and an
    // over-escape of an unreserved character (canon: "user:a%2Fb", "user:A").
    "user:a%2fb",
    "user:%41",
    // Raw characters the encoder escapes (canon: a%20b, a%2Bb).
    "user:a b",
    "user:a+b",
    // A lone surrogate: re-ENCODING throws URIError — refused, not thrown.
    "user:\uD800",
    // A surrogate code point behind valid-looking UTF-8 escapes: the
    // DECODE throws URIError — refused, not thrown.
    "user:%ED%A0%80",
  ];
  for (const key of rejected) {
    assert(!isScopeKey(key), `expected rejection: ${JSON.stringify(key)}`);
  }
});

Deno.test("canonical keys round-trip decode→encode byte-identically, and construction is injective over identities", () => {
  const principals = ["did:key:z6MkAlice", "a/b", "a%2Fb", "a:b", "ü ∆+x"];
  const sessionIds = ["s-1", "b:c", "s/1", "s%2F1"];
  const seen = new Map<string, string>();
  const claim = (key: string, identity: string) => {
    const prior = seen.get(key);
    assertEquals(prior, undefined, `collision: ${key} from ${prior}`);
    seen.set(key, identity);
  };
  for (const principal of principals) {
    const userK = resolveScopeKey("user", { principal });
    // Round trip: decoding the segment and re-constructing reproduces
    // the key byte-for-byte (the fixed-point grammar isScopeKey admits).
    assertEquals(
      resolveScopeKey("user", {
        principal: decodeURIComponent(userK.slice("user:".length)),
      }),
      userK,
    );
    claim(userK, `user ${principal}`);
    for (const sessionId of sessionIds) {
      const sessionK = resolveScopeKey("session", { principal, sessionId });
      assertEquals(principalOfSessionKey(sessionK), principal);
      claim(sessionK, `session ${principal} ${sessionId}`);
    }
  }
  // The witnesses un-encoded interpolation would collide:
  assert(
    resolveScopeKey("session", { principal: "a:b", sessionId: "c" }) !==
      resolveScopeKey("session", { principal: "a", sessionId: "b:c" }),
  );
  assert(
    resolveScopeKey("user", { principal: "a/b" }) !==
      resolveScopeKey("user", { principal: "a%2Fb" }),
  );
});

Deno.test("principalOfSessionKey decodes the session key's principal; non-session keys yield undefined", () => {
  assertEquals(
    principalOfSessionKey(
      resolvePrincipalSessionKey("did:key:z6MkBob", "s-9"),
    ),
    "did:key:z6MkBob",
  );
  assertEquals(principalOfSessionKey("user:did%3Akey%3Ax"), undefined);
  assertEquals(principalOfSessionKey("space"), undefined);
  assertEquals(principalOfSessionKey("bare-session-id"), undefined);
});

Deno.test("single definition: the engine re-exports the SAME constructor and error class (LD3)", () => {
  // Not equal behavior — the same object. A second definition of the
  // format is the key-vocabulary.md §4 tripwire.
  assert(Engine.resolveScopeKey === resolveScopeKey);
  assert(Engine.ProtocolError === ProtocolError);
  assert(Engine.principalOfSessionKey === principalOfSessionKey);
});

Deno.test("commit session keys share the session-key constructor", () => {
  assertEquals(
    Engine.resolveCommitSessionKey("s-1", "did:key:z6MkCara"),
    resolvePrincipalSessionKey("did:key:z6MkCara", "s-1"),
  );
  // Principal-less commit session keys stay the bare session id.
  assertEquals(Engine.resolveCommitSessionKey("s-1"), "s-1");
});
