/**
 * The scenarios of the fixtures under `fixtures/`.
 *
 * Each `<name>.plan.json` is the output of the crate for `<name>.tsx`.
 * Regenerate one from `base/pattern-compiler` with
 * `cargo run --release -- plan compare/fixtures/<name>.tsx > compare/fixtures/<name>.plan.json`.
 * `<name>.emit.json` holds the plan with its value code (`emit` in place
 * of `plan`): a scenario with events runs the executor beside today's
 * run, which sends each event where the executor stored the stream.
 */
import { type Plan, type Row, type Run, runScenario } from "./harness.ts";
import { runBesideExecutor } from "./values.ts";
import { atomKey, type Label } from "./template.ts";

const read = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const run = async (
  name: string,
  argument: Record<string, unknown>,
): Promise<Run> => {
  const [{ patterns }] = JSON.parse(await read(`${name}.plan.json`));
  return runScenario({
    program: {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: await read(`${name}.tsx`) }],
    },
    plan: patterns[0].plan as Plan,
    argument,
  });
};

const compare = async (
  name: string,
  argument: Record<string, unknown>,
): Promise<Row[]> => (await run(name, argument)).rows;

/**
 * Runs `fixtures/small.tsx` with `flag`, with how the branch of each
 * conditional was found.
 */
export const runSmall = (flag: boolean): Promise<Run> =>
  run("small", {
    secret: "s3cret",
    note: "n",
    flag,
    items: [{ title: "a", done: false }, { title: "b", done: true }],
  });

/** Runs `fixtures/small.tsx` with `flag` and compares each of its outputs. */
export const compareSmall = async (flag: boolean): Promise<Row[]> =>
  (await runSmall(flag)).rows;

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
  );

/**
 * Runs `fixtures/passed.tsx`: three `computed` values whose template is
 * not a `derive` (note 202).
 */
export const comparePassed = (): Promise<Row[]> =>
  compare("passed", { secret: "s3cret", items: ["a", "b"] });

/**
 * Runs `fixtures/state-declared.tsx`: a state cell whose own type declares
 * a clause, returned by reference.
 */
export const compareStateDeclared = (): Promise<Row[]> =>
  compare("state-declared", { note: "n" });

/**
 * Runs `fixtures/created.tsx`: a `lift` creates a cell under a type that
 * declares a clause and returns its handle, which the pattern passes on to
 * the rendered tree, in place and through an authored function.
 */
export const compareCreated = (): Promise<Row[]> =>
  compare("created", { note: "n" });

/**
 * Runs `fixtures/handler.tsx` and sends one event to its handler, which
 * sets a cell to a value derived from the event and a labeled input, and
 * pushes onto a list. The event's `text` has a label its schema declares.
 */
export const runHandler = async (): Promise<Run> => {
  const [{ patterns }] = JSON.parse(await read("handler.emit.json"));
  return runBesideExecutor(patterns[0], {
    program: {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: await read("handler.tsx") }],
    },
    plan: patterns[0].plan as Plan,
    argument: { secret: "s3cret", note: "n" },
    events: [{ binding: 0, event: { text: "hello", extra: "x" } }],
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
