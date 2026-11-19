import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { createClearedHostProcessEnv } from "../../src/tools/host-process-env.ts";

const DEFAULT_HOST_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const probeWithEnvPermission = async (
  envFlag: "--allow-env" | "--deny-env",
): Promise<Record<string, string>> => {
  const output = await runDenoCommandWithTemporaryLock({
    root: fromFileUrl(new URL("../../../../", import.meta.url)),
    args: (lock) => [
      "run",
      "--lock",
      lock,
      "--frozen",
      "--cached-only",
      "--no-prompt",
      envFlag,
      fromFileUrl(
        new URL("../support/tools-small-host-path-probe.ts", import.meta.url),
      ),
    ],
    env: { PATH: "/probe/bin" },
  });
  expect(new TextDecoder().decode(output.stderr)).toBe("");
  return JSON.parse(new TextDecoder().decode(output.stdout));
};

describe("createClearedHostProcessEnv()", () => {
  it("returns only the host PATH when given no variables", () => {
    expect(createClearedHostProcessEnv()).toEqual({
      PATH: Deno.env.get("PATH") ?? DEFAULT_HOST_PATH,
    });
  });

  it("returns the given variables beside the host PATH, letting a given PATH win", () => {
    expect(createClearedHostProcessEnv({ HOME: "/home/agent" })).toEqual({
      PATH: Deno.env.get("PATH") ?? DEFAULT_HOST_PATH,
      HOME: "/home/agent",
    });
    expect(createClearedHostProcessEnv({ PATH: "/only/here" })).toEqual({
      PATH: "/only/here",
    });
  });

  it("returns the process PATH when env access is allowed and the default PATH when it is denied", async () => {
    // Deno may put a directory of its own ahead of the PATH it was given.
    expect((await probeWithEnvPermission("--allow-env")).PATH).toMatch(
      /(^|:)\/probe\/bin$/,
    );
    expect(await probeWithEnvPermission("--deny-env")).toEqual({
      PATH: DEFAULT_HOST_PATH,
    });
  });
});
