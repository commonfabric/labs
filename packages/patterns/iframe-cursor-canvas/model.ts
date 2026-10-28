/**
 * The rules of the cursor canvas that need no browser: reading what a peer
 * published to the presence room, and the arithmetic of names, hues, and
 * positions. A facet is whatever a peer's guest wrote, so each reader here
 * holds one to its shape and returns `undefined` for anything else.
 */

import { normalizePresenceParticipantName } from "../shared-note/participant-name.ts";
import type { CanvasShape, Point, ShapeBox } from "./contract.ts";

/** Width of the board, in board pixels. */
export const BOARD_WIDTH = 1600;

/** Height of the board, in board pixels. */
export const BOARD_HEIGHT = 1000;

/** The facet a participant's pointer position travels under. */
export const POINTER_FACET = "pointer";

/** The facet a shape held mid-drag travels under. */
export const DRAG_FACET = "drag";

/** The facet a participant's chosen hue travels under. */
export const USER_FACET = "user";

/** Smallest width or height a resize leaves a shape, in board pixels. */
export const MIN_SHAPE_SIZE = 24;

/** A corner of a shape's bounding box, which a resize handle sits on. */
export type Corner = "nw" | "ne" | "sw" | "se";

/** A shape a peer holds mid-drag or mid-resize, as the peer holds it. */
export interface PeerDrag {
  /** Id of the shape. */
  id: string;

  /** Top-left corner the peer has moved the shape to. */
  position: Point;

  /**
   * The size the peer has resized the shape to, or `undefined` when the
   * peer's facet carries none and the shape keeps its own.
   */
  size: ShapeSize | undefined;
}

/** What one peer shows on the board, read from its presence record. */
export interface Peer {
  /** Id of the peer's membership in the room. */
  participantId: string;

  /** Display name the peer published. */
  name: string;

  /** Hue the peer chose, or one derived from its id when it published none. */
  hue: number;

  /** Where the peer's pointer is, or `undefined` while it is off the board. */
  pointer: Point | undefined;

  /** The shape the peer is dragging, or `undefined` while it drags none. */
  drag: PeerDrag | undefined;
}

/** A presence record as the bridge delivers one. */
export interface PeerRecord {
  /** Id of the membership the record belongs to. */
  participantId: string;

  /** Display name the member published. */
  name: string;

  /** What the member published, by facet name. */
  facets: Readonly<Record<string, unknown>>;
}

/** The box a dragged shape has to stay inside the board. */
export interface ShapeSize {
  /** Width of the box, in board pixels. */
  width: number;

  /** Height of the box, in board pixels. */
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns `point` moved to the nearest position on the board. */
export function clampToBoard(point: Point, size?: ShapeSize): Point {
  const maxX = BOARD_WIDTH - (size?.width ?? 0);
  const maxY = BOARD_HEIGHT - (size?.height ?? 0);
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(maxX, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(maxY, 0)),
  };
}

/**
 * Reads `value` as a point on the board, or returns `undefined` unless it
 * holds finite `x` and `y` numbers. A point off the board is moved onto it.
 */
export function readPoint(value: unknown): Point | undefined {
  if (
    !isRecord(value) || typeof value.x !== "number" ||
    typeof value.y !== "number" || !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  ) {
    return undefined;
  }
  return clampToBoard({ x: value.x, y: value.y });
}

/** Reads `value` as a hue in `[0, 360)`, or returns `undefined`. */
export function readHue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return ((Math.round(value) % 360) + 360) % 360;
}

/** Returns a hue that is the same for the same `seed` everywhere. */
export function hueOf(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

/** Reads a `drag` facet, or returns `undefined` for any other shape. */
export function readDrag(value: unknown): PeerDrag | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return undefined;
  }
  const position = readPoint(value.position);
  if (!position) return undefined;
  if (value.width === undefined && value.height === undefined) {
    return { id: value.id, position, size: undefined };
  }
  const width = readLength(value.width, BOARD_WIDTH);
  const height = readLength(value.height, BOARD_HEIGHT);
  if (width === undefined || height === undefined) return undefined;
  const size = { width, height };
  return { id: value.id, position: clampToBoard(position, size), size };
}

