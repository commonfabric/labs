import { assertEquals } from "@std/assert";
import "../main.ts";
import * as host from "../mod.ts";
import { test } from "@commonfabric/test-support/test";

test("agent host package exports its public entry points", () => {
  assertEquals(typeof host.startAgentsHost, "function");
  assertEquals(typeof host.AgentsHost, "function");
});
