/**
 * Shared fixtures and helpers for the `cf view` test suites. Not a test file
 * itself (the test task globs `*.test.ts`), just an import.
 */

import { parseDocument } from "../lib/view/languages/typescript/parse.ts";
import { renderFrame, type ViewState } from "../lib/view/render.ts";
import { type Rgb, stripAnsi, term } from "../lib/view/ansi.ts";
import type { Key } from "../lib/view/keys.ts";
import type { Session } from "../lib/view/session.ts";

export { parseDocument };

/** The `48;2;r;g;b` background run for a color, as it appears in an SGR escape;
 * lets a test assert on a theme color without hard-coding its hex. */
export function bgCode(rgb: Rgb): string {
  return `48;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/** The `38;2;r;g;b` foreground run for a color. */
export function fgCode(rgb: Rgb): string {
  return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/** The visible text of a modal prompt dialog — its title, body lines and button
 * labels joined — so a test can assert on the prompt with a single `includes`.
 * Empty string when no dialog is up. */
export function promptText(v: ViewState): string {
  const d = v.dialog;
  if (!d) return "";
  return [d.title, ...d.body, ...d.buttons.map((b) => b.label)].join(" ");
}

/**
 * Returns the zero-based screen cell where `text` first appears among the drawn
 * `rows`, for a test to aim the mouse at. Throws when no row shows it.
 */
export function cellOf(
  rows: readonly string[],
  text: string,
): { x: number; y: number } {
  for (let y = 0; y < rows.length; y++) {
    const x = stripAnsi(rows[y]).indexOf(text);
    if (x >= 0) return { x, y };
  }
  throw new Error(`no row shows ${JSON.stringify(text)}`);
}

/** Returns the rows the screen shows for `s`. */
export function drawnRows(s: Session): string[] {
  return renderFrame(s.displayDoc(), s.view());
}

/**
 * Returns the rows of a frame the pager wrote, one per screen row. Each row
 * starts after the escape that clears its line.
 */
export function frameRows(text: string): string[] {
  return text.split(term.clearLine).slice(1);
}

/** Returns the key of the primary mouse button going down or coming up. */
export function mouseKey(down: boolean, at: { x: number; y: number }): Key {
  return { name: "mouse", mouse: { down, ...at } };
}

/**
 * A small but representative transformed blob: two sections, synthetic helpers,
 * a hoisted lift with JSON schemas + a closure, a pattern, a template literal,
 * a type alias and an interface.
 */
export const SAMPLE = `// transformed: /index.ts
const define = undefined;

// transformed: /app.ts
import { __cfHelpers } from "commonfabric";
import { pattern, lift } from "commonfabric";
const __cfLift_1 = __cfHelpers.lift<{
    token: string;
}, string>({
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ token }) => {
    return \`url:\${token}\`;
});
export const myPattern = pattern((input) => {
    const t = input.key("token");
    return { url: __cfLift_1({ token: t }) };
}, {
    type: "object"
} as const satisfies __cfHelpers.JSONSchema);
type Foo = {
    a: number;
    b: string;
};
interface Bar {
    x: number;
}
`;

/** Valid TypeScript that triggers a compiler crash when parsed as TSX. The
 * generic arrow enters JSX recovery. The later private member produces a
 * malformed private identifier. */
export const TS_PARSER_REGRESSION =
  `export const identity = <T>(value: T): T => {
  return value;
};
class Tx {
  #floor = 0;
  set(mode: number): void {
    if (mode < this.#floor) {}
  }
}
`;

/** Encode a string to bytes for the key decoder. */
export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Raw byte array helper. */
export function raw(...nums: number[]): Uint8Array {
  return new Uint8Array(nums);
}
