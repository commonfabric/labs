/**
 * Pins the warning a pattern gets where a schema it generates could not read
 * part of a type and accepts any value there instead.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformFiles } from "./utils.ts";

/** A pattern whose `computed()` reads `name` from a captured cell of `value`. */
const readContact = (value: string) =>
  `export default pattern<{ contact: Writable<${value}> }>(({ contact }) => {
     return { label: computed(() => contact.key("name").get()) };
   });`;

/** The unread-type warnings compiling `files` reports. */
async function unreadWarnings(
  files: Record<string, string>,
): Promise<TransformationDiagnostic[]> {
  const diagnostics: TransformationDiagnostic[] = [];
  await transformFiles(files, {
    types: COMMONFABRIC_TYPES,
    pipelineDiagnostics: diagnostics,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === "schema-type:unread"
  );
}

describe("unread-type-diagnostic", () => {
  it("warns where the value type of a captured cell is left unread", async () => {
    // Node-based analysis leaves this generic the module exports unread, and
    // the lift's input accepts any value in its place.
    const warnings = await unreadWarnings({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        export interface Contact<T = number> { name: T }
        ${readContact("Contact<string>")}`,
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.fileName).toBe("/test.tsx");
    expect(warnings[0]!.message).toContain("`Contact<string>`");
  });

  describe("a captured type declared as `any`", () => {
    /** A pattern whose `computed()` reads a captured cell of `Deliberate`. */
    const readDeliberate = (declaration: string) =>
      `import { computed, pattern, Writable } from "commonfabric";
        ${declaration}
        export default pattern<{ a: Writable<Deliberate> }>(({ a }) => ({
          label: computed(() => a.get()),
        }));`;

    it("does not warn where the module declares it", async () => {
      const warnings = await unreadWarnings({
        "/test.tsx": readDeliberate("type Deliberate = any;"),
      });

      expect(warnings).toEqual([]);
    });

    it("does not warn where the module declares it with `export`", async () => {
      const warnings = await unreadWarnings({
        "/test.tsx": readDeliberate("export type Deliberate = any;"),
      });

      expect(warnings).toEqual([]);
    });
  });

  it("does not warn for a captured type the module declares", async () => {
    const warnings = await unreadWarnings({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        interface Contact { name: string }
        ${readContact("Contact")}`,
    });

    expect(warnings).toEqual([]);
  });
});
