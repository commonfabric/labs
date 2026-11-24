import { assertEquals, assertThrows } from "@std/assert";
import { createAgentDriver } from "../src/create-driver.ts";
import type { AgentSourceConfig } from "../src/types.ts";

Deno.test("bundled drivers normalize their source identities", () => {
  for (
    const driver of ["claude-agent-sdk", "codex-app-server", "acp"] as const
  ) {
    const created = createAgentDriver({
      id: " Provider:Default ",
      driver,
      enabled: true,
      command: ["unused"],
    });
    assertEquals(created.source.id, "provider:default");
  }
});

Deno.test("driver creation rejects unknown runtime driver kinds", () => {
  assertThrows(
    () =>
      createAgentDriver({
        id: "provider:default",
        driver: "unknown-driver",
        enabled: true,
      } as unknown as AgentSourceConfig),
    Error,
    "unsupported agent driver: unknown-driver",
  );
});

Deno.test("driver creation rejects invalid source identities", () => {
  assertThrows(
    () =>
      createAgentDriver({
        id: " \n ",
        driver: "claude-agent-sdk",
        enabled: true,
      }),
    Error,
    "sourceId must not be empty",
  );
});
