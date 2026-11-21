/**
 * Tests the trusted-surfaces index page: it names itself and points readers at
 * the module the reusable surfaces come from.
 *
 * Run: deno task cf test patterns/examples/cfc-trusted-surfaces/main.test.tsx
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import TrustedSurfaces from "./main.tsx";

export default pattern(() => {
  const subject = TrustedSurfaces({});

  return {
    [TESTS]: [
      { assertion: assert(() => subject[NAME] === "CFC Trusted Surfaces") },
      {
        assertion: assert(() =>
          hasText(subject[UI], "Reusable trusted sub-UIs") &&
          hasText(subject[UI], "patterns/system/cfc")
        ),
      },
    ],
    subject,
  };
});
