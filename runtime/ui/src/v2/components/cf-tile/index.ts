import { CFTile } from "./cf-tile.ts";

if (!customElements.get("cf-tile")) {
  customElements.define("cf-tile", CFTile);
}

export type { CFTile as CFTileElement } from "./cf-tile.ts";

export * from "./cf-tile.ts";
