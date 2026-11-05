// Pure unit tests for the dump access policy — the security matrix this proposal
// rests on (opt-in, production defense-in-depth, allowlist union).

import { assertEquals } from "@std/assert";
import { dumpAllowSet, isDumpEnabled } from "./memory-dump-policy.ts";

Deno.test("isDumpEnabled: off unless explicitly enabled", () => {
  assertEquals(
    isDumpEnabled({ enabled: undefined, env: "development" }),
    false,
  );
  assertEquals(isDumpEnabled({ enabled: false, env: "development" }), false);
  assertEquals(isDumpEnabled({ enabled: true, env: "development" }), true);
  assertEquals(isDumpEnabled({ enabled: true, env: "test" }), true);
  assertEquals(isDumpEnabled({ enabled: true, env: "staging" }), true);
  // Case-insensitive on the recognized values.
  assertEquals(isDumpEnabled({ enabled: true, env: "Staging" }), true);
});

Deno.test("isDumpEnabled: production (and any alias/unknown env) is a hard no", () => {
  // No override exists — enabled or not, production never mounts the endpoint.
  assertEquals(isDumpEnabled({ enabled: true, env: "production" }), false);
  assertEquals(isDumpEnabled({ enabled: false, env: "production" }), false);
  assertEquals(isDumpEnabled({ enabled: undefined, env: "production" }), false);
  // FAIL-CLOSED: aliases, typos, and unrecognized envs refuse too — only the
  // explicit non-production allowlist mounts the endpoint.
  assertEquals(isDumpEnabled({ enabled: true, env: "prod" }), false);
  assertEquals(isDumpEnabled({ enabled: true, env: "Production" }), false);
  assertEquals(isDumpEnabled({ enabled: true, env: "stagin" }), false);
  assertEquals(isDumpEnabled({ enabled: true, env: "" }), false);
  assertEquals(isDumpEnabled({ enabled: true, env: "rapids" }), false);
});

Deno.test("dumpAllowSet: union of MEMORY_DUMP_DIDS and MEMORY_SERVICE_DIDS", () => {
  const set = dumpAllowSet({
    dumpDids: "did:key:zDump1, did:key:zDump2",
    serviceDids: "did:key:zService",
  });
  assertEquals(set.has("did:key:zDump1"), true);
  assertEquals(set.has("did:key:zDump2"), true);
  // A service DID alone is sufficient — the allowlist is a union.
  assertEquals(set.has("did:key:zService"), true);
  assertEquals(set.has("did:key:zStranger"), false);
});

Deno.test("dumpAllowSet: empty config trusts nobody", () => {
  const set = dumpAllowSet({ dumpDids: "", serviceDids: "" });
  assertEquals(set.size, 0);
});
