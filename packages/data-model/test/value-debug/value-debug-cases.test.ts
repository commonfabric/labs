/**
 * The debug renderers, run over the cases recorded as files in
 * `value-debug-cases/`. A file opens with a JavaScript expression which
 * produces a plain object, each of whose properties is one case: the key labels
 * it, and the value is what gets rendered, on its own. The one property that is
 * not a case is `/options`, which holds the options every case in the file is
 * rendered with; a file that binds none renders its cases with the defaults.
 * The expression may run to any number of lines, blank ones included. A line
 * holding nothing but `--`, with a blank line above it and another below,
 * divides the expression from what follows: one section per case, the sections
 * separated by blank lines, each being the label followed by a colon on a line
 * of its own, then three renderings of the value, each starting on a line of
 * its own. The first is its `toCompactDebugString()` rendering, whole. The
 * second is its `toIndentedDebugString()` rendering, which can run to several
 * lines. The third is its `toStructuredDebugValue()` result, the structure the
 * two strings were rendered from, rendered by `toIndentedDebugString()` with
 * every limit at `Infinity` so that it shows whole; where a string rendering
 * interprets a form of the structured value, this rendering shows the form
 * itself. The file's options reach all three calls, and the two that only the
 * compact rendering reads, `maxLength` and `backtickQuote`, therefore reach the
 * compact rendering alone. A recorded rendering is a fact about the renderer,
 * to be read as such when it changes. What `maxLength` does to a compact
 * rendering is `impl.test.ts`'s to check, so no case here is cut by one.
 *
 * The expression is evaluated with every `FabricInstance` and
 * `FabricPrimitive` class in scope under its own name, along with the three
 * abstract base classes and the realm codec's binding symbol, so that a case
 * can define a class of its own; nothing else beyond the language is in
 * scope.
 *
 * To rewrite each file's recorded renderings from the actual ones, run this
 * from the package directory. A new file holds its expression alone, and the
 * rewrite adds the divider and the sections after it:
 *
 * ```
 * UPDATE_GOLDENS=1 deno test --allow-read --allow-write --allow-env \
 *   test/value-debug/value-debug-cases.test.ts
 * ```
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isPlainObject } from "@commonfabric/utils/types";

import { REALM_CODEC } from "@/codec-common/index.ts";
import { BaseFabricSpecialObject } from "@/fabric-bases/index.ts";
import * as fabricInstances from "@/fabric-instances/index.ts";
import * as fabricPrimitives from "@/fabric-primitives/index.ts";
import {
  type CompactDebugStringOptions,
  type DebugValueOptions,
  FabricInstance,
  FabricPrimitive,
  toCompactDebugString,
  toIndentedDebugString,
  toStructuredDebugValue,
} from "@/index.ts";

/** Directory holding the case files. */
const CASES_DIR = new URL("./value-debug-cases/", import.meta.url);

/** Key under which a case file's expression binds its rendering options. */
const OPTIONS_KEY = "/options";

/** The line which divides a case file's expression from its sections. */
const DIVIDER = "--";

/**
 * The divider as it sits in a file, a blank line above it and another below,
 * the one below possibly being the end of the file.
 */
const DIVIDER_PATTERN = /\n\n--\n(?:\n|$)/;

/**
 * Options for rendering a structured value whole: every limit at `Infinity`,
 * which the renderer caps at its absolute maximum for each.
 */
const WHOLE_RENDERING_OPTIONS: DebugValueOptions = {
  maxDepth: Infinity,
  maxArrayLength: Infinity,
  maxBufferLength: Infinity,
  maxProperties: Infinity,
  maxStringLength: Infinity,
  maxStringLines: Infinity,
};

/** Whether to rewrite the recorded renderings instead of checking them. */
const UPDATE_GOLDENS = (() => {
  const query = Deno.permissions.querySync({
    name: "env",
    variable: "UPDATE_GOLDENS",
  });
  return (query.state === "granted") &&
    (Deno.env.get("UPDATE_GOLDENS") === "1");
})();

/** Names and values in scope when a case's expression is evaluated. */
const SCOPE: Record<string, unknown> = Object.fromEntries([
  ...[...Object.entries(fabricInstances), ...Object.entries(fabricPrimitives)]
    .filter(([, value]) =>
      typeof value === "function" && /^Fabric/.test(
        (value as { name: string }).name,
      )
    ),
  ...Object.entries({
    BaseFabricSpecialObject,
    FabricInstance,
    FabricPrimitive,
    REALM_CODEC,
  }),
]);

