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
  it("warns where an argument replaces the default of a captured generic", async () => {
    // Read from its declaration, `Contact<string>` would describe `name` as a
    // number, so the captured value is left unread.
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

  it("does not warn for a captured type the module declares", async () => {
    const warnings = await unreadWarnings({
      "/test.tsx": `import { computed, pattern, Writable } from "commonfabric";
        interface Contact { name: string }
        ${readContact("Contact")}`,
    });

    expect(warnings).toEqual([]);
  });
});
