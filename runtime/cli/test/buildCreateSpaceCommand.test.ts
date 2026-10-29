import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { buildCreateSpaceCommand } from "../commands/piece.ts";

describe("buildCreateSpaceCommand()", () => {
  it("returns a command carrying the identity, the API URL, quiet, and the label", () => {
    const command = buildCreateSpaceCommand("space create");

    for (const name of ["identity", "api-url", "quiet", "label"]) {
      expect(command.getOption(name)?.name).toBe(name);
    }
    expect(command.getEnvVar("CF_IDENTITY")).toBeDefined();
    expect(command.getEnvVar("CF_API_URL")).toBeDefined();
  });

  it("returns a command carrying no space and no combined URL", () => {
    const command = buildCreateSpaceCommand("space create");

    expect(command.getOption("space")).toBeUndefined();
    expect(command.getOption("url")).toBeUndefined();
    expect(command.getEnvVar("CF_SPACE")).toBeUndefined();
  });

  for (const flag of ["--space", "--url"]) {
    it(`throws on \`${flag}\` before the command acts`, async () => {
      const command = buildCreateSpaceCommand("space create").throwErrors();

      await expect(
        command.parse(["-i", "key", "-a", "http://toolshed.test", flag, "x"]),
      ).rejects.toThrow(`Unknown option "${flag}"`);
    });
  }
});
