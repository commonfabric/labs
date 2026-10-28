import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dashboardVersion, processStartVersion } from "./version.ts";

const DEPLOYED_COMMIT = "1".repeat(40);
const START = new Date("2026-08-05T07:15:34.820Z");
const LATER_START = new Date("2026-08-05T07:15:34.821Z");

Deno.test("dashboard version uses the deployed image commit", () => {
  assertEquals(
    dashboardVersion(
      (name) => name === "DASHBOARD_GIT_COMMIT" ? DEPLOYED_COMMIT : undefined,
      () => {
        throw new Error("A deployed image must not read the clock");
      },
    ),
    DEPLOYED_COMMIT,
  );
});

Deno.test("dashboard version reports the start time when no commit is deployed", () => {
  assertEquals(
    dashboardVersion(() => undefined, () => START),
    "local-2026-08-05T07:15:34.820Z",
  );
});

Deno.test("dashboard version rejects a missing or abbreviated commit", () => {
  for (const commit of ["", "abc123", "g".repeat(40)]) {
    assertThrows(
      () => dashboardVersion(() => commit, () => START),
      Error,
      "Dashboard deployment commit must be a full 40-character lowercase hash.",
    );
  }
});

Deno.test("a start a millisecond later is a different version", () => {
  assertNotEquals(
    processStartVersion(START),
    processStartVersion(LATER_START),
  );
});

Deno.test("dashboard image requires the publishing workflow commit", async () => {
  const dockerfile = await Deno.readTextFile(
    new URL("../../Dockerfile.dashboard", import.meta.url),
  );
  assertStringIncludes(dockerfile, "ARG DASHBOARD_GIT_COMMIT");
  assertStringIncludes(
    dockerfile,
    "ENV DASHBOARD_GIT_COMMIT=${DASHBOARD_GIT_COMMIT}",
  );
  assertStringIncludes(
    dockerfile,
    "grep -Eq '^[0-9a-f]{40}$'",
  );
});
