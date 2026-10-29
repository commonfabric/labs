import { CFPieceMenu } from "./cf-piece-menu.ts";

if (!customElements.get("cf-piece-menu")) {
  customElements.define("cf-piece-menu", CFPieceMenu);
}

export type { CFPieceMenu as CFPieceMenuElement } from "./cf-piece-menu.ts";

export * from "./cf-piece-menu.ts";
export * from "./origin-view.ts";
