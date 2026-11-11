/**
 * Multi-runtime test: the profile a host suggests reaches the `#profile`
 * wish's create surface.
 *
 * The host stores the suggestion in its user's home space
 * (`offerProfileSuggestion`), and the wish hands the surface a link to it from
 * whichever runtime builds the surface: the session's own with server
 * execution off, the space server's on the session's behalf with it on. Both
 * are run here. What the surface does with the suggestion once a profile is
 * created is `patterns/system/profile-create/profile-create.suggestion.test.tsx`'s
 * to show.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "profile-create-surface.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The wish renders `<cf-render $cell={…}>`, whose `$cell` prop is the piece
// the surface runs in.
const SURFACE_PIECE = ["profile", "$UI", "props", "$cell"];

// A stand-in for a picture; nothing here decodes it.
const PICTURE = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

/**
 * The path, below `path`, to the first node of the stored rendering `node`
 * for which `match` holds; `undefined` where none does.
 */
const pathTo = (
  node: FabricValue,
  match: (node: Record<string, FabricValue>) => boolean,
  path: (string | number)[],
): (string | number)[] | undefined => {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      const found = pathTo(child, match, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, FabricValue>;
  if (match(record)) return path;
  return record.children === undefined
    ? undefined
    : pathTo(record.children, match, [...path, "children"]);
};

describe("profile-suggestion-multi-runtime", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      it("starts the create surface's name field with the suggested name and shows the suggested picture", async () => {
        const guest = await Identity.fromPassphrase(
          `profile-suggestion-guest-${serverExecution}`,
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [{
            label: "profile-suggestion-guest",
            identity: guest,
            cfc: { experimental: { serverExecution } },
            profileSuggestion: { name: "Sam Lee", picture: PICTURE },
          }],
        });
        const [session] = harness.sessions;
        expect(await session.profileSuggestion()).toEqual({
          name: "Sam Lee",
          picture: PICTURE,
        });

        await harness.settleUntil(async () =>
          await session.readRaw([...SURFACE_PIECE, "$NAME"]) !== undefined
        );
        // Addressing the surface's piece runs it in this session, as a
        // browser showing it does, so its rendering's own values are derived.
        const surface = await session.link(SURFACE_PIECE);
        await harness.settleUntil(async () => {
          const field = pathTo(
            await session.readRaw(["$UI"], { piece: surface }),
            (node) => node.name === "cf-submit-input",
            ["$UI"],
          );
          return field !== undefined &&
            await session.read([...field, "props", "initialValue"], {
                piece: surface,
              }) === "Sam Lee";
        });
        // The surface's first child is the picture row, whose first child is
        // the picture's `ifElse`, a cell of its own, which shows the
        // picture's region while the suggestion holds one.
        const shown = await session.readRaw(
          ["$UI", "children", 0, "children", 0],
          { piece: surface },
        ) as { props?: Record<string, FabricValue> } | undefined;
        expect(shown?.props?.["data-ui-region"]).toBe(
          "profile-create-picture-preview",
        );
      });
    });
  }
});
