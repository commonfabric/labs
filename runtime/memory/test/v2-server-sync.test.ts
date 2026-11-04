import { assertEquals } from "@std/assert";
import {
  buildDiffSync,
  buildFullSync,
  cacheKeyForEntity,
  toCacheEntry,
  toWireUpsert,
} from "../v2/server-sync.ts";

const IDENTITY = { principal: "did:test:alice", sessionId: "s1" };

Deno.test("memory v2 session cache entries always include scope and instance key", () => {
  assertEquals(
    toCacheEntry({
      branch: "",
      id: "of:space",
      seq: 1,
      document: { value: { label: "space" } },
    }, IDENTITY),
    {
      branch: "",
      id: "of:space",
      scope: "space",
      scopeKey: "space",
      seq: 1,
      doc: { value: { label: "space" } },
    },
  );
  assertEquals(
    toCacheEntry({
      branch: "",
      id: "of:deleted",
      scope: "user",
      seq: 2,
      document: null,
    }, IDENTITY),
    {
      branch: "",
      id: "of:deleted",
      scope: "user",
      scopeKey: "user:did%3Atest%3Aalice",
      seq: 2,
      deleted: true,
    },
  );
  // An explicit instance key (a lease-holder read — protocol.md §2's read
  // row) wins over the session-identity resolution.
  assertEquals(
    toCacheEntry(
      {
        branch: "",
        id: "of:foreign",
        scope: "user",
        seq: 3,
        document: { value: {} },
      },
      IDENTITY,
      "user:did%3Atest%3Abob",
    ),
    {
      branch: "",
      id: "of:foreign",
      scope: "user",
      scopeKey: "user:did%3Atest%3Abob",
      seq: 3,
      doc: { value: {} },
    },
  );
});

Deno.test("memory v2 wire upserts strip the server-internal instance key", () => {
  // The wire carries scope NAMES only (protocol.md §1: a client's
  // instances resolve from its session; clients never receive keys), in
  // the pre-instance-keying field order.
  assertEquals(
    toWireUpsert(toCacheEntry({
      branch: "",
      id: "of:doc",
      scope: "user",
      seq: 4,
      document: { value: { n: 1 } },
    }, IDENTITY)),
    {
      branch: "",
      id: "of:doc",
      scope: "user",
      seq: 4,
      doc: { value: { n: 1 } },
    },
  );
  assertEquals(
    toWireUpsert(toCacheEntry({
      branch: "",
      id: "of:gone",
      scope: "session",
      seq: 5,
      document: null,
    }, IDENTITY)),
    {
      branch: "",
      id: "of:gone",
      scope: "session",
      seq: 5,
      deleted: true,
    },
  );
});

Deno.test("memory v2 session sync removes include scope", () => {
  const previous = new Map([
    [
      cacheKeyForEntity("", "of:space", "space"),
      toCacheEntry({
        branch: "",
        id: "of:space",
        seq: 1,
        document: { value: {} },
      }, IDENTITY),
    ],
    [
      cacheKeyForEntity("", "of:user", "user:did%3Atest%3Aalice"),
      toCacheEntry({
        branch: "",
        id: "of:user",
        scope: "user",
        seq: 1,
        document: { value: {} },
      }, IDENTITY),
    ],
  ]);

  assertEquals(buildFullSync(previous, new Map(), 1, 2).removes, [{
    branch: "",
    id: "of:space",
    scope: "space",
  }, {
    branch: "",
    id: "of:user",
    scope: "user",
  }]);
  assertEquals(buildDiffSync(previous, new Map(), 1, 2).removes, [{
    branch: "",
    id: "of:space",
    scope: "space",
  }, {
    branch: "",
    id: "of:user",
    scope: "user",
  }]);
});
