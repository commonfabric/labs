/**
 * The data contract of the cursor canvas: a shared board of shapes whose
 * durable state lives in cells, and whose pointers and in-flight drags travel
 * through the presence room of that state and are stored nowhere.
 */

/** A point on the board, in board pixels from its top-left corner. */
export interface Point {
  /** Distance from the board's left edge. */
  x: number;

  /** Distance from the board's top edge. */
  y: number;
}

/**
 * Where a shape sits: its bounding box on the board. It is one field of the
 * shape, so a move or a resize is one write that touches nothing else.
 */
export interface ShapeBox {
  /** Top-left corner of the box. */
  position: Point;

  /** Width of the box, in board pixels. */
  width: number;

  /** Height of the box, in board pixels. */
  height: number;
}

/** One shape on the board. */
export interface CanvasShape {
  /** Stable id, minted by the guest that added the shape. */
  id: string;

  /** Outline drawn inside the shape's bounding box. */
  kind: "rectangle" | "ellipse";

  /** The shape's bounding box. */
  box: ShapeBox;

  /** Fill hue, in degrees. */
  hue: number;

  /** Whether the shape was removed. A removed shape stays in the list. */
  removed: boolean;
}

/** What the piece is created with. */
export interface IframeInputData {
  /** Heading shown above the board. */
  title: string;
}

/** The board everyone on the piece shares. */
export interface IframeStateData {
  /** Every shape added to the board, in the order they were added. */
  shapes: CanvasShape[];
}

/** What one user chose to be shown as on every board session of theirs. */
export interface IframeOutputData {
  /** Display name, or the empty string until the user picks one. */
  displayName: string;

  /** Cursor and shape hue in degrees, or `null` until the user picks a name. */
  hue: number | null;
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Cursor Canvas",
};

export const DEFAULT_STATE: IframeStateData = {
  shapes: [],
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  displayName: "",
  hue: null,
};

export const IFRAME_PATTERN = {
  name: "IframeCursorCanvas",
  displayName: "Cursor Canvas",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
  presence: { cursors: "state" },
} as const;
