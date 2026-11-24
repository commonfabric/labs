import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { urlToAppView } from "@commonfabric/navigation";
import { pieceUrl } from "../src/piece-url.ts";

const SPACE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("pieceUrl()", () => {
  it("returns the base, the space's DID, and the slug, which the shell reads back", () => {
    const url = pieceUrl("http://localhost:8000", SPACE, "reading-list");
    expect(url).toBe(`http://localhost:8000/${SPACE}/reading-list`);
    expect(urlToAppView(new URL(url!))).toEqual({
      spaceDid: SPACE,
      pieceSlug: "reading-list",
    });
  });

  it("keeps a path on the base, with or without its trailing slash", () => {
    for (const base of ["http://host.test/pane", "http://host.test/pane/"]) {
      expect(pieceUrl(base, SPACE, "reading-list")).toBe(
        `http://host.test/pane/${SPACE}/reading-list`,
      );
    }
  });

  it("returns no URL for a base that is not one", () => {
    expect(pieceUrl("http://[invalid", SPACE, "reading-list"))
      .toBeUndefined();
    expect(pieceUrl("not a url", SPACE, "reading-list")).toBeUndefined();
  });
});
