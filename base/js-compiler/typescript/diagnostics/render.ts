export interface ErrorRenderLocation {
  line: number;
  column: number;
  source: string;
}

export interface ErrorRenderInlineConfig extends ErrorRenderLocation {
  // The number of lines before and after the failing
  // line to render.
  contextLines: number;
}

function repeat(character: string, times: number): string {
  return new Array(times).fill(character).join("");
}
function renderLine(
  line: number | string,
  content: string,
  lineNumPad: number,
) {
  return `${String(line).padStart(lineNumPad, " ")} | ${content}\n`;
}

// Renders the inline portion of an error.
//
// ```
// 1 |
// 2 |
// 3 |
// 4 |
// ```
export function renderInline(
  { contextLines, line, source, column }: ErrorRenderInlineConfig,
): string {
  const lines = source.split("\n");
  const targetLine = line - 1;
  const preambleLineStart = Math.max(targetLine - contextLines, 0);
  const preambleLineEnd = targetLine;
  const postambleLineStart = targetLine + 1;
  const postambleLineEnd = Math.min(
    postambleLineStart + contextLines,
    lines.length - 1,
  );
  // Find the number of digits in the largest line
  // that will be displayed
  const lineNumPad = Math.min(
    String(targetLine + contextLines).length,
    10,
  );

  let inline = "";

  inline += lines.slice(
    preambleLineStart,
    preambleLineEnd,
  ).map((line, index) =>
    renderLine(preambleLineStart + index + 1, line, lineNumPad)
  ).join("");
  inline += renderLine(targetLine + 1, lines[targetLine], lineNumPad);
  inline += renderLine("", `${repeat(" ", column - 1)}^`, lineNumPad);
  inline += lines.slice(
    postambleLineStart,
    postambleLineEnd,
  ).map((line, index) =>
    renderLine(targetLine + 1 + index + 1, line, lineNumPad)
  ).join("");

  return inline;
}
