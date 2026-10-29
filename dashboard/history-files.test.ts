import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  dashboardCacheDirectory,
  dashboardCacheFile,
} from "./history-files.ts";

function environment(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("dashboard cache files use fixed names in one configured directory", () => {
  const directory = "configured-dashboard-cache";
  const env = environment({
    DASHBOARD_CACHE_DIR: directory,
  });

  assertEquals(
    dashboardCacheDirectory(env),
    directory,
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-discord-history.json", env),
    join(directory, "fabric-wall-discord-history.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-ci-run-index.json", env),
    join(directory, "fabric-wall-ci-run-index.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-benchmark-history.json", env),
    join(directory, "fabric-wall-benchmark-history.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-github-rate-limit.json", env),
    join(directory, "fabric-wall-github-rate-limit.json"),
  );
  assertEquals(
    dashboardCacheFile(
      "fabric-wall-github-members-commonfabric-history.json",
      env,
    ),
    join(
      directory,
      "fabric-wall-github-members-commonfabric-history.json",
    ),
  );
});

Deno.test("dashboard cache files default to the temp directory", () => {
  const directory = "platform-temp";
  const env = environment({ TMPDIR: directory });
  assertEquals(dashboardCacheDirectory(env), directory);
  assertEquals(
    dashboardCacheFile("fabric-wall-ci-run-index.json", env),
    join(directory, "fabric-wall-ci-run-index.json"),
  );
});

Deno.test("dashboard cache files recognize Windows temp variables", () => {
  assertEquals(
    dashboardCacheDirectory(environment({ TEMP: "windows-temp" })),
    "windows-temp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({ TMP: "windows-tmp" })),
    "windows-tmp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({
      TMPDIR: "posix-temp",
      TEMP: "windows-temp",
      TMP: "windows-tmp",
    })),
    "posix-temp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({})),
    Deno.build.os === "windows" ? "." : "/tmp",
  );
});
