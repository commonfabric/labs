/**
 * The scenarios of the fixtures under `fixtures/`.
 *
 * Each `<name>.plan.json` is the output of the crate for `<name>.tsx`.
 * Regenerate one from `base/pattern-compiler` with
 * `cargo run --release -- plan compare/fixtures/<name>.tsx > compare/fixtures/<name>.plan.json`.
 */
import { compareScenario, type Plan, type Row } from "./harness.ts";
import { atomKey, type Label } from "./template.ts";

const read = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const compare = async (
  name: string,
  argument: Record<string, unknown>,
  selected: Record<number, number>,
): Promise<Row[]> => {
  const [{ patterns }] = JSON.parse(await read(`${name}.plan.json`));
  return compareScenario({
    program: {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: await read(`${name}.tsx`) }],
    },
    plan: patterns[0].plan as Plan,
    argument,
    selected,
  });
};

/** Runs `fixtures/small.tsx` with `flag` and compares each of its outputs. */
export const compareSmall = (flag: boolean): Promise<Row[]> =>
  compare(
    "small",
    {
      secret: "s3cret",
      note: "n",
      flag,
      items: [{ title: "a", done: false }, { title: "b", done: true }],
    },
    // Selector 0 is the conditional of `chosen` and selector 1 that of
    // `direct`, in the order the plan lists them. Both test `flag`.
    { 0: flag ? 0 : 1, 1: flag ? 0 : 1 },
  );

/**
 * Runs `fixtures/is-edited.tsx`, the `isEdited` of a FabriChat message row
 * (PL §6.2, `T_edited`), over a message that was edited or was not.
 */
export const compareIsEdited = (edited: boolean): Promise<Row[]> =>
  compare(
    "is-edited",
    {
      message: {
        body: "hello",
        sentAt: 1,
        ...(edited ? { editedAt: 2 } : {}),
      },
    },
    // `a && b` is `select(a, [b, a])`: branch 0 where `editedAt` is set.
    { 0: edited ? 0 : 1 },
  );

/**
 * Runs `fixtures/defaulted.tsx`: an input object with a declared integrity
 * atom and one property a default fills (ruling T1), read whole and by
 * property. With `given`, the argument supplies the property.
 */
export const compareDefaulted = (given: boolean): Promise<Row[]> =>
  compare(
    "defaulted",
    { profile: { name: "ada", ...(given ? { nick: "a" } : {}) } },
    {},
  );

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
