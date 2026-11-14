/**
 * The scenario of the small fixture, `fixtures/small.tsx`.
 *
 * `fixtures/small.plan.json` is the output of the crate for it. Regenerate
 * it from `base/pattern-compiler` with
 * `cargo run --release -- plan compare/fixtures/small.tsx > compare/fixtures/small.plan.json`.
 */
import { compareScenario, type Plan, type Row } from "./harness.ts";
import { atomKey, type Label } from "./template.ts";

const read = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

/** Runs the fixture with `flag` and compares each of its outputs. */
export const compareSmall = async (flag: boolean): Promise<Row[]> => {
  const [{ patterns }] = JSON.parse(await read("small.plan.json"));
  return compareScenario({
    program: {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: await read("small.tsx") }],
    },
    plan: patterns[0].plan as Plan,
    argument: {
      secret: "s3cret",
      note: "n",
      flag,
      items: [{ title: "a", done: false }, { title: "b", done: true }],
    },
    // Selector 0 is the conditional of `chosen` and selector 1 that of
    // `direct`, in the order the plan lists them. Both test `flag`.
    selected: { 0: flag ? 0 : 1, 1: flag ? 0 : 1 },
  });
};

/**
 * A label on one line: its clauses, then its integrity atoms by type, with
 * `+witness` on a `TransformedBy` atom that carries an input witness.
 */
export const showLabel = (label: Label): string => {
  const clauses = [
    ...new Map(label.confidentiality.map((atom) => [atomKey(atom), atom]))
      .values(),
  ].map((atom) => typeof atom === "string" ? atom : atomKey(atom)).sort();
  const atoms = (label.integrity === "neutral" ? [] : label.integrity).map(
    (atom) => {
      const { type, inputWitness } = atom as {
        type?: string;
        inputWitness?: unknown;
      };
      return `${type?.split("/").pop() ?? atomKey(atom)}${
        inputWitness === undefined ? "" : "+witness"
      }`;
    },
  ).sort();
  return `C {${clauses.join(", ")}} I {${atoms.join(", ")}}`;
};
