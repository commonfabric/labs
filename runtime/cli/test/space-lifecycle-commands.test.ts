import { expect } from "@std/expect";

import {
  buildDeleteSpaceCommand,
  buildRecreateRootCommand,
  type SpaceCommandDependencies,
} from "../commands/piece.ts";
import type { SpaceConfig } from "../lib/piece.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const TARGET = ["-i", "/keys/me.key", "-a", "http://toolshed.test"];

/** Dependencies that record what the command rendered and hinted. */
function recording(overrides: SpaceCommandDependencies) {
  const rendered: string[] = [];
  const hints: string[] = [];
  const deps: SpaceCommandDependencies = {
    render: (value) => rendered.push(value),
    hint: (message) => hints.push(message),
    ...overrides,
  };
  return { deps, rendered, hints };
}

describe("space-lifecycle-commands", () => {
  describe("buildRecreateRootCommand()", () => {
    it("recreates the targeted space's root and renders the new piece", async () => {
      const configs: SpaceConfig[] = [];
      const { deps, rendered, hints } = recording({
        recreateSpaceRootPattern: (config) => {
          configs.push(config);
          return Promise.resolve("fid1:root");
        },
      });

      await buildRecreateRootCommand("space recreate-root", deps)
        .throwErrors().noExit().parse([...TARGET, "-s", SPACE]);

      expect(configs.map(({ space, apiUrl }) => ({ space, apiUrl }))).toEqual([
        { space: SPACE, apiUrl: "http://toolshed.test" },
      ]);
      expect(rendered).toEqual(["fid1:root"]);
      expect(hints.join("\n")).toContain(
        `http://toolshed.test/${SPACE}/fid1:root`,
      );
    });
  });

  describe("buildDeleteSpaceCommand()", () => {
    it("deletes the space its `--confirm` names and renders the deletion", async () => {
      const deleted: { space: string; confirm: string }[] = [];
      const { deps, rendered } = recording({
        deleteSpace: (config, confirm) => {
          deleted.push({ space: config.space, confirm });
          return Promise.resolve();
        },
      });

      await buildDeleteSpaceCommand("space delete", deps)
        .throwErrors().noExit()
        .parse([...TARGET, "-s", SPACE, "--confirm", SPACE]);

      expect(deleted).toEqual([{ space: SPACE, confirm: SPACE }]);
      expect(rendered).toEqual([`Deleted ${SPACE}.`]);
    });

    it("throws without `--confirm`, deleting nothing", async () => {
      const deleted: string[] = [];
      const { deps, rendered } = recording({
        deleteSpace: (config) => {
          deleted.push(config.space);
          return Promise.resolve();
        },
      });

      await expect(
        buildDeleteSpaceCommand("space delete", deps)
          .throwErrors().noExit().parse([...TARGET, "-s", SPACE]),
      ).rejects.toThrow("Deleting a space cannot be undone");
      expect(deleted).toEqual([]);
      expect(rendered).toEqual([]);
    });
  });
});
