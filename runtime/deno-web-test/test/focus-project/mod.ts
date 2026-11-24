/**
 * Registers the one test of the file numbered `file`, which fails unless the
 * page has focus.
 */
export function requireFocus(file: number): void {
  Deno.test(`the page has focus in file ${file}`, () => {
    if (!document.hasFocus()) {
      throw new Error(`the page has no focus in file ${file}`);
    }
  });
}
