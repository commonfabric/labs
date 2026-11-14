/**
 * Prints the comparison of the small fixture as a table: per output path,
 * the label the runtime stored, the label the template yields, and how the
 * template stands to the runtime.
 *
 * Run from the repository root:
 * `deno run -A --no-check base/pattern-compiler/compare/report.ts`
 */
import { compareSmall, showLabel } from "./small.ts";

for (const flag of [true, false]) {
  console.log(`\nflag = ${flag}\n`);
  console.log(
    "| path | runtime | template | template, as stored | C | I | overall |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of await compareSmall(flag)) {
    const { confidentiality, integrity, overall } = row.comparison;
    console.log(
      `| ${row.path.join("/")} | ${showLabel(row.runtime)} | ${
        showLabel(row.reached.label)
      } | ${
        showLabel(row.stored.label)
      } | ${confidentiality} | ${integrity} | ${overall} |`,
    );
  }
}
