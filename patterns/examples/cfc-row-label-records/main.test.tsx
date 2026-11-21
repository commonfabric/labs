/**
 * Tests the composed-labels records demo: seeding two patient rows lists both
 * diagnoses, since the per-row label fits the ceiling, while the ssn
 * projection of the same rows is refused, since the per-column "pii" label
 * does not.
 *
 * Run: deno task cf test patterns/examples/cfc-row-label-records/main.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findNodeById,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Records from "./main.tsx";

const diagnosisCount = (view: unknown): number =>
  countElements(findNodeById(view, "diagnosis-list"), "cf-label");
const textOf = (view: unknown, id: string): string =>
  textContent(findNodeById(view, id));

export default pattern(() => {
  const subject = Records({});

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject[NAME] === "Per-Row × Per-Column Labels (CFC Phase 3)"
        ),
      },
      // An empty table has no row whose label could exceed the ceiling.
      { assertion: assert(() => diagnosisCount(subject[UI]) === 0) },
      {
        assertion: assert(() =>
          !textOf(subject[UI], "ssn-error").includes(
            "exceeds the declared output ceiling",
          )
        ),
      },

      { action: action(() => subject.seed.send()) },
      { settle: true },

      { assertion: assert(() => diagnosisCount(subject[UI]) === 2) },
      {
        assertion: assert(() =>
          textOf(subject[UI], "diagnosis-list") ===
            "#1 ada@a.example: sprained wrist#2 grace@g.example: common cold"
        ),
      },
      {
        assertion: assert(() => textOf(subject[UI], "diagnosis-error") === ""),
      },
      // The ssn values never reach the view, and the refusal says why.
      { assertion: assert(() => !hasText(subject[UI], "111-22-3333")) },
      {
        assertion: assert(() =>
          textOf(subject[UI], "ssn-error").includes(
            "exceeds the declared output ceiling",
          )
        ),
      },
    ],
    subject,
  };
});
