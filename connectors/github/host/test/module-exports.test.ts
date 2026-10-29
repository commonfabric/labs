import { assertEquals } from "@std/assert";
import "../main.ts";
import * as host from "../mod.ts";

Deno.test("GitHub host package exports its public entry points", () => {
  assertEquals(typeof host.runGithubHostCli, "function");
  assertEquals(typeof host.GithubHost, "function");
  assertEquals(typeof host.resolveGithubToken, "function");
});
