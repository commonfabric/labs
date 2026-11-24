import { assertEquals } from "@std/assert";
import "../main.ts";
import * as host from "../mod.ts";

Deno.test("agent host package exports its public entry points", () => {
  assertEquals(typeof host.startAgentsHost, "function");
  assertEquals(typeof host.AgentsHost, "function");
});
