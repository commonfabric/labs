import { expect } from "@std/expect";
import {
  buildCreateSpaceCommand,
  type SpaceCommandDependencies,
} from "../commands/piece.ts";
import { withEnv } from "./utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const NEW_SPACE = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

/**
 * Runs `fn` with neither of the variables the command falls back to for its
 * required options set.
 */
function withoutOptionEnv(fn: () => Promise<void>): Promise<void> {
  return withEnv(
    "CF_IDENTITY",
    undefined,
    () => withEnv("CF_API_URL", undefined, fn),
  );
}

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

      await withoutOptionEnv(async () => {
        await expect(
          command.parse(["-i", "key", "-a", "http://toolshed.test", flag, "x"]),
        ).rejects.toThrow(`Unknown option "${flag}"`);
      });
    });
  }

  it("creates a space for the identity under the label and renders its DID", async () => {
    const calls: { identity: string; apiUrl: string; label?: string }[] = [];
    const rendered: string[] = [];
    const hints: string[] = [];
    const deps: SpaceCommandDependencies = {
      render: (value) => rendered.push(value),
      hint: (message) => hints.push(message),
      createSpace: (config, label) => {
        calls.push({ identity: config.identity, apiUrl: config.apiUrl, label });
        return Promise.resolve(NEW_SPACE);
      },
    };

    await withoutOptionEnv(async () => {
      await buildCreateSpaceCommand("space create", deps)
        .throwErrors().noExit()
        .parse([
          "-i",
          "/keys/me.key",
          "-a",
          "http://toolshed.test",
          "--label",
          "Team lunch",
        ]);
    });

    expect(calls).toEqual([{
      identity: "/keys/me.key",
      apiUrl: "http://toolshed.test",
      label: "Team lunch",
    }]);
    expect(rendered).toEqual([NEW_SPACE]);
    expect(hints.join("\n")).toContain(`cf piece new --space ${NEW_SPACE}`);
  });

  for (
    const [missing, args] of [
      ["--identity", ["-a", "http://toolshed.test"]],
      ["--api-url", ["-i", "/keys/me.key"]],
    ] as const
  ) {
    it(`throws naming \`${missing}\` when it is absent, creating nothing`, async () => {
      let created = false;
      const deps: SpaceCommandDependencies = {
        render: () => {},
        hint: () => {},
        createSpace: () => {
          created = true;
          return Promise.resolve(NEW_SPACE);
        },
      };

      await withoutOptionEnv(async () => {
        await expect(
          buildCreateSpaceCommand("space create", deps)
            .throwErrors().noExit()
            .parse([...args]),
        ).rejects.toThrow(`Missing required option: "${missing}"`);
      });
      expect(created).toBe(false);
    });
  }
});
