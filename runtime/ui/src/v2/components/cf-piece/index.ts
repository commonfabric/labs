import { CFPiece } from "./cf-piece.ts";

if (!customElements.get("cf-piece")) {
  customElements.define("cf-piece", CFPiece);
}

export type { CFPiece as CFPieceElement } from "./cf-piece.ts";

export * from "./cf-piece.ts";