/**
 * Evaluates a case file's expression, producing the cases it describes and
 * the options they are to be rendered with, the latter `undefined` when the
 * expression binds none.
 *
 * @throws {Error} if the expression produces other than a plain object, or if
 * it binds `/options` to other than a plain object.
 */
function evaluateExpression(expression: string): {
  cases: Record<string, unknown>;
  options: CompactDebugStringOptions | undefined;
} {
  const names = Object.keys(SCOPE);
  const values = names.map((name) => SCOPE[name]);
  const fn = new Function(
    ...names,
    `"use strict";\nreturn (\n${expression}\n);`,
  );
  const result = fn(...values);

  if (!isPlainObject(result, false)) {
    const rendered = toCompactDebugString(result, {
      maxLength: 60,
      backtickQuote: true,
    });
    throw new Error(
      `Case expression must produce a plain object; got ${rendered}`,
    );
  }

  const { [OPTIONS_KEY]: options, ...cases } = result;

  if ((options !== undefined) && !isPlainObject(options, false)) {
    const rendered = toCompactDebugString(options, {
      maxLength: 60,
      backtickQuote: true,
    });
    throw new Error(
      `\`${OPTIONS_KEY}\` must be a plain object; got ${rendered}`,
    );
  }

  return { cases, options: options as CompactDebugStringOptions | undefined };
}

/**
 * Splits a case file into its expression and its recorded sections, one per
 * case. The expression runs to the first divider line that has a blank line
 * on each side of it, and the sections are what follow it, separated by blank
 * lines; the blank lines around the divider belong to neither. A `--` line
 * without both blank lines is not a divider, so an expression may hold one.
 * The split of the sections rests on no rendering holding a blank line, which
 * holds for every rendering but that of an instance whose class name itself
 * holds one, and no case has such a class. A file with no divider, or with
 * nothing after it, is accepted as one with nothing but an expression when
 * the recordings are about to be rewritten.
 *
 * @throws {Error} if the file records no sections, and the recordings are not
 * about to be rewritten.
 */
function parseCaseFile(text: string): {
  expression: string;
  sections: string[];
} {
  const trimmed = text.trimEnd();
  const divider = DIVIDER_PATTERN.exec(trimmed);
  const expression = (divider === null)
    ? trimmed
    : trimmed.slice(0, divider.index).trimEnd();
  const recorded = (divider === null)
    ? ""
    : trimmed.slice(divider.index + divider[0].length).trim();
  const sections = (recorded === "") ? [] : recorded.split("\n\n");

  if ((sections.length === 0) && !UPDATE_GOLDENS) {
    throw new Error("Case file records no sections.");
  }

  return { expression, sections };
}

/**
 * Renders one case as its recorded section: the label and a colon, the
 * compact rendering, the indented rendering, and the structured value
 * rendered whole, each starting on a line of its own. `options` are the
 * file's, passed to each of the three calls that render `value`.
 */
function renderSection(
  label: string,
  value: unknown,
  options: CompactDebugStringOptions | undefined,
): string {
  const compact = toCompactDebugString(value, options);
  const indented = toIndentedDebugString(value, options);
  const structured = toIndentedDebugString(
    toStructuredDebugValue(value, options),
    WHOLE_RENDERING_OPTIONS,
  );
  return `${label}:\n${compact}\n${indented}\n${structured}`;
}

/** Names of the case files, sorted for a stable test order. */
const caseNames = [...Deno.readDirSync(CASES_DIR)]
  .filter((entry) => entry.isFile && entry.name.endsWith(".txt"))
  .map((entry) => entry.name.replace(/\.txt$/, ""))
  .sort();

describe("value-debug-cases", () => {
  for (const name of caseNames) {
    it(`renders \`${name}\` as recorded`, async () => {
      const url = new URL(`${name}.txt`, CASES_DIR);
      const recorded = parseCaseFile(await Deno.readTextFile(url));
      const { cases, options } = evaluateExpression(recorded.expression);
      const actual = Object.entries(cases).map(([label, value]) =>
        renderSection(label, value, options)
      );

      if (UPDATE_GOLDENS) {
        await Deno.writeTextFile(
          url,
          `${recorded.expression}\n\n${DIVIDER}\n\n${actual.join("\n\n")}\n`,
        );
        return;
      }

      expect(actual).toEqual(recorded.sections);
    });
  }
});
