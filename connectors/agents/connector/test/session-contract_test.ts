import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  normalizeSourceId,
  sessionChunkCause,
  sessionKey,
  sessionManifestCause,
} from "../src/session-contract.ts";

Deno.test("sessionKey is stable and cannot collide across source boundaries", () => {
  assertEquals(
    sessionKey("claude-code:default", "abc/123"),
    "claude-code%3Adefault/abc%2F123",
  );
  assertEquals(
    sessionKey("claude-code:default", "abc/123"),
    sessionKey("claude-code:default", "abc/123"),
  );
  assertEquals(normalizeSourceId("  Codex:Default  "), "codex:default");
});

Deno.test("session identity rejects empty and control-character values", () => {
  assertThrows(() => sessionKey("", "session"), Error, "sourceId");
  assertThrows(() => sessionKey("codex", ""), Error, "nativeSessionId");
  assertThrows(() => sessionKey("codex\nother", "session"), Error, "control");
});

Deno.test("session chunk identity includes its content hash", () => {
  const first = sessionChunkCause(
    "did:key:space",
    "did:key:owner",
    "codex",
    "session",
    0,
    "sha256:first",
  );
  const second = sessionChunkCause(
    "did:key:space",
    "did:key:owner",
    "codex",
    "session",
    0,
    "sha256:second",
  );
  assertEquals(first, {
    spaceDid: "did:key:space",
    ownerDid: "did:key:owner",
    agentConnector: "session-chunk",
    sourceId: "codex",
    nativeSessionId: "session",
    part: 0,
    contentHash: "sha256:first",
  });
  assertNotEquals(first, second);
});

Deno.test("session manifest identity includes its manifest hash", () => {
  const first = sessionManifestCause(
    "did:key:space",
    "did:key:owner",
    "codex",
    "session",
    "codex-app-server",
    "sha256:first",
  );
  const second = sessionManifestCause(
    "did:key:space",
    "did:key:owner",
    "codex",
    "session",
    "codex-app-server",
    "sha256:second",
  );
  assertEquals(first, {
    spaceDid: "did:key:space",
    ownerDid: "did:key:owner",
    agentConnector: "session-version",
    sourceId: "codex",
    nativeSessionId: "session",
    driver: "codex-app-server",
    contentHash: "sha256:first",
  });
  assertNotEquals(first, second);
});
