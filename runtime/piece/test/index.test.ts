import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as entry from "../src/index.ts";
import { pieceId } from "../src/piece-id.ts";
import * as slugs from "../src/slugs.ts";

describe("index", () => {
  it("exports `pieceId()` and the slug API under their own names, and nothing else", () => {
    const slugNames = [
      "assignSlug",
      "listSlugs",
      "readSlugBinding",
      "resolvePieceAddress",
      "resolvePieceReference",
      "resolveSlugTarget",
      "resolveSlugTargetCell",
      "setSlugLink",
      "SlugAssignedError",
      "SlugReleasedError",
      "SlugResolutionError",
    ] as const;

    expect(Object.keys(entry).sort()).toEqual(["pieceId", ...slugNames].sort());
    expect(entry.pieceId).toBe(pieceId);
    for (const name of slugNames) expect(entry[name]).toBe(slugs[name]);
  });
});
