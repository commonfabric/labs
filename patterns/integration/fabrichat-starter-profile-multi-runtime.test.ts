import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

/** Reads the starter's profile setup, the second child of its screen. */
const setupDisplay = async (session: MultiRuntimeSession): Promise<unknown> => {
  const path = ["$UI", "children", 1, "props"];
  expect(await session.read([...path, "id"]))
    .toBe("fabrichat-starter-profile-setup");
  return await session.read([...path, "style", "display"]);
};

describe("FabriChat starter profile setup", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    it(
      `follows missing, selected, and empty profiles with server execution ${
        serverExecution ? "on" : "off"
      }`,
      async () => {
        harness = await MultiRuntimeHarness.create({
          programPath: join(
            import.meta.dirname!,
            "fixtures",
            "fabrichat-starter-profile.tsx",
          ),
          rootPath: join(import.meta.dirname!, ".."),
          sessions: [{
            label: "starter-profile-reader",
            cfc: { experimental: { serverExecution } },
          }],
        });
        const [reader] = harness.sessions;
        await harness.settle();
        expect(await setupDisplay(reader)).toBe("block");

        const profile = await reader.createOwnProfile("Starter reader");
        await reader.send("holdProfile", { profile });
        await harness.settle();
        expect(await reader.read(["profile", "name"])).toBe("Starter reader");
        await reader.client().call("selectProfile", { path: ["profile"] });
        await harness.settleUntil(async () =>
          await setupDisplay(reader) === "none"
        );
        expect(await setupDisplay(reader)).toBe("none");

        // An existing cell handle whose value is absent is not a profile.
        expect(await reader.read(["emptyProfile"])).toBeUndefined();
        await reader.client().call("selectProfile", { path: ["emptyProfile"] });
        await harness.settleUntil(async () =>
          await setupDisplay(reader) === "block"
        );
        expect(await setupDisplay(reader)).toBe("block");
      },
    );
  }
});
