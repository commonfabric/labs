// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { type AppView, NAVIGATE_EVENT } from "@commonfabric/navigation";

import type { PieceItem } from "../src/components/PieceList.ts";
import { installBrowserGlobals } from "./browser-globals.ts";
import { templateMarkup } from "./lit-template-markup.ts";

const USER_SPACE: DID = "did:key:z6MkhomeSpaceOfTheSignedInUser";
const OTHER_SPACE: DID = "did:key:z6MkanotherSpaceAddressedByDid";

/**
 * What the header on `view`, in the space `space`, shows for its space link,
 * and where it navigates when the link is clicked and when a piece is picked
 * from its piece switcher.
 */
async function spaceLink(view: AppView, space: DID): Promise<{
  href: string | undefined;
  labels: (string | undefined)[];
  markup: string;
  click: AppView[];
  pick: AppView[];
}> {
  const restore = installBrowserGlobals("http://localhost:8000/");
  const navigations: AppView[] = [];
  const record = (event: Event) => {
    if (event instanceof CustomEvent) navigations.push(event.detail);
  };
  globalThis.addEventListener(NAVIGATE_EVENT, record);
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const header = new XHeaderView();
    header.view = view;
    header.space = space;
    header.pieceId = "current";

    const markup = templateMarkup(header.render());
    const href = markup.match(/class="header-space"\s+href="([^"]*)"/)?.[1];
    const labels = [
      markup.match(/class="header-space"[^]*?>([^<>]*)<\/a>/)?.[1],
      markup.match(/class="breadcrumb-text">([^<]*)</)?.[1],
    ];
    header.accessForTestingOnly.handleSpaceClick(new Event("click"));
    const click = navigations.splice(0);
    header.accessForTestingOnly.handlePieceSelected(
      new CustomEvent<PieceItem>("piece-selected", {
        detail: { id: "picked", name: "Picked" },
      }),
    );
    const pick = navigations.splice(0);
    return { href, labels, markup, click, pick };
  } finally {
    globalThis.removeEventListener(NAVIGATE_EVENT, record);
    restore();
  }
}

describe("XHeaderView space link", () => {
  it("links, labels, and navigates the home view as the home view", async () => {
    const link = await spaceLink({ builtin: "home" }, USER_SPACE);

    expect(link.href).toBe("/");
    expect(link.labels).toEqual(["Home", "Home"]);
    expect(link.click).toEqual([{ builtin: "home" }]);
    expect(link.markup).not.toContain("<home>");
    expect(link.markup).not.toContain("%3Chome%3E");
    expect(link.markup).not.toContain(USER_SPACE);
  });

  it("opens a piece picked on the home view in the signed-in user's space", async () => {
    const link = await spaceLink({ builtin: "home" }, USER_SPACE);

    expect(link.pick).toEqual([{ spaceDid: USER_SPACE, pieceId: "picked" }]);
  });

  it("links, labels, and navigates a named space by its name", async () => {
    const link = await spaceLink(
      { spaceName: "My notes", pieceId: "current" },
      OTHER_SPACE,
    );

    expect(link.href).toBe("/My%20notes");
    expect(link.labels).toEqual(["My notes", "My notes"]);
    expect(link.click).toEqual([{ spaceName: "My notes" }]);
    expect(link.pick).toEqual([{ spaceName: "My notes", pieceId: "picked" }]);
  });

  it("links, labels, and navigates a space addressed by DID by its DID", async () => {
    const link = await spaceLink(
      { spaceDid: OTHER_SPACE, pieceId: "current" },
      OTHER_SPACE,
    );
    const label = `${OTHER_SPACE.slice(0, 20)}...`;

    expect(link.href).toBe(`/${OTHER_SPACE}`);
    expect(link.labels).toEqual([label, label]);
    expect(link.click).toEqual([{ spaceDid: OTHER_SPACE }]);
    expect(link.pick).toEqual([{ spaceDid: OTHER_SPACE, pieceId: "picked" }]);
  });
});
