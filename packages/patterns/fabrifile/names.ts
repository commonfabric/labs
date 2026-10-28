/**
 * The rules a FabriFile name is held to, and the choice of a free name for a
 * file whose own is taken (`docs/specs/fabrifile/FileEntry.md`, "Names"). A
 * name is one path segment, valid as a file name on the common file systems,
 * so that a store can be written out as a directory with one file per entry
 * and nothing renamed.
 */

/** The most bytes a name may take as UTF-8. */
export const MAX_NAME_BYTES = 255;

/**
 * The bytes `freeName()` keeps free for a number and a character before it, as
 * ` (99999999)a` takes, before it keeps a name's extension apart.
 */
const NUMBER_ROOM = 16;

/**
 * The characters no name may hold: `/`, `\`, and every control character,
 * which are what the pattern exists to match.
 */
// deno-lint-ignore no-control-regex
const FORBIDDEN = /[/\\\u0000-\u001f\u007f]/;

/** An unpaired surrogate, which no well-formed string holds. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Returns how many bytes `text`, which is well-formed, takes as UTF-8. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return length;
}

/**
 * Indicates whether `name` may name a file in a store: a string of well-formed
 * Unicode in Normalization Form C, of 1 to {@link MAX_NAME_BYTES} bytes as
 * UTF-8, holding no `/`, `\` or control character, not starting with `.`, and
 * not ending with a space or a `.`.
 */
export function isValidName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 &&
    !LONE_SURROGATE.test(name) &&
    name.normalize("NFC") === name &&
    utf8Length(name) <= MAX_NAME_BYTES &&
    !FORBIDDEN.test(name) &&
    !name.startsWith(".") &&
    !name.endsWith(" ") && !name.endsWith(".");
}

/**
 * Returns `name` when `isTaken` says it is free, and otherwise the first of
 * `name (2)`, `name (3)`, and so on that is, the number going before the
 * name's last extension: `photo.png` becomes `photo (2).png`. Where the number
 * would take the name past {@link MAX_NAME_BYTES}, the part before it is
 * shortened to fit, and where even the extension leaves no room, the number
 * goes at the end of the shortened name instead. `name` is a valid name, and
 * so is what is returned.
 */
export function freeName(
  name: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isTaken(name)) return name;
  const dot = name.lastIndexOf(".");
  // An extension too long to keep room for a number and one character before
  // it is numbered as part of the name.
  const fits = dot > 0 &&
    utf8Length(name.slice(dot)) + NUMBER_ROOM <= MAX_NAME_BYTES;
  const stem = fits ? name.slice(0, dot) : name;
  const extension = fits ? name.slice(dot) : "";
  for (let number = 2;; number++) {
    const suffix = ` (${number})${extension}`;
    const candidate = shortened(stem, MAX_NAME_BYTES - utf8Length(suffix)) +
      suffix;
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * Helper for {@link freeName}, which returns the longest prefix of `text` that
 * takes at most `bytes` bytes as UTF-8, cut between code points, and with no
 * space or `.` left at its end.
 */
function shortened(text: string, bytes: number): string {
  let result = "";
  let length = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (length + size > bytes) break;
    result += char;
    length += size;
  }
  return result.replace(/[ .]+$/, "");
}
