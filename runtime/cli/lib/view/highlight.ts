/**
 * Turns model {@link Span}s into ANSI-colored strings. Used both by the
 * non-interactive print path (`renderLineColored` over every line) and as the
 * per-span styling primitive for the interactive renderer.
 *
 * Color never changes the active representation's characters:
 * `renderLinePlain` and the concatenated span text of `renderLineColored` are
 * byte-for-byte identical to the document line.
 */

import { paint, type Style } from "./ansi.ts";
import type { Line, Span } from "./model.ts";
import { bracketStyle, dialogStyleFor, lineBg, styleFor } from "./theme.ts";

/** Resolve the ANSI {@link Style} for a span (bracket spans rainbow by depth). */
export function spanStyle(span: Span): Style {
  const base = span.cls === "bracket" && span.bracketDepth !== undefined
    ? bracketStyle(span.bracketDepth)
    : styleFor(span.cls);
  return withRichModifiers(base, span);
}

/** The style for a span shown inside a dialog (a light-gray panel), where the
 * editor's bright colors would not read. */
export function overlaySpanStyle(span: Span): Style {
  return withRichModifiers(dialogStyleFor(span.cls), span);
}

/** Apply only modifiers that a rendered span explicitly turns on. */
function withRichModifiers(style: Style, span: Span): Style {
  return {
    ...style,
    ...(span.bold ? { bold: true } : {}),
    ...(span.italic ? { italic: true } : {}),
    ...(span.underline ? { underline: true } : {}),
    ...(span.strikethrough ? { strikethrough: true } : {}),
  };
}

/** The active source or rendered line, with no color. */
export function renderLinePlain(line: Line): string {
  return line.text;
}

/** The line with every span painted. `color === false` returns verbatim text. */
export function renderLineColored(line: Line, color: boolean): string {
  if (!color) return line.text;
  const bg = line.bg ? { bg: lineBg(line.bg) } : undefined;
  let out = "";
  for (const span of line.spans) {
    const style = bg ? { ...spanStyle(span), ...bg } : spanStyle(span);
    out += paint(span.text, style);
  }
  return out;
}
