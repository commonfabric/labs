/**
 * Module-scope function hardening emits an identity annotation for a top-level
 * binding that a WriteAuthorizedBy type references. The existing coverage of
 * that annotation comes from `const name = handler(...)` variable bindings;
 * the statement-form path for a plain `function` declaration ran only as a
 * side effect of patterns compiling through the transformer in CI. These tests
 * drive it directly.
 */

import { assertEquals } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

Deno.test(
  "trusted WriteAuthorizedBy function declaration gets a statement-form binding annotation",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, WriteAuthorizedBy } from "commonfabric";

      function saveTitle(): string {
        return "x";
      }

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: WriteAuthorizedBy<string, typeof saveTitle>;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

    // The function declaration is preserved and followed by an identity
    // annotation for its trusted binding.
    assertEquals(output.includes("function saveTitle()"), true);
    assertEquals(output.includes("__cfBindVerifiedBinding(saveTitle, {"), true);
  },
);

Deno.test(
  "untrusted function declaration is hardened without a binding annotation",
  async () => {
    const source = `/// <cts-enable />
      import { pattern } from "commonfabric";

      function helper(): string {
        return "x";
      }

      interface Input {
        title: string;
      }

      interface Output {
        savedTitle: string;
      }

      export default pattern<Input, Output>(({ title }) => ({
        savedTitle: title,
      }));
    `;

    const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

    // No WriteAuthorizedBy reference, so `helper` is not a trusted binding and
    // no identity annotation is emitted for it, even though the function is
    // still hardened.
    assertEquals(output.includes("__cfBindVerifiedBinding(helper"), false);
    assertEquals(output.includes("function helper()"), true);
  },
);
