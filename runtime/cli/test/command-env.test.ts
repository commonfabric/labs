import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { commandEnv } from "./utils.ts";

// What a test would inherit from the process running it.
const INHERITED = {
  PATH: "/usr/bin",
  CF_IDENTITY: "/inherited/identity.key",
  EXPERIMENTAL_COMPUTED_CELL_IDS: "false",
  MEMORY_DIR: "file:///inherited/memory/",
};

describe("commandEnv", () => {
  it("keeps an inherited name that is not the CLI's configuration", () => {
    expect(commandEnv(INHERITED, {}).PATH).toBe("/usr/bin");
  });

  it("drops inherited configuration the call says nothing about", () => {
    const env = commandEnv(INHERITED, {});
    expect("CF_IDENTITY" in env).toBe(false);
    expect("EXPERIMENTAL_COMPUTED_CELL_IDS" in env).toBe(false);
    expect("MEMORY_DIR" in env).toBe(false);
  });

  it("carries the configuration the call declares", () => {
    const env = commandEnv(INHERITED, {
      CF_IDENTITY: "/declared/identity.key",
    });
    expect(env.CF_IDENTITY).toBe("/declared/identity.key");
  });

  it("drops a name the call maps to `undefined`", () => {
    const env = commandEnv(INHERITED, { PATH: undefined });
    expect("PATH" in env).toBe(false);
  });

  it("overrides an inherited name that is not configuration", () => {
    expect(commandEnv(INHERITED, { PATH: "/opt/bin" }).PATH).toBe("/opt/bin");
  });
});
