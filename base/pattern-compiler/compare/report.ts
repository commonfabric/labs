/**
 * Prints the comparison of each fixture as a table: per output path,
 * the label the runtime stored, the label the template yields, and how the
 * template stands to the runtime.
 *
 * Run from the repository root:
 * `deno run -A --no-check base/pattern-compiler/compare/report.ts`
 */
import {
  compareDefaulted,
  compareIsEdited,
  compareSmall,
  showLabel,
} from "./scenarios.ts";
import type { Row } from "./harness.ts";

const table = (title: string, rows: Row[]) => {
  console.log(`\n${title}\n`);
  console.log(
    "| path | runtime | template | template, as stored | C | I | overall |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const { confidentiality, integrity, overall } = row.comparison;
    console.log(
      `| ${row.path.join("/")} | ${showLabel(row.runtime)} | ${
        showLabel(row.reached.label)
      } | ${
        showLabel(row.stored.label)
      } | ${confidentiality} | ${integrity} | ${overall} |`,
    );
  }
};

for (const flag of [true, false]) {
  table(`small, flag = ${flag}`, await compareSmall(flag));
}
for (const edited of [true, false]) {
  table(`is-edited, edited = ${edited}`, await compareIsEdited(edited));
}
for (const given of [false, true]) {
  table(`defaulted, nick given = ${given}`, await compareDefaulted(given));
}
