import { assertEquals, assertThrows } from "@std/assert";
import { SessionRegistry } from "../v2/session-registry.ts";

Deno.test("a direct connection cannot take over a routed session with its resume token", () => {
  const registry = new SessionRegistry();
  const opened = registry.open(
    "space",
    {},
    0,
    "routed",
    "principal",
    undefined,
    true,
  );
  const authority = () => true;
  registry.get("space", opened.sessionId)!.routedAuthority = authority;
  const resume = {
    sessionId: opened.sessionId,
    sessionToken: opened.sessionToken,
  };
  assertThrows(() => registry.open("space", resume, 0, "direct", "principal"));
  assertEquals(
    registry.get("space", opened.sessionId)!.ownerConnectionId,
    "routed",
  );
  registry.open("space", resume, 0, "new-routed", "principal", undefined, true);
  assertEquals(
    registry.get("space", opened.sessionId)!.routedAuthority,
    authority,
  );
});