/**
 * Reads `value` as a shape's width or height, at least `MIN_SHAPE_SIZE` and
 * at most `max`, or returns `undefined` unless it is a finite number.
 */
function readLength(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), MIN_SHAPE_SIZE), max);
}

/** Reads what `record` shows on the board, ignoring every facet it cannot. */
export function readPeer(record: PeerRecord): Peer {
  const user = record.facets[USER_FACET];
  return {
    participantId: record.participantId,
    name: record.name,
    hue: (isRecord(user) ? readHue(user.hue) : undefined) ??
      hueOf(record.participantId),
    pointer: readPoint(record.facets[POINTER_FACET]),
    drag: readDrag(record.facets[DRAG_FACET]),
  };
}

/** Returns the name a first-time visitor is given, numbered from `seed`. */
export function visitorName(seed: number): string {
  return `Visitor ${100 + (Math.abs(Math.trunc(seed)) % 900)}`;
}

/**
 * Returns `draft` as a name the presence relay accepts, or `fallback` when
 * nothing printable is left of it.
 */
export function displayNameOf(draft: string, fallback: string): string {
  return normalizePresenceParticipantName(draft) || fallback;
}

/**
 * Returns the top-left corner of a shape of `size` held at `grab`, an offset
 * from that corner, while the pointer is at `pointer`. The shape stays on the
 * board.
 */
export function dragPosition(
  pointer: Point,
  grab: Point,
  size: ShapeSize,
): Point {
  return clampToBoard({
    x: Math.round(pointer.x - grab.x),
    y: Math.round(pointer.y - grab.y),
  }, size);
}

/**
 * Returns the box `from` takes when its `corner` is dragged to `pointer`.
 * The opposite corner stays where it is, neither side shrinks below
 * `MIN_SHAPE_SIZE`, and the box stays on the board.
 */
export function resizeBox(
  from: ShapeBox,
  corner: Corner,
  pointer: Point,
): ShapeBox {
  const target = clampToBoard({
    x: Math.round(pointer.x),
    y: Math.round(pointer.y),
  });
  const left = from.position.x;
  const top = from.position.y;
  const right = left + from.width;
  const bottom = top + from.height;
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const x0 = west ? Math.min(target.x, right - MIN_SHAPE_SIZE) : left;
  const x1 = west ? right : Math.max(target.x, left + MIN_SHAPE_SIZE);
  const y0 = north ? Math.min(target.y, bottom - MIN_SHAPE_SIZE) : top;
  const y1 = north ? bottom : Math.max(target.y, top + MIN_SHAPE_SIZE);
  return {
    position: { x: x0, y: y0 },
    width: x1 - x0,
    height: y1 - y0,
  };
}

/** Returns whether `a` and `b` are the same box. */
export function sameBox(a: ShapeBox, b: ShapeBox): boolean {
  return a.position.x === b.position.x && a.position.y === b.position.y &&
    a.width === b.width && a.height === b.height;
}

/**
 * Returns a new shape of `kind`. Each `sequence` number puts it a step
 * further down and to the right, so shapes added in a row do not stack.
 */
export function createShape(
  kind: CanvasShape["kind"],
  id: string,
  hue: number,
  sequence: number,
): CanvasShape {
  const step = (Math.abs(Math.trunc(sequence)) % 10) * 28;
  const size = kind === "ellipse"
    ? { width: 150, height: 150 }
    : { width: 200, height: 130 };
  return {
    id,
    kind,
    box: {
      position: clampToBoard({ x: 260 + step, y: 140 + step }, size),
      ...size,
    },
    hue,
    removed: false,
  };
}

/** Returns the index of the shape with `id`, or `-1`. */
export function shapeIndex(shapes: readonly CanvasShape[], id: string): number {
  return shapes.findIndex((shape) => shape.id === id);
}
