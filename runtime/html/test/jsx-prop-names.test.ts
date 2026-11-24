/**
 * The JSX types declare each element's props by the names the renderer can
 * apply, so a prop TypeScript accepts is one that takes effect. A hyphenated
 * name other than an event, `data-*` or `aria-*` names no property: the
 * compiler warns of it in a pattern, and declaring it here would only teach a
 * spelling that cannot work.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isMisnamedPropName } from "@commonfabric/pattern-contract/jsx-prop-names";

describe("jsx.d.ts", () => {
  it("declares no prop by a name that names no property", async () => {
    const source = await Deno.readTextFile(
      new URL("../src/jsx.d.ts", import.meta.url),
    );
    const misnamed = [...source.matchAll(/^\s*"([^"]+)"\??:\s*(.*)$/gm)]
      // An element's own name, in the table of elements, holds a hyphen too.
      .filter(([, , type]) => !type!.startsWith("CFDOM.DetailedHTMLProps<"))
      .map(([, name]) => name!)
      .filter(isMisnamedPropName);
    expect(misnamed).toEqual([]);
  });
});
