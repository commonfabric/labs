import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { exists } from "@std/fs";
import { Identity } from "@commonfabric/identity";
import { recordsSpooledBy } from "@commonfabric/test-support/records";
import {
  AUTO,
  AUTO_GENERATIONS_KEPT,
  collectVintages,
  PINNED,
  reportUncovered,
} from "./pattern-vintage-lib.ts";
import {
  openFileBackedRuntime,
  readVintageManifest,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";
import {
  captureChangedGenerations,
  captureGenerations,
  captureMissing,
  captureVintage,
  type GateRoots,
  isUpgradeTarget,
  pinNewestGeneration,
  replayAll,
  snippet,
  staleTestKeys,
} from "./pattern-vintage-run.ts";

/**
 * The gate, end to end, against a throwaway pattern.
 *
 * This is the check that was being run BY HAND on every change — capture a
 * vintage, break the pattern on purpose, confirm the gate goes red. A gate
 * nobody has proved can fail is not a gate, and a manual proof is one that
 * stops happening.
 */

const signer = await Identity.fromPassphrase("pattern vintage gate test");
const KEY = "vintage-gate-subject.tsx";

/** Keep the fixture representative of the CFC-labeled system roots it gates. */
const PRELUDE = [
  "import { Confidential, Default, Stream, Writable, handler, pattern } from 'commonfabric';",
  "const ATOM = {",
  "  type: 'https://commonfabric.org/cfc/atom/Resource',",
  "  class: 'VintageGateSubject',",
  "  subject: 'did:example:vintage-gate',",
  "} as const;",
  "type Label = readonly [typeof ATOM];",
  // A STREAM in the output, because every real pattern has several and a root
  // holding one is not plain data: the read yields a live cell whose own
  // properties reach the whole runtime. A subject made only of data cells
  // cannot exercise that, and a comparison that mishandles it would look
  // perfectly green here while reporting six false findings on `home.tsx`.
  "const touch = handler<Record<string, never>, { items: Writable<string[]> }>(",
  "  (_event, { items }) => { items.push('touched'); },",
  ");",
];

const HEALTHY = [
  ...PRELUDE,
  "export interface Output {",
  "  owner: Confidential<Writable<string>, Label>;",
  "  items: Writable<string[]>;",
  "  touch: Stream<Record<string, never>>;",
  "}",
  "export default pattern<Record<string, never>, Output>(() => {",
  "  const owner = new Writable<string>('v').for('owner');",
  "  const items = new Writable<string[]>([]).for('items');",
  "  return { owner, items, touch: touch({ items }) };",
  "});",
  "",
].join("\n");

/** A new required input that the captured vintage cannot provide. */
const BREAKING = HEALTHY.replace(
  "export default pattern<Record<string, never>, Output>",
  [
    "interface Input { addedLater: string; }",
    "export default pattern<Input, Output>",
  ].join("\n"),
);

/** The same input evolution made satisfiable by a default. */
const COMPATIBLE = BREAKING.replace(
  "interface Input { addedLater: string; }",
  "interface Input { addedLater: Default<string, 'ready'>; }",
);

/** Same contract, different backing cell — the class the gate cannot see. */
const MOVED_KEY = HEALTHY.replace(".for('items')", ".for('itemList')");

/**
 * A subject whose module contributes MORE than one instantiable pattern: its
 * default export, a named `Row`, and the transformer hoist (`__cfPattern_N`)
 * that `map` lowers its callback into. All three get stored roots, so a replay
 * has to apply the artifact each root actually names.
 *
 * `rows` is read by the companion test on purpose — an unread `map` never runs,
 * so the nested patterns would never instantiate and the fixture would record
 * only the default export.
 */
const NESTED_KEY = "vintage-gate-nested.tsx";

const NESTED_TEST_KEY = NESTED_KEY.replace(/\.tsx$/, ".test.tsx");

const nestedSource = (extra: { field?: string; line?: string } = {}) =>
  [
    "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateNested',",
    "  subject: 'did:example:vintage-gate-nested',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    "interface RowOut { shout: string }",
    "export const Row = pattern<{ word: string }, RowOut>(({ word }) => {",
    "  return { shout: word };",
    "});",
    "export interface Output {",
    "  owner: Confidential<Writable<string>, Label>;",
    "  items: Writable<string[]>;",
    "  rows: RowOut[];",
    ...(extra.field ? [extra.field] : []),
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const items = new Writable<string[]>([]).for('items');",
    "  const rows = items.map((word) => Row({ word }));",
    ...(extra.line ? [extra.line] : []),
    `  return { owner, items, rows${extra.line ? ", later" : ""} };`,
    "});",
    "",
  ].join("\n");

const NESTED = nestedSource();

/**
 * Same contract plus a defaulted field — compatible, but a DIFFERENT module
 * identity, which is what makes the replay actually materialize instead of
 * short-circuiting on an unchanged identity.
 */
const NESTED_CHANGED = nestedSource({
  field: "  later: Writable<string[] | Default<[]>>;",
  line: "  const later = new Writable<string[]>([]).for('later');",
});

/** The named sub-pattern is gone: a stored root names an artifact that is not there. */
const NESTED_ROW_RENAMED = NESTED_CHANGED
  .replace("export const Row =", "export const Renamed =")
  .replace("Row({ word })", "Renamed({ word })");

/**
 * The same artifact under TWO export names, and the same module with those two
 * statements swapped. Only enumeration order differs, so the CANONICAL symbol
 * flips while the artifact, the schemas and the state are all identical.
 */
const aliased = (aliasFirst: boolean) =>
  nestedSource({
    field: "  later: Writable<string[] | Default<[]>>;",
    line: "  const later = new Writable<string[]>([]).for('later');",
  })
    .replace("export const Row =", "const Row =")
    .replace(
      "});\nexport interface Output {",
      `});\n${
        aliasFirst
          ? "export { Row as RowAlias };\nexport { Row };"
          : "export { Row };\nexport { Row as RowAlias };"
      }\nexport interface Output {`,
    );

const NESTED_ALIASED = aliased(false);
const NESTED_ALIASED_FLIPPED = aliased(true);

/**
 * The map is gone and `rows` is re-derived from a plain read: today's module
 * emits no `__cfPattern_N` at all, while every value a root held stays
 * byte-equal. The recorded hoist root names an artifact that no longer
 * exists — the renumbering face of supersession, isolated from state change.
 */
const NESTED_MAP_UNROLLED = nestedSource()
  .replace(
    "import { Confidential, Default, Writable, pattern } from 'commonfabric';",
    "import { Confidential, Default, Writable, computed, pattern } from 'commonfabric';",
  )
  .replace(
    "  const rows = items.map((word) => Row({ word }));",
    "  const rows = computed(() =>\n" +
      "    items.get().map((word) => ({ shout: word }))\n" +
      "  );",
  );

/**
 * The map body now closes over `marker`, an outer binding, and maps a FRESH
 * collection carrying the same values. The fresh cause is what makes the
 * drift observable: a re-run over the ORIGINAL collection re-supplies the
 * recorded cells' arguments before their own targets validate, so only a
 * derivation that no longer writes those cells leaves the captured
 * arguments to face today's params schema — which now demands `marker`.
 * `Row` itself widens compatibly (`prefix` optional and unused), and every
 * stored value stays byte-equal.
 */
const NESTED_CAPTURE_GROWN = nestedSource()
  .replace(
    "export const Row = pattern<{ word: string }, RowOut>(({ word }) => {",
    "export const Row = pattern<{ word: string; prefix?: string }, RowOut>(({ word }) => {",
  )
  .replace(
    "  const rows = items.map((word) => Row({ word }));",
    "  const marker = new Writable<string>('m').for('marker');\n" +
      "  const items2 = new Writable<string[]>(['captured']).for('items2');\n" +
      "  const rows = items2.map((word) => Row({ word, prefix: marker }));",
  );

/**
 * `Row` — an AUTHORED export — now requires an argument its stored roots
 * never held, under the same derivation drift as `NESTED_CAPTURE_GROWN`:
 * the map iterates a fresh same-valued collection AND captures `marker`, so
 * neither the re-run map nor a re-applied hoist re-supplies the recorded
 * Row cell (a hoist that applied would re-run its body and heal the Row's
 * arguments). One replay then carries both sides of the partition: the
 * hoist's refusal is held back as derivation, and `Row`'s must FAIL — the
 * spelling test is what separates a derived hoist from an authored pattern,
 * and holding an authored refusal back would hide a real hazard.
 */
const NESTED_ROW_ARGS_TIGHTENED = nestedSource()
  .replace(
    "export const Row = pattern<{ word: string }, RowOut>(({ word }) => {",
    "export const Row = pattern<{ word: string; word2: string; prefix?: string }, RowOut>(({ word }) => {",
  )
  .replace(
    "  const rows = items.map((word) => Row({ word }));",
    "  const marker = new Writable<string>('m').for('marker');\n" +
      "  const items2 = new Writable<string[]>(['captured']).for('items2');\n" +
      "  const rows = items2.map((word) => Row({ word, word2: word, prefix: marker }));",
  );

/**
 * A subject that returns a key its declared output type never NAMES, riding an
 * index signature instead — the shape `system/default-app.tsx` declares
 * (`[key: string]: unknown`), and the reason its root's `summaryIndex` is
 * stored under `additionalProperties: {"type": "unknown"}`.
 *
 * A schema-driven read resolves nothing at an `unknown` position, so such a key
 * came back `undefined` however much state it held — indistinguishable from a
 * key the document does not hold, which the comparison treats as nothing to
 * lose. The committed `default-app.tsx` fixture exercises this shape through
 * `summaryIndex`.
 *
 * `notes` is written through a HANDLER rather than seeded, for the reason the
 * cross-space child is: today's source seeds the fresh cell under the new name
 * with the same literal, so a subject holding only what its source seeds cannot
 * witness a moved storage key.
 */
const UNDECLARED_KEY = "vintage-gate-undeclared.tsx";

const UNDECLARED_TEST_KEY = UNDECLARED_KEY.replace(/\.tsx$/, ".test.tsx");

const undeclaredSource = (storageKey: string, trailer = "") =>
  [
    "import { Confidential, Stream, Writable, handler, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateUndeclared',",
    "  subject: 'did:example:vintage-gate-undeclared',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    "const scribble = handler<{ text: string }, { notes: Writable<string[]> }>(",
    "  ({ text }, { notes }) => { notes.push(text); },",
    ");",
    "export interface Output {",
    "  [key: string]: unknown;",
    "  owner: Confidential<Writable<string>, Label>;",
    "  items: Writable<string[]>;",
    "  scribble: Stream<{ text: string }>;",
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const items = new Writable<string[]>([]).for('items');",
    `  const notes = new Writable<string[]>([]).for('${storageKey}');`,
    "  return { owner, items, scribble: scribble({ notes }), notes };",
    "});",
    trailer,
    "",
  ].join("\n");

/**
 * The subject's own test. `items` carries the assertion because a capture
 * refuses a run with none; `scribble` is what puts a value in the UNDECLARED
 * key, which is the one the cases below are about.
 */
const undeclaredTest = [
  "import { action, assert, pattern, TESTS } from 'commonfabric';",
  `import Subject from './${UNDECLARED_KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  const write = action(() => {",
  "    subject.scribble.send({ text: 'noted' });",
  "  });",
  "  return {",
  "    [TESTS]: [{ action: add }, { assertion: added }, { action: write }],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

/**
 * A subject whose child is instantiated in ANOTHER space — the shape
 * `system/profile-create.tsx` uses, where each profile lives in its own
 * `ProfileHome.inSpace()` space.
 *
 * The child owns its own CFC-labeled root in that space, so the fixture has to
 * CARRY that space and the replay has to READ the child's root out of it. Get
 * either wrong and the read finds a fresh empty space, today's source
 * materializes onto it, and the entry counts as updated cleanly.
 *
 * `change` can remove an existing CHILD result (the incompatible control that
 * proves replay reached the captured cross-space root), or add a generated
 * required result without a default (the compatible output-evolution case).
 */
const CROSS_KEY = "vintage-gate-crossspace.tsx";

const CROSS_TEST_KEY = CROSS_KEY.replace(/\.tsx$/, ".test.tsx");

/**
 * The child's space. NAMED rather than anonymous (`inSpace()` derives a DID
 * from the creating frame's cause), so a case can state which DID it expects.
 */
const CHILD_SPACE = (await Identity.fromPassphrase("vintage gate child space"))
  .did();

const crossSource = (
  change?: "remove-existing-output" | "add-generated-output",
) =>
  [
    "import { Confidential, Stream, Writable, handler, pattern } from 'commonfabric';",
    "const ATOM = {",
    "  type: 'https://commonfabric.org/cfc/atom/Resource',",
    "  class: 'VintageGateCross',",
    "  subject: 'did:example:vintage-gate-cross',",
    "} as const;",
    "type Label = readonly [typeof ATOM];",
    // The child's own handler, so the capture can write INTO the other space
    // the way production does. A `.set()` from the parent's space does not
    // land — measured, the child still reads its seeded value afterwards — and
    // a child holding only what its source seeds cannot witness a moved
    // storage key: the fresh cell under the new name seeds the same string.
    "const scribble = handler<{ text: string }, { note: Writable<string> }>(",
    "  ({ text }, { note }) => { note.set(text); },",
    ");",
    "export interface ChildOut {",
    "  owner: Confidential<Writable<string>, Label>;",
    ...(change === "remove-existing-output"
      ? []
      : ["  note: Writable<string>;"]),
    "  scribble: Stream<{ text: string }>;",
    ...(change === "add-generated-output"
      ? ["  addedLater: Writable<string[]>;"]
      : []),
    "}",
    "export const Child = pattern<Record<string, never>, ChildOut>(() => {",
    "  const owner = new Writable<string>('v').for('owner');",
    "  const note = new Writable<string>('captured').for('note');",
    ...(change === "add-generated-output"
      ? ["  const addedLater = new Writable<string[]>([]).for('addedLater');"]
      : []),
    `  return { owner, note, scribble: scribble({ note })${
      change === "add-generated-output" ? ", addedLater" : ""
    } };`,
    "});",
    "export interface Output {",
    "  items: Writable<string[]>;",
    "  child: ChildOut;",
    "}",
    "export default pattern<Record<string, never>, Output>(() => {",
    "  const items = new Writable<string[]>([]).for('items');",
    `  const child = Child.inSpace('${CHILD_SPACE}')({});`,
    "  return { items, child };",
    "});",
    "",
  ].join("\n");

/**
 * Reads the child's `note` on purpose. The assertion is what proves the
 * cross-space child really materialized during the capture — without it a
 * fixture recording the child would be indistinguishable from one that recorded
 * a root nothing ever wrote.
 *
 * It then drives the child's OWN handler, so the fixture holds a value in the
 * other space that today's source cannot reproduce from its defaults — which is
 * what lets a case there tell a moved storage key from an intact one.
 */
const crossTest = [
  "import { action, assert, pattern, TESTS } from 'commonfabric';",
  `import Subject from './${CROSS_KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  const noted = assert(() => subject.child.note.get() === 'captured');",
  "  const scribble = action(() => {",
  "    subject.child.scribble.send({ text: 'written' });",
  "  });",
  "  const wrote = assert(() => subject.child.note.get() === 'written');",
  "  return {",
  "    [TESTS]: [",
  "      { action: add },",
  "      { assertion: added },",
  "      { assertion: noted },",
  "      { action: scribble },",
  "      { assertion: wrote },",
  "    ],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

const nestedTest = (key: string) =>
  [
    "import { action, assert, pattern, TESTS } from 'commonfabric';",
    `import Subject from './${key}';`,
    "export default pattern(() => {",
    "  const subject = Subject({});",
    "  const add = action(() => {",
    "    subject.items.set([...subject.items.get(), 'captured']);",
    "  });",
    "  const added = assert(() => subject.items.get().length === 1);",
    // Reads `rows`, which is what makes the map run and the nested patterns
    // instantiate. Without this the fixture records only the default export.
    "  const mapped = assert(() =>",
    "    subject.rows.length === 1 && subject.rows[0].shout === 'captured'",
    "  );",
    "  return {",
    "    [TESTS]: [{ action: add }, { assertion: added }, { assertion: mapped }],",
    "    subject,",
    "  };",
    "});",
    "",
  ].join("\n");

/**
 * The subject's own test, which is what CAPTURE runs.
 *
 * A capture drives the pattern through its tests rather than materializing it
 * bare, so the fixture holds state written through a real handler. This one
 * writes to `items` and asserts the write landed — the assertion matters
 * because a capture refuses a run whose tests did not pass, so a fixture can
 * never record a state the pattern does not actually reach.
 */
const SUBJECT_TEST = [
  "import { action, assert, pattern, TESTS } from 'commonfabric';",
  `import Subject from './${KEY}';`,
  "export default pattern(() => {",
  "  const subject = Subject({});",
  "  const add = action(() => {",
  "    subject.items.set([...subject.items.get(), 'captured']);",
  "  });",
  "  const added = assert(() => subject.items.get().length === 1);",
  "  return {",
  "    [TESTS]: [{ action: add }, { assertion: added }],",
  "    subject,",
  "  };",
  "});",
  "",
].join("\n");

/**
 * The current-generation companion satisfies the new source's authored type.
 * The pinned vintage still carries the old empty argument, which is what proves
 * that the candidate schema can fill the required field from its default.
 */
const COMPATIBLE_SUBJECT_TEST = SUBJECT_TEST.replace(
  "Subject({})",
  "Subject({ addedLater: 'ready' })",
);

const TEST_KEY = KEY.replace(/\.tsx$/, ".test.tsx");

/**
 * The upgrade-target filter, case by case.
 *
 * Its own tests rather than only end-to-end coverage, because the invariant it
 * carries is one prose already failed to enforce: a test pattern creates stores
 * and is NEVER an upgrade target. Applying today's test pattern at a store's top
 * measurably makes the gate WEAKER — the incompatible-input break exits 0 —
 * so this is the mechanical guard that keeps it from being merely written down.
 */
describe("isUpgradeTarget", () => {
  const entry = (
    over: Partial<Parameters<typeof isUpgradeTarget>[0]> = {},
  ) => ({
    identity: "abc123",
    symbol: "default",
    main: "/packages/patterns/system/home.tsx",
    cellId: "of:fid1:whatever",
    space: "did:key:zSpace",
    ...over,
  });

  it("accepts an authored pattern file", () => {
    expect(isUpgradeTarget(entry())).toBe(true);
  });

  it("REFUSES a test pattern — it creates stores, it is never a target", () => {
    expect(isUpgradeTarget(entry({ main: "/p/home.test.tsx" }))).toBe(false);
    expect(isUpgradeTarget(entry({ main: "/p/home.test.ts" }))).toBe(false);
  });

  it("refuses an entry with no source path", () => {
    expect(isUpgradeTarget(entry({ main: undefined }))).toBe(false);
  });

  it("refuses a path that is not repo-root-relative", () => {
    // The evaluate loop records injected helper modules too, and they carry no
    // leading slash — `${repoRoot}cfc.ts` would be a separator-less path.
    expect(isUpgradeTarget(entry({ main: "cfc.ts" }))).toBe(false);
  });

  it("refuses a keyless session pointer", () => {
    // Not a content hash, so it can never equal a freshly compiled identity —
    // it would report as CHANGED on every run forever.
    expect(isUpgradeTarget(entry({ identity: "keyless:fid1:XWh0" }))).toBe(
      false,
    );
  });
});

describe("the vintage gate, end to end", () => {
  let dir = "";
  let roots: GateRoots;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "vintage-gate-" });
    await Deno.mkdir(`${dir}/patterns`, { recursive: true });
    roots = {
      repoRoot: dir,
      patternsRoot: `${dir}/patterns`,
      vintagesRoot: `${dir}/vintages`,
      signer,
    };
    await Deno.writeTextFile(`${dir}/patterns/${KEY}`, HEALTHY);
    await Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, SUBJECT_TEST);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  const setSource = (source: string) =>
    Deno.writeTextFile(`${dir}/patterns/${KEY}`, source);
  const setTestSource = (source: string) =>
    Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, source);

  it("captures a vintage for a required pattern that has none", async () => {
    const { captured, problems } = await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    expect(problems).toEqual([]);
    expect(captured).toHaveLength(1);
    // Named by the identity that WROTE it, and findable by enumeration.
    const found = await collectVintages(roots.vintagesRoot);
    expect(found).toHaveLength(1);
    expect(found[0].testKey).toBe(TEST_KEY);
    expect(found[0].identity.length).toBeGreaterThan(0);
    expect(Deno.statSync(captured[0]).size).toBeGreaterThan(0);
  });

  it("captures nothing when the required pattern already has a vintage", async () => {
    // `--update` must only ever ADD. A second run that recaptured would let a
    // broken pattern overwrite the very vintage that would have caught it.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const { captured } = await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T13:00:00.000Z"),
    );

    expect(captured).toEqual([]);
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });

  it("passes when today's source still reads the vintage", async () => {
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toEqual([]);
  });

  it("spools no records for a caller that did not ask for them", async () => {
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    const spooled = await recordsSpooledBy(() => replayAll(roots));

    expect(spooled).toEqual([]);
  });

  it("spools one record per fixture for a caller that asked", async () => {
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    const spooled = await recordsSpooledBy(() =>
      replayAll(roots, { recordResults: true })
    );

    expect(spooled).toHaveLength(1);
    expect(spooled[0].test.k).toBe("gate");
    expect(spooled[0].test.s).toBe("repo");
    expect(spooled[0].test.n).toBe(
      `pattern-vintage ${TEST_KEY} ${PINNED} 2026-07-29T12-00-00.000Z`,
    );
    expect(spooled[0].outcome).toBe("pass");
  });

  it("FAILS when today's pattern requires an unbound new input", async () => {
    // The Tier-1 input check is one real way an update can reject a vintage.
    // CFC migration rejection is exercised through production wiring in
    // cfc-additive-default-preserves-old-doc.test.ts; this gate also has the
    // distinct job of finding state stranded by a schema-compatible update.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(BREAKING);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    expect(failures[0].testKey).toBe(TEST_KEY);
    // Assert the SPECIFIC rejection. A generic "something failed" would also
    // pass if the fixture were missing, the source failed to compile, or the
    // runtime died — none of which is the break this gate exists to catch.
    expect(failures[0].detail).toContain(
      "updated arguments do not match the candidate schema",
    );
    expect(failures[0].detail).toContain("addedLater");
  });

  it("passes again once the new input carries a default", async () => {
    // The other half of the red/green pair: the two candidates differ by
    // exactly `Default<string, 'ready'>`, so the failure above is attributable
    // to that and not to anything else about the change.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(COMPATIBLE);

    const { failures } = await replayAll(roots);

    expect(failures).toEqual([]);
  });

  it("FAILS a fixture that did not restore, rather than reading it clean", async () => {
    // The worst available green. An empty store presents to the runtime as a
    // fresh space; today's source materializes onto a fresh space perfectly
    // well; the root then reads as something. Every check the replay makes
    // passes, the pattern counts as covered, and NOTHING was replayed.
    //
    // Measured that it is the real behavior and not a worry: with the
    // identity control removed, this case goes green while the rest of the
    // file stays green too — no other assertion here can see it.
    const dir = `${roots.vintagesRoot}/${KEY}/${PINNED}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(
      `${dir}/2026-07-29T12-00-00.000Z-neverwritten.sqlite`,
      new Uint8Array(),
    );

    const { replayed, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("did not restore");
  });

  it("CATCHES a moved storage key — the class this tier exists for", async () => {
    // The inversion this test was written to receive. `.for('items')` →
    // `.for('itemList')` leaves the declared contract byte-identical and
    // strands every document written under the old name. No contract check can
    // see it, and the materialize succeeds — so until the gate compared VALUES
    // it replayed clean, and this case asserted that limit on purpose.
    //
    // The fixture holds real stranded data because capture drives the pattern
    // through its own tests: `items` was written through a handler before the
    // key moved. That is what makes this a test of the CHECK rather than of the
    // fixture.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(MOVED_KEY);

    const { replayed, stranded, failures } = await replayAll(roots);

    expect(replayed).toBe(1);
    expect(failures).toHaveLength(1);
    // The specific finding, not merely "something failed": the update APPLIED
    // and the loss is what the gate caught. A generic assertion here would also
    // pass on a refusal, a compile error, or a fixture that never restored —
    // none of which is this class.
    expect(failures[0].detail).toContain("APPLIED CLEANLY but stranded");
    expect(failures[0].detail).toContain("items");
    // EXACTLY one key, which the failure count cannot say: every stranded key
    // on one root lands in a single failure, so a comparison that also reported
    // the subject's stream — the false finding this suite now carries a stream
    // to catch — would still leave `failures` at one.
    expect(stranded).toBe(1);
  });

  it("credits the accepted drop that forgave a loss, and passes", async () => {
    // The forgiven half of the moved-key case above, over one capture so that
    // the loss the entry forgives is the loss this test watched happen. The
    // run reports which `(pattern, path)` pair did the forgiving:
    // `pattern-vintage` fails an entry that forgave nothing anywhere, so an
    // entry crediting itself is what keeps the exemption list judgeable.

    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await setSource(MOVED_KEY);
    const entry = {
      pattern: KEY,
      paths: ["items"],
      capturedThrough: "2026-07-29T12-00-00.000Z",
      reason: "the moved key this suite writes on purpose",
      record: "docs/history/vintage-gate-subject-moved-key.md",
    };

    const unforgiven = await replayAll(roots);
    const forgiven = await replayAll(roots, { acceptedDrops: [entry] });

    expect(unforgiven.stranded).toBe(1);
    expect(unforgiven.dropsApplied.size).toBe(0);
    expect(forgiven.failures).toEqual([]);
    expect(forgiven.stranded).toBe(0);
    expect([...forgiven.dropsApplied]).toEqual([`${KEY} items`]);
  });

  it("reports a vintage whose pattern no longer exists", async () => {
    // Deleting a pattern is legitimate — retiring it — but it must be visible
    // rather than silently reducing coverage to nothing.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    await Deno.remove(`${dir}/patterns/${KEY}`);

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    // Names WHICH pattern stopped resolving, not just that something did — a
    // fixture records many instantiations, so an unattributed failure would
    // leave the reader to guess which of them retired.
    expect(failures[0].detail).toContain(`/patterns/${KEY} no longer resolves`);
  });

  it("FAILS a fixture holding a root it cannot map to a file", async () => {
    // Narrowed coverage must not read as success. The replay SKIPS an entry with
    // no source path, so a green verdict would be a claim about fewer roots than
    // the fixture holds — the shape this tier has mistaken for a pass three
    // times. Capture refuses to create one of these, so it is written directly.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-doctor-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const manifest = await readVintageManifest(vintage);
      await writeVintageManifest(vintage, [
        ...(manifest?.entries ?? []),
        {
          identity: pinned.identity,
          symbol: "__cfPattern_9",
          cellId: "of:fid1:unmappable",
          space: signer.did(),
        },
        {
          identity: pinned.identity,
          symbol: "__cfPattern_10",
          // An injected helper module's name: present, but not a repo path.
          main: "cfc.ts",
          cellId: "of:fid1:notrootrelative",
          space: signer.did(),
        },
        {
          // Repo-root-relative and a real-looking path, but NOT under
          // `packages/patterns/` and not a served route — so there is no
          // pattern key for it. Capture refuses this shape now (it asks
          // `patternKeyFromMain`, the same question replay asks), which is why
          // it has to be written directly.
          //
          // It reuses a REAL recorded root rather than a synthetic cell id, on
          // purpose: the presence control runs before key resolution, so an id
          // nothing wrote is reported as a root the fixture does not hold and
          // never reaches the branch this case is about.
          ...(manifest?.entries ?? []).find((e) => e.main !== undefined)!,
          symbol: "__cfPattern_11",
          main: "/packages/home-schemas/well-known.tsx",
        },
      ]);
      // To a fresh path, not over the file this runtime opened FROM — sqlite
      // refuses that — then swapped in once the handles are closed.
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    // The PRIMARY file only, which is enough here because this fixture is
    // single-space. Do not copy this idiom onto a multi-space one: `snapshot`
    // writes a companion directory too, and moving the primary alone would
    // silently leave the other spaces behind.
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { unmappable, failures } = await replayAll(roots);

    // Both shapes count: no source path at all, and a path that is not
    // repo-root-relative (the evaluate loop records injected helper modules
    // like `cfc.ts`, whose names carry no leading slash).
    expect(unmappable).toBe(2);
    // Three failures for two `unmappable`: the third entry IS repo-root-
    // relative, so it passes the capture-side shape check and is only refused
    // where the key is resolved. Both are reported; only the first two are
    // that counter's business.
    expect(failures).toHaveLength(3);
    // Each reason bound to ITS entry. Asserting both strings against the joined
    // text would pass just as well with the two reasons swapped, which is the
    // mistake that reports the wrong diagnosis for the right count.
    const reasonFor = (symbol: string) =>
      failures.find((f) => f.detail.includes(symbol))?.detail;
    expect(reasonFor("__cfPattern_9")).toContain("no source path");
    expect(reasonFor("__cfPattern_10")).toContain(
      '"cfc.ts" is not repo-root-relative',
    );
    expect(reasonFor("__cfPattern_11")).toContain(
      "neither a repo path nor a served pattern route",
    );
  });

  it("FAILS a fixture that records NO instantiations", async () => {
    // An empty manifest means there is nothing to apply today's source to, so
    // a green run would be a statement about zero roots. The gate has mistaken
    // that shape for a pass before, which is why it is a failure rather than a
    // note.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-empty-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      await writeVintageManifest(vintage, []);
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { failures, candidates } = await replayAll(roots);

    expect(candidates).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("records no pattern instantiations");
    // The remedy is part of the message: `--update` alone prints "already
    // pinned" and changes nothing, so a reader told only "this is broken"
    // cannot act.
    expect(failures[0].detail).toContain("Delete");
  });

  it("FAILS a fixture holding state its NAME does not claim", async () => {
    // The filename records which pattern version wrote the state. A fixture
    // whose manifest holds only other identities is not the state its name
    // claims — provenance and content disagreeing, which makes every later
    // judgment about it meaningless.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-identity-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, identity: "someoneelse" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { failures } = await replayAll(roots);

    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("does not contain");
    // Both sides named, so the reader can see WHICH disagreed rather than
    // being told only that something did.
    expect(failures[0].detail).toContain(pinned.identity);
    expect(failures[0].detail).toContain("someoneelse");
  });

  it("FAILS a fixture whose pattern no longer COMPILES", async () => {
    // Distinct from "no longer resolves": the file is still there and still
    // readable, and the compiler rejects it. Reported per entry rather than
    // thrown, so one broken pattern does not take every remaining fixture with
    // it — the whole reason the replay reports instead of raising.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    // Valid TypeScript the pattern compiler cannot accept: no default export,
    // so there is no artifact for the recorded root to name.
    await Deno.writeTextFile(
      `${roots.patternsRoot}/${KEY}`,
      "export const notAPattern = 1;\n",
    );

    const { failures } = await replayAll(roots);

    expect(failures.length).toBeGreaterThan(0);
    // The SPECIFIC diagnosis. A bare "there was a failure" would pass on a
    // missing store or a disposed runtime just as well.
    expect(failures.map((f) => f.detail).join("\n")).toMatch(
      /no longer (compiles|resolves)/,
    );
  });

  it("still MATERIALIZES a served-route target, only skipping its identity", async () => {
    // A pattern loaded BY URL records the route the toolshed serves it at, and
    // the same file compiles to a different identity served than from the repo
    // — so an identity comparison would call it changed on every run forever.
    // That is the whole of what a served route may skip. Skipping the TARGET
    // outright meant a recorded root got no materialize and no state
    // comparison at all, and the committed lunch-poll fixture holds exactly
    // this shape for `profile-create`: a breaking change to it left the run
    // green.
    //
    // Proved by BREAKING the source the route maps to. Counting served routes
    // would pass this case just as well if they were still skipped, so the
    // assertion is on the failure the comparison produces.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-served-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    let subjectCell: string | undefined;
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // The entry that actually holds the subject's state, re-pointed at the
      // ROUTE the same file would be served under. Same cell, same identity —
      // only `main` changes, so anything that still fails is the served-route
      // path and not a different fixture.
      const subject = entries.find((entry) => entry.main?.endsWith(`/${KEY}`))!;
      subjectCell = subject.cellId;
      await writeVintageManifest(vintage, [
        ...entries.filter((entry) => entry !== subject),
        { ...subject, main: `/api/patterns/${KEY}` },
      ]);
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    expect(subjectCell, "the fixture no longer records the subject")
      .toBeDefined();

    // Green first: the route resolves to today's unchanged source, and a
    // served route is materialized every run because it has no "changed"
    // answer. Without this control the red below could be a route that never
    // resolved at all.
    const clean = await replayAll(roots);
    expect(clean.failures, "an UNBROKEN served route should replay clean")
      .toEqual([]);
    expect(clean.servedRoute).toBe(1);
    // ...and it is kept out of `changed`, which would otherwise report the
    // same fixed number forever and stop meaning "something moved".
    expect(clean.changed).toBe(0);

    // Now break where the state is STORED, leaving the contract untouched —
    // the class this tier exists for, and one only a materialize can see.
    await Deno.writeTextFile(`${roots.patternsRoot}/${KEY}`, MOVED_KEY);
    const broken = await replayAll(roots);

    expect(
      broken.failures.map((f) => f.detail).join("\n"),
      "a served-route target was not materialized, so a moved storage key in " +
        "it replayed clean — the hole this case exists to close",
    ).toContain("stranded state the vintage held");
  });

  it("attributes a RECORDED pattern the run did not credit", async () => {
    // The provenance an uncovered-pattern failure prints. It has to come from
    // what a fixture RECORDS, not from what the run CREDITS: `uncovered` is
    // exactly the required keys absent from the credited set, so a map built
    // from that set can never name one of them and the "covered by" branch is
    // unreachable by construction. An earlier version made precisely that
    // mistake, and its unit test passed only by hand-building a pair the gate
    // cannot produce.
    //
    // Driven here through the real path, using the auto tier as the reason for
    // withholding credit — it is the one exclusion a test can arrange without
    // corrupting the fixture.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const autoDir = `${roots.vintagesRoot}/${pinnedRef.testKey}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    await Deno.copyFile(
      pinnedRef.path,
      `${autoDir}/${pinnedRef.stamp}-${pinnedRef.identity}.sqlite`,
    );
    await Deno.remove(pinnedRef.path);

    const { covered, coveredBy, targets, failures } = await replayAll(roots);

    // The control that actually controls: the fixture got PAST the presence
    // check and the target filter and produced no failure, so "not credited"
    // is a decision rather than the uninteresting case of nothing having run.
    // (`replayed` would not do — it counts fixtures COLLECTED, before any of
    // those.)
    expect(targets).toBeGreaterThan(0);
    expect(failures, "the auto fixture failed for an unrelated reason")
      .toEqual([]);
    expect([...covered], "an auto fixture credited coverage").toEqual([]);
    // ...and the pattern is still attributed to the test that records it,
    // with the tier that decides the remedy — a reader is told to PIN it, not
    // to read failures that do not exist or capture a fixture that does.
    expect(coveredBy.get(KEY)).toEqual({
      testKey: pinnedRef.testKey,
      pinned: false,
    });
  });

  it("gives EVERY fixture-level failure a remedy, and attributes it", async () => {
    // The whole point of routing a remedy into each failure: the report stops
    // promising one it does not control. Both halves are asserted together
    // because they fail together — a failure with no remedy and no attribution
    // is the dead end this branch has now chased through four review rounds
    // (gate red, printed advice exits 0 having done nothing).
    //
    // Deleting any one interpolation used to leave every test green; five of
    // the seven were unguarded, four of them added as the FIX for the previous
    // round. This drives the reachable fixture-level shapes at once.
    const shapes: { name: string; break_: () => Promise<void> }[] = [
      {
        name: "did not restore",
        break_: async () => {
          const [pinned] = await collectVintages(roots.vintagesRoot);
          await Deno.writeFile(pinned.path, new Uint8Array(0));
        },
      },
      {
        name: "identity its name does not claim",
        break_: async () => {
          const [pinned] = await collectVintages(roots.vintagesRoot);
          const tmp = await Deno.makeTempDir({ prefix: "vg-idmm-" });
          const v = await openFileBackedRuntime(signer, tmp, pinned.path);
          try {
            const entries = (await readVintageManifest(v))?.entries ?? [];
            await writeVintageManifest(
              v,
              entries.map((e) => ({ ...e, identity: "someoneelse" })),
            );
            await v.snapshot(`${tmp}/r.sqlite`);
          } finally {
            await v.dispose().catch(() => {});
          }
          await Deno.copyFile(`${tmp}/r.sqlite`, pinned.path);
          await Deno.remove(tmp, { recursive: true }).catch(() => {});
        },
      },
      {
        name: "source no longer resolves",
        break_: async () => {
          await Deno.remove(`${roots.patternsRoot}/${KEY}`);
        },
      },
      {
        name: "source no longer compiles",
        break_: async () => {
          await Deno.writeTextFile(
            `${roots.patternsRoot}/${KEY}`,
            "export const notAPattern = 1;\n",
          );
        },
      },
    ];

    for (const shape of shapes) {
      // A fresh tree per shape, so one break cannot mask another.
      await Deno.remove(roots.vintagesRoot, { recursive: true }).catch(
        () => {},
      );
      await Deno.writeTextFile(`${roots.patternsRoot}/${KEY}`, HEALTHY);
      await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await shape.break_();

      const { failures } = await replayAll(roots);

      expect(failures.length, `${shape.name}: produced no failure`)
        .toBeGreaterThan(0);
      // EVERY failure names what to do. `remedy` is the only string that does,
      // and it is recognizable by the delete-then-update instruction.
      for (const failure of failures) {
        expect(
          failure.detail,
          `${shape.name}: a failure carries no remedy, so the reader is told ` +
            `something is wrong and nothing about what to do`,
        ).toContain("deno task pattern-vintage --update");
      }
    }
  });

  it("attributes a fixture that failed OUTRIGHT, before any target ran", async () => {
    // A fixture-level failure returns before the per-target recording loop, so
    // its attribution has to come from the manifest directly. Without that the
    // pattern reads as "nothing records it, capture one" — and the capture
    // prints "Already pinned" and exits 0, which is the dead end this whole
    // change removes, reached one layer down.
    //
    // Driven through the ZERO-TARGETS failure, which the code documents as
    // reachable by design: `isUpgradeTarget` has grown four exclusions, two
    // added after fixtures already existed, and fixtures are append-only — so
    // a new exclusion silently zeroes an old fixture. Deleting the attribution
    // leaves every other test green, which is why this exists.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-notarget2-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinnedRef.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // Every entry a TEST pattern, which `isUpgradeTarget` excludes by rule —
      // so the fixture records the pattern and offers zero targets.
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({
          ...entry,
          main: entry.main === undefined
            ? entry.main
            : entry.main.replace(/\.tsx$/, ".test.tsx"),
        })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinnedRef.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { coveredBy, failures } = await replayAll(roots);

    // It failed at the FIXTURE level — no target ran at all.
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("not one is something today's source");
    // Every fixture-level failure carries its own remedy, so the report can
    // point at it rather than promising one it does not control.
    expect(failures[0].detail).toContain("Delete");
    // ...and what the manifest NAMES is still attributed, so the reader is
    // sent to the fixture instead of told to capture one that already exists.
    // The recorded key is the rewritten `.test.tsx` one, because that is what
    // this manifest now names — the point is that a fixture-level failure
    // attributes at all, not which key it happens to carry.
    expect(coveredBy.get(TEST_KEY)?.testKey).toBe(pinnedRef.testKey);
    expect(coveredBy.size, "a fixture-level failure attributed nothing")
      .toBeGreaterThan(0);
  });

  it("prefers the PINNED fixture when both tiers record a pattern", async () => {
    // The two tiers carry OPPOSITE remedies — a pinned fixture that failed
    // says "read the failures", an auto one says "pin it" — so which fixture
    // wins the attribution decides which advice a reader gets.
    //
    // Plain first-wins gets it backwards: `collectVintages` sorts by path and
    // `auto` sorts before `pinned`, so the auto fixture is walked first. A
    // pattern recorded by both would be reported AUTO-only even when the
    // pinned replay is the thing that failed, telling the reader to pin a
    // fixture that is already pinned while the real failure keeps the gate red.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    // The same bytes under a DIFFERENT test key's `auto/`, so the two tiers
    // record one pattern under two names and the tie-break has a visible
    // effect. Copying under the same test key makes `testKey` identical either
    // way, which is what the first version of this case did — it then pinned
    // only the `pinned` flag, a field nothing outside the tie-break consumes.
    const otherTestKey = `other-${TEST_KEY}`;
    const autoDir = `${roots.vintagesRoot}/${otherTestKey}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    await Deno.copyFile(
      pinnedRef.path,
      `${autoDir}/${pinnedRef.stamp}-${pinnedRef.identity}.sqlite`,
    );

    const { coveredBy, replayed } = await replayAll(roots);

    // Both were walked — otherwise "pinned won" would be true for the
    // uninteresting reason that the auto one never ran.
    expect(replayed).toBe(2);
    // The CONSUMER-visible effect: `reportUncovered` prints this name and the
    // capture command built from it, so naming the auto fixture would send a
    // reader to the wrong one.
    expect(coveredBy.get(KEY)).toEqual({
      testKey: pinnedRef.testKey,
      pinned: true,
    });
    expect(
      reportUncovered([KEY], coveredBy),
      "the report names the auto fixture, so the reader is sent to the wrong one",
    ).toContain(pinnedRef.testKey);
    expect(reportUncovered([KEY], coveredBy)).not.toContain(otherTestKey);
  });

  it("attributes a pattern whose fixture no longer holds its root", async () => {
    // The case the attribution most needs to explain, and the one an earlier
    // ordering missed: `recorded` was populated AFTER the presence-control
    // skip, so a fixture that no longer holds a recorded root reported as
    // though NO fixture recorded the pattern — sending a reader to capture one
    // that is sitting right there, which is the dead end this whole change
    // exists to close.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-lostroot-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinnedRef.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // Same pattern, a root the fixture does not hold: the presence control
      // reports it and the target is skipped before anything is applied.
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, cellId: "of:fid1:nosuchroot" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinnedRef.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { covered, coveredBy, failures } = await replayAll(roots);

    // It failed the presence control, so it is genuinely uncredited...
    expect(failures.length).toBeGreaterThan(0);
    expect([...covered]).toEqual([]);
    // ...and still attributed, from a PINNED fixture — so the remedy is "read
    // the failures", not "capture one".
    expect(coveredBy.get(KEY)).toEqual({
      testKey: pinnedRef.testKey,
      pinned: true,
    });
  });

  it("credits coverage only for a PINNED fixture", async () => {
    // An auto capture is regenerable and pruned by COUNT, so letting one
    // satisfy the coverage gate means retention can delete the gate's only
    // evidence for a pattern while the run still reads green. That guarantee
    // used to live in `coveredPatternKeys`; coverage stopped going through it
    // when it moved to what the replay actually replayed, and the condition
    // that restored it survived deletion with every suite green — which is why
    // this exists.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const covers = pinnedRef.testKey;

    // The control: as PINNED, this fixture credits the pattern it replayed.
    const asPinned = await replayAll(roots);
    expect([...asPinned.covered], "the pinned fixture covered nothing")
      .toContain(KEY);

    // The same bytes under `auto/` credit NOTHING, though they still replay.
    const autoDir = `${roots.vintagesRoot}/${covers}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    await Deno.copyFile(
      pinnedRef.path,
      `${autoDir}/${pinnedRef.stamp}-${pinnedRef.identity}.sqlite`,
    );
    await Deno.remove(pinnedRef.path);

    const asAuto = await replayAll(roots);
    // It was REPLAYED — otherwise "covers nothing" would be true for the
    // uninteresting reason that nothing ran.
    expect(asAuto.replayed, "the auto fixture was not replayed at all").toBe(1);
    expect(asAuto.targets).toBe(asPinned.targets);
    expect([...asAuto.covered], "an AUTO fixture credited coverage").toEqual(
      [],
    );
  });

  it("captures a new generation once today's source moves past every fixture", async () => {
    // The producer, end to end and through the real path. Every branch that
    // reasons about the auto tier — the coverage exclusion, the attribution
    // tie-break, the remedy the report prints — was reachable only from a
    // fixture a test hand-built until this existed, which is exactly why they
    // kept drifting: prose about a tier with no producer can only be checked
    // against intent.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    // Nothing is due while the pinned vintage still matches today's source.
    const current = await replayAll(roots);
    expect(current.failures).toEqual([]);
    expect(staleTestKeys(current.perVintage), "a current tree looked stale")
      .toEqual([]);

    // Move the world on, compatibly — a change the update APPLIES rather than
    // one it refuses, because a generation records a world that worked.
    await setSource(COMPATIBLE);
    await setTestSource(COMPATIBLE_SUBJECT_TEST);

    const moved = await replayAll(roots);
    expect(moved.failures).toEqual([]);
    expect(moved.changed, "the source change was not seen as a migration")
      .toBeGreaterThan(0);
    expect(staleTestKeys(moved.perVintage)).toEqual([TEST_KEY]);

    const { captured, problems } = await captureGenerations(
      roots,
      staleTestKeys(moved.perVintage),
      new Date("2026-07-30T12:00:00.000Z"),
    );
    expect(problems).toEqual([]);
    expect(captured).toHaveLength(1);

    // It landed in the AUTO tier, beside the pinned one rather than over it.
    const found = await collectVintages(roots.vintagesRoot);
    expect(found).toHaveLength(2);
    expect(found.map((v) => v.tier).sort()).toEqual([AUTO, PINNED]);
    expect(await exists(found.find((v) => v.tier === PINNED)!.path)).toBe(true);

    // And the cycle CLOSES: the fresh generation matches today, so the tree is
    // no longer stale and a second run captures nothing. Without this the
    // command would mint a generation on every invocation forever — the shape
    // that turns retention into a treadmill and buries the pinned vintage.
    const after = await replayAll(roots);
    expect(after.failures).toEqual([]);
    expect(
      staleTestKeys(after.perVintage),
      "the tree stayed stale after a capture",
    )
      .toEqual([]);
  });

  it("records per fixture WHETHER it failed, not just the run's total", async () => {
    // `staleTestKeys`'s abstention rule is unit-tested against hand-built
    // outcomes, which proves the rule and NOT the wiring. Measured: replacing
    // `failed: report.failures.length > 0` with `failed: false` in `replayAll`
    // left the whole suite green.
    //
    // TWO fixtures, because one cannot tell the two derivations apart. With a
    // single fixture, "this fixture failed" and "the RUN has failures" are
    // observationally identical, and the aggregate confusion — hoisting the
    // `failures.push` above this and reading the run total — passed the whole
    // file. That matters concretely: `perVintage[].failed` is the only input
    // to `staleTestKeys`, so an aggregate reading lets ONE broken fixture
    // suppress capture for every other test key in the tree.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [ref] = await collectVintages(roots.vintagesRoot);
    // A second, healthy fixture that sorts AFTER the broken one, so it is
    // walked once the run already carries a failure — the ordering under which
    // an aggregate reading is wrong.
    const secondKey = "zz/zz.test.tsx";
    const secondDir = `${roots.vintagesRoot}/${secondKey}/${PINNED}`;
    await Deno.mkdir(secondDir, { recursive: true });
    await Deno.copyFile(
      ref.path,
      `${secondDir}/${ref.stamp}-${ref.identity}.sqlite`,
    );

    const healthy = await replayAll(roots);
    expect(healthy.perVintage).toHaveLength(2);
    expect(
      healthy.perVintage.map((o) => o.failed),
      "a clean tree marked something failed",
    ).toEqual([false, false]);

    // Truncate ONLY the first so it cannot restore.
    await Deno.writeTextFile(ref.path, "");

    const broken = await replayAll(roots);
    expect(broken.failures.length).toBeGreaterThan(0);
    const byKey = new Map(
      broken.perVintage.map((o) => [o.ref.testKey, o.failed]),
    );
    expect(byKey.get(TEST_KEY), "the broken fixture was marked clean")
      .toBe(true);
    // The assertion the single-fixture version could not make: the healthy
    // one is still healthy in a run that HAS failures.
    expect(
      byKey.get(secondKey),
      "a healthy fixture inherited the run's failure",
    )
      .toBe(false);
  });

  it("REFUSES to capture a generation onto a tree with any failure", async () => {
    // A generation is a record of a world that WORKED. Capturing beside a
    // failure would mint one from a run whose verdict is red, and everyone
    // else would then replay it as evidence. This is also what removes the
    // need for a rule about capturing mid-edit: a release promotes from a
    // branch that already passed.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    // Break the pattern so the replay goes red AND the key is stale — without
    // the staleness this would pass for the uninteresting reason that there
    // was nothing to capture either way.
    await setSource(BREAKING);
    const replay = await replayAll(roots);
    expect(replay.failures.length).toBeGreaterThan(0);

    const outcome = await captureChangedGenerations(
      roots,
      replay,
      new Date("2026-07-30T12:00:00.000Z"),
    );

    expect(outcome.kind).toBe("refused-red");
    // And nothing was written: a refusal that still captured would be worse
    // than no refusal, because the message would say it had not.
    expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
  });

  it("prunes to the retention bound AFTER capturing, not before", async () => {
    // Ordering matters and is invisible in the happy path. Pruning first keeps
    // `keep` old generations and then adds one, so the tree sits permanently
    // one OVER the bound — a slow leak that no single run makes visible.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    // Fill the auto tier past the bound with copies of the real fixture, so
    // they enumerate and sort like genuine generations.
    const [pinnedRef] = await collectVintages(roots.vintagesRoot);
    const autoDir = `${roots.vintagesRoot}/${TEST_KEY}/${AUTO}`;
    await Deno.mkdir(autoDir, { recursive: true });
    for (let day = 1; day <= AUTO_GENERATIONS_KEPT + 2; day++) {
      const stamp = `2026-06-${String(day).padStart(2, "0")}T00-00-00.000Z`;
      await Deno.copyFile(
        pinnedRef.path,
        `${autoDir}/${stamp}-${pinnedRef.identity}.sqlite`,
      );
    }
    await setSource(COMPATIBLE);
    await setTestSource(COMPATIBLE_SUBJECT_TEST);

    const outcome = await captureChangedGenerations(
      roots,
      await replayAll(roots),
      new Date("2026-07-30T12:00:00.000Z"),
    );

    expect(outcome.kind).toBe("captured");
    const after = await collectVintages(roots.vintagesRoot);
    const auto = after.filter((v) => v.tier === AUTO);
    // Exactly the bound — the freshly captured one is COUNTED, which is the
    // whole point of pruning against a re-read tree.
    expect(auto).toHaveLength(AUTO_GENERATIONS_KEPT);
    // The survivor set is the NEWEST, and the one just captured is in it.
    expect(auto.map((v) => v.stamp).sort().at(-1)).toBe(
      "2026-07-30T12-00-00.000Z",
    );
    // The pinned vintage is untouched — retention can never reach it.
    expect(after.filter((v) => v.tier === PINNED)).toHaveLength(1);
  });

  it("still REPORTS what it captured when retention then fails", async () => {
    // Files are already on disk by the time pruning runs. Throwing there would
    // lose the record of which — leaving fixtures nobody was told about. Over-
    // retention is a disk cost a re-run fixes; an unreported capture is not.
    //
    // The capture must SUCCEED and the prune must FAIL, which is fiddly to
    // arrange and worth arranging. A first version wedged a file where the
    // capture's own output directory goes: that failed the `mkdir` inside
    // `captureVintage`, so it exercised the capture-failure path instead and
    // the retention branch stayed red — passing for the wrong reason, and only
    // caught by reading the coverage report.
    //
    // So the denial is put somewhere the capture never touches: ANOTHER test
    // key's auto tier, over the retention bound, with its directory made
    // unwritable. The capture writes to its own key and succeeds; retention
    // selects a victim under the read-only directory and cannot unlink it.
    const other = "zz-retention/zz.test.tsx";
    const otherAuto = `${roots.vintagesRoot}/${other}/${AUTO}`;
    await Deno.mkdir(otherAuto, { recursive: true });
    for (let day = 1; day <= AUTO_GENERATIONS_KEPT + 1; day++) {
      await Deno.writeTextFile(
        `${otherAuto}/2026-06-${
          String(day).padStart(2, "0")
        }T00-00-00.000Z-bafyzz.sqlite`,
        "over the bound",
      );
    }
    // A THIRD key, also over the bound, but writable — and sorting before the
    // denied one, so its deletion succeeds first and the failure lands
    // mid-loop. Without it the doomed set is a single file that fails
    // immediately, `pruned: []` is trivially right, and the partial case —
    // deletions done but unreported — goes untested.
    const early = "aa-retention/aa.test.tsx";
    const earlyAuto = `${roots.vintagesRoot}/${early}/${AUTO}`;
    await Deno.mkdir(earlyAuto, { recursive: true });
    for (let day = 1; day <= AUTO_GENERATIONS_KEPT + 1; day++) {
      await Deno.writeTextFile(
        `${earlyAuto}/2026-06-${
          String(day).padStart(2, "0")
        }T00-00-00.000Z-bafyaa.sqlite`,
        "over the bound",
      );
    }
    await Deno.chmod(otherAuto, 0o500);
    try {
      // The environment has to be able to deny an unlink at all. Asserted
      // rather than assumed: as root it cannot, and this test would then pass
      // while proving nothing.
      const denied = await Deno.remove(
        `${otherAuto}/2026-06-01T00-00-00.000Z-bafyzz.sqlite`,
      )
        .then(() => false).catch(() => true);
      expect(
        denied,
        "this environment cannot deny an unlink, so the retention " +
          "failure cannot be simulated (running as root?)",
      ).toBe(true);

      // A synthetic replay, so the dummy fixtures above do not have to be
      // replayable: this function takes the run it should judge precisely so
      // the judgment can be driven directly.
      const outcome = await captureChangedGenerations(roots, {
        failures: [],
        perVintage: [{
          ref: {
            testKey: TEST_KEY,
            tier: PINNED,
            stamp: "2026-07-29T12-00-00.000Z",
            identity: "bafyold",
            path: `${roots.vintagesRoot}/${TEST_KEY}/${PINNED}/x.sqlite`,
          },
          targets: 1,
          changed: 1,
          failed: false,
        }],
      }, new Date("2026-07-30T12:00:00.000Z"));

      expect(outcome.kind).toBe("captured");
      if (outcome.kind !== "captured") throw new Error("unreachable");
      // The whole point: the capture is still reported.
      expect(outcome.captured, "the capture went unreported").toHaveLength(1);
      expect(outcome.captured[0]).toContain(`/${AUTO}/`);
      // ...and the retention failure is reported too, rather than swallowed.
      expect(outcome.problems.join("\n")).toContain("retention:");
      // The deletion that DID happen before the failure is reported. Assuming
      // all-or-nothing here loses the record of files this command removed —
      // the same loss the try/catch exists to prevent, in the other direction.
      expect(outcome.pruned, "a completed deletion went unreported")
        .toHaveLength(1);
      expect(outcome.pruned[0]).toContain(early);
      expect(await exists(outcome.pruned[0]), "a reported prune did not happen")
        .toBe(false);
      // ...and the denied one is neither deleted nor claimed.
      expect(outcome.pruned.some((p) => p.includes(other))).toBe(false);
    } finally {
      await Deno.chmod(otherAuto, 0o700);
    }
  });

  it("promotes the newest generation, and says so when there is none", async () => {
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );

    // Nothing in the auto tier yet.
    expect((await pinNewestGeneration(roots, [TEST_KEY])).kind)
      .toBe("nothing-to-pin");
    // A command that named no key, or several, is its own answer — promotion
    // is deliberate per fixture and is not undone by pinning less next time.
    expect((await pinNewestGeneration(roots, [])).kind).toBe("needs-one-key");
    expect((await pinNewestGeneration(roots, ["a", "b"])).kind)
      .toBe("needs-one-key");

    await setSource(COMPATIBLE);
    await setTestSource(COMPATIBLE_SUBJECT_TEST);
    await captureChangedGenerations(
      roots,
      await replayAll(roots),
      new Date("2026-07-30T12:00:00.000Z"),
    );

    const pinned = await pinNewestGeneration(roots, [TEST_KEY]);

    expect(pinned.kind).toBe("promoted");
    if (pinned.kind !== "promoted") throw new Error("unreachable");
    expect(pinned.from).toContain(`/${AUTO}/`);
    expect(pinned.to).toContain(`/${PINNED}/`);
    // The tier moved and NOTHING else did: same file name, so the capture
    // stamp still says which generation of the world this holds.
    expect(pinned.to.split("/").at(-1)).toBe(pinned.from.split("/").at(-1));
    const after = await collectVintages(roots.vintagesRoot);
    expect(after.filter((v) => v.tier === AUTO)).toEqual([]);
    expect(after.filter((v) => v.tier === PINNED)).toHaveLength(2);
    // And it now CREDITS coverage, which is the entire point of promoting.
    expect([...(await replayAll(roots)).covered]).toContain(KEY);
  });

  it("FAILS a fixture with candidates but no upgrade TARGET, on its own", async () => {
    // Per fixture, not just in the run's total. `isClean` floors the SUM of
    // targets, which a fixture covering nothing slips under the moment another
    // fixture covers five — and this one would have applied today's source to
    // nothing while the run read green. Measured: with the per-fixture check
    // removed, a two-fixture run where the second records only test patterns
    // reports `targets: 1, failures: []` and passes.
    //
    // Reachable rather than theoretical: `isUpgradeTarget` has grown four
    // exclusions, two added after fixtures already existed, and fixtures are
    // append-only. A new exclusion silently zeroes an old fixture's coverage.
    await captureMissing(
      roots,
      [TEST_KEY],
      new Date("2026-07-29T12:00:00.000Z"),
    );
    const [pinned] = await collectVintages(roots.vintagesRoot);
    const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-notarget-" });
    const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
    try {
      const entries = (await readVintageManifest(vintage))?.entries ?? [];
      // Same roots, re-recorded as test patterns — the shape a later exclusion
      // would produce over a fixture nobody can recapture.
      await writeVintageManifest(
        vintage,
        entries.map((entry) => ({ ...entry, main: "/patterns/x.test.tsx" })),
      );
      await vintage.snapshot(`${tmp}/rewritten.sqlite`);
    } finally {
      await vintage.dispose().catch(() => {});
    }
    await Deno.copyFile(`${tmp}/rewritten.sqlite`, pinned.path);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});

    const { targets, failures } = await replayAll(roots);

    expect(targets).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain(
      "not one is something today's source can be applied to",
    );
    // The reason is counted, not asserted: these entries are test patterns, so
    // the message must not blame the other exclusion.
    expect(failures[0].detail).toContain("0 cannot be mapped to a file");
    // And the remedy has to be one that WORKS. `--update` alone would print
    // "already pinned" and change nothing, so the fixture must be named for
    // deletion first — companion directory included.
    expect(failures[0].detail).toContain("deliberately, then");
    expect(failures[0].detail).toContain(".sqlite.spaces/");
  });

  describe("capture refuses a state the pattern never legitimately reaches", () => {
    const setSubjectTest = (body: string) =>
      Deno.writeTextFile(`${dir}/patterns/${TEST_KEY}`, body);

    it("refuses when the pattern's own tests do not pass", async () => {
      // A fixture is only worth pinning if the state in it is state the pattern
      // actually reaches. Capturing off a failing run would pin a lie, and every
      // later generation would be replayed against it.
      await setSubjectTest(
        [
          "import { assert, pattern, TESTS } from 'commonfabric';",
          `import Subject from './${KEY}';`,
          "export default pattern(() => {",
          "  const subject = Subject({});",
          "  const never = assert(() => subject.items.get().length === 99);",
          "  return { [TESTS]: [{ assertion: never }], subject };",
          "});",
          "",
        ].join("\n"),
      );

      const { captured, problems } = await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );

      expect(captured).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("its own tests did not pass");
      // Nothing was written: a refused capture must not leave a partial fixture
      // behind for a later run to mistake for a good one.
      expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
    });

    it("refuses a multi-user test, saying the run did not complete", async () => {
      // A multi-user test's participants instantiate and write in workers of
      // their own, against a storage server the runner starts, so this
      // capture's store and observer would see nothing. The runner refuses the
      // store rather than handing one back unwritten, and a refusal is a run
      // that did not complete rather than a pattern whose tests failed.

      await setSubjectTest(
        [
          "import { assert, multiUserTest, pattern, TESTS } from 'commonfabric';",
          `import Subject from './${KEY}';`,
          "export const setup = pattern(() => ({ subject: Subject({}) }));",
          "export const alice = pattern(() => ({",
          "  [TESTS]: [{ assertion: assert(() => true) }],",
          "}));",
          "export default multiUserTest({ setup, participants: { alice } });",
          "",
        ].join("\n"),
      );

      const { captured, problems } = await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );

      expect(captured).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("the run did not complete");
      expect(problems[0]).toContain("is a multi-user test");
      expect(problems[0]).not.toContain("its own tests did not pass");
      expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
    });

    it("refuses a test that asserts nothing", async () => {
      // A run with no assertions cannot have driven the pattern anywhere, so the
      // fixture would hold a bare materialized root — which is the shape that
      // makes a green replay meaningless.
      await setSubjectTest(
        [
          "import { pattern, TESTS } from 'commonfabric';",
          `import Subject from './${KEY}';`,
          "export default pattern(() => {",
          "  const subject = Subject({});",
          "  return { [TESTS]: [], subject };",
          "});",
          "",
        ].join("\n"),
      );

      const { captured, problems } = await captureMissing(
        roots,
        [TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );

      expect(captured).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("ran no assertions");
    });
  });

  describe("a module contributing several instantiable patterns", () => {
    const writeNested = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${NESTED_KEY}`, source);

    beforeEach(async () => {
      await writeNested(NESTED);
      await Deno.writeTextFile(
        `${dir}/patterns/${NESTED_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        nestedTest(NESTED_KEY),
      );
    });

    it("records the nested roots under their own symbols", async () => {
      const { problems, captured } = await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      expect(problems).toEqual([]);
      expect(captured).toHaveLength(1);
    });

    it("applies each root's OWN artifact, not the module's entry export", async () => {
      // The default export, `Row`, and the `map` hoist all have stored roots in
      // this fixture. A replay that ignored the recorded symbol would apply the
      // ROOT pattern to the nested cells — a different artifact than the one
      // stored there, which either refuses a valid migration or accepts an
      // invalid one having checked the wrong thing. The edit is
      // schema-compatible, so a symbol-correct replay has nothing to report.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_CHANGED);

      const { changed, failures } = await replayAll(roots);

      // The identity really moved, so the materialize path actually ran — this
      // test would be vacuous if the replay had short-circuited.
      expect(changed).toBeGreaterThan(1);
      expect(failures).toEqual([]);
    });

    it("a cosmetic export reorder is not a failed migration", async () => {
      // One artifact exported under TWO names has a single CANONICAL symbol,
      // and `setArtifactEntryRef` is first-write-wins — so which name is
      // canonical depends on export enumeration order. The completion marker the
      // runner stamps carries the canonical symbol, not the one the fixture
      // recorded, so comparing against the recorded name reported a clean swap
      // as "setup did not complete … the root carries …#RowAlias". Reordering
      // two export statements must not read as a broken migration.
      await writeNested(NESTED_ALIASED);
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ALIASED_FLIPPED);

      const { changed, failures } = await replayAll(roots);

      // More than one, so a NESTED root was among them — the aliased artifact is
      // one of those. `> 0` would stay green if a future change stopped
      // materializing the nested roots and only the entry pattern was applied,
      // which is the coverage this case exists to have.
      expect(changed).toBeGreaterThan(1);
      expect(failures).toEqual([]);
    });

    it("FAILS CLOSED when a stored root names an artifact this version dropped", async () => {
      // Renaming the exported sub-pattern leaves a root naming a symbol today's
      // module does not define. Falling back to the entry export would quietly
      // validate the wrong artifact; the honest answer is a reported finding.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ROW_RENAMED);

      const { failures } = await replayAll(roots);

      expect(failures.length).toBeGreaterThan(0);
      expect(
        failures.some((f) => f.detail.includes('defines no "Row"')),
      ).toBe(true);
    });

    it("holds a derived hoist back when the edit no longer emits it", async () => {
      // The recorded `__cfPattern_N` root names an artifact today's module
      // does not define, because the edit unrolled the map — the renumbering
      // face of supersession. Held back and reported with its reason; the
      // authored roots around it replay and compare as always.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_MAP_UNROLLED);

      const { failures, capturesSuperseded } = await replayAll(roots);

      expect(failures).toEqual([]);
      expect(
        capturesSuperseded.some((target) =>
          /__cfPattern_[1-9]\d* \(hoist no longer emitted\)$/.test(target)
        ),
      ).toBe(true);
    });

    it("holds a derived hoist back when its captures outgrow the stored arguments", async () => {
      // Today's hoist exists, but the map body's new outer capture makes its
      // params schema demand a property the stored arguments never carried —
      // the same refusal the runner reports as a stored-argument rejection.
      // Captures are derivation the re-run map re-supplies, so this is held
      // back rather than failed.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_CAPTURE_GROWN);

      const { failures, capturesSuperseded } = await replayAll(roots);

      expect(failures).toEqual([]);
      expect(
        capturesSuperseded.some((target) =>
          /__cfPattern_[1-9]\d* \(stored arguments superseded\)$/.test(target)
        ),
      ).toBe(true);
    });

    it("FAILS an authored export whose stored arguments today's schema refuses", async () => {
      // The same refusal class the hoists are held back on, fired by an
      // AUTHORED pattern: `Row` now requires `word2` and the stored roots
      // never held one. Nothing here is derivation a re-run re-supplies, so
      // holding it back would hide a stranded piece. The hoist's own refusal
      // in the same replay stays held back — both sides of the partition,
      // decided by what the symbol is rather than by the refusal's shape.
      await captureMissing(
        roots,
        [NESTED_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      await writeNested(NESTED_ROW_ARGS_TIGHTENED);

      const { failures, capturesSuperseded } = await replayAll(roots);

      expect(failures.length).toBeGreaterThan(0);
      expect(
        failures.some((f) => f.detail.includes("(Row)")),
      ).toBe(true);
      expect(
        failures.some((f) => f.detail.includes("__cfPattern")),
      ).toBe(false);
      expect(
        capturesSuperseded.some((target) =>
          /__cfPattern_[1-9]\d* \(stored arguments superseded\)$/.test(target)
        ),
      ).toBe(true);
    });
  });

  describe("an authored export squatting on the hoist namespace", () => {
    const SQUATTER_KEY = "vintage-gate-squatter.tsx";
    const SQUATTER_TEST_KEY = SQUATTER_KEY.replace(/\.tsx$/, ".test.tsx");

    // The capture/rename hazard: were this captured, its manifest entry would
    // be spelled exactly like a derived hoist, and a later rename would be
    // held back as supersession instead of failing as a retirement. The
    // runner's registration seam refuses the module outright, so the
    // sequence can no longer be constructed — which is the regression this
    // pins end to end.
    const SQUATTER = [
      "import { pattern } from 'commonfabric';",
      "interface RowOut { shout: string }",
      "export const __cfPattern_1 = pattern<{ word: string }, RowOut>(",
      "  ({ word }) => ({ shout: word }),",
      ");",
      "export default pattern<Record<string, never>, { out: string }>(",
      "  () => ({ out: 'x' }),",
      ");",
      "",
    ].join("\n");

    const SQUATTER_TEST = [
      "import { assert, pattern, TESTS } from 'commonfabric';",
      `import Subject from './${SQUATTER_KEY}';`,
      "export default pattern(() => {",
      "  const subject = Subject({});",
      "  const present = assert(() => subject.out === 'x');",
      "  return { [TESTS]: [{ assertion: present }], subject };",
      "});",
      "",
    ].join("\n");

    beforeEach(async () => {
      await Deno.writeTextFile(`${dir}/patterns/${SQUATTER_KEY}`, SQUATTER);
      await Deno.writeTextFile(
        `${dir}/patterns/${SQUATTER_TEST_KEY}`,
        SQUATTER_TEST,
      );
    });

    it("REFUSES the capture, so the fixture never exists to mislead", async () => {
      const { problems, captured } = await captureMissing(
        roots,
        [SQUATTER_TEST_KEY],
        new Date("2026-07-29T12:00:00.000Z"),
      );
      expect(captured).toEqual([]);
      expect(
        problems.some((p) => p.includes("hoist namespace")),
      ).toBe(true);
    });
  });

  describe("a key the declared output type never names", () => {
    const STAMP = new Date("2026-07-29T12:00:00.000Z");

    const writeUndeclared = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${UNDECLARED_KEY}`, source);

    beforeEach(async () => {
      await writeUndeclared(undeclaredSource("notes"));
      await Deno.writeTextFile(
        `${dir}/patterns/${UNDECLARED_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        undeclaredTest,
      );
    });

    it("CATCHES a moved storage key at an `unknown` position", async () => {
      // The blind spot, closed. `notes` rides the index signature, so the root
      // stores it under `additionalProperties: {"type": "unknown"}` and a
      // schema-driven read resolves NOTHING there — the before value came back
      // `undefined`, `isPreserved` read that as "held nothing", and the moved
      // key replayed clean. The committed `system/default-app.tsx` fixture
      // exercises the same shape through its undeclared `summaryIndex` key.
      await captureMissing(roots, [UNDECLARED_TEST_KEY], STAMP);
      await writeUndeclared(undeclaredSource("notesMoved"));

      const { failures } = await replayAll(roots);

      expect(failures).toHaveLength(1);
      // The SPECIFIC finding, with both values. A generic assertion would also
      // pass on a refusal or an unreadable root, and the before value is what
      // proves the handler's write was actually captured — a subject that only
      // ever seeded `notes` would show `[]` on both sides and report nothing.
      expect(failures[0].detail).toContain("APPLIED CLEANLY but stranded");
      expect(failures[0].detail).toContain('notes (was ["noted"], now [])');
    });

    it("reports nothing when the key did not move", async () => {
      // The green half, and the false-positive guard the relaxation needs: it
      // makes the comparison SEE keys it could not before, so it also gets to
      // manufacture findings about them. The two sources differ by a trailing
      // comment — same storage, different identity, so the replay actually
      // materializes instead of short-circuiting on an unchanged identity.
      await captureMissing(roots, [UNDECLARED_TEST_KEY], STAMP);
      await writeUndeclared(undeclaredSource("notes", "// touched"));

      const { changed, failures } = await replayAll(roots);

      expect(changed).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    });
  });

  describe("a child instantiated in ANOTHER space", () => {
    // One stamp for the whole block, so a case that captures twice lands on the
    // SAME fixture path — which is how the overwrite and partial-write cases
    // reach the paths they are about.
    const STAMP = new Date("2026-07-29T12:00:00.000Z");

    const writeCross = (source: string) =>
      Deno.writeTextFile(`${dir}/patterns/${CROSS_KEY}`, source);

    const captureCross = () => captureMissing(roots, [CROSS_TEST_KEY], STAMP);

    beforeEach(async () => {
      await writeCross(crossSource());
      await Deno.writeTextFile(
        `${dir}/patterns/${CROSS_KEY.replace(/\.tsx$/, ".test.tsx")}`,
        crossTest,
      );
    });

    it("records the child under the space it was materialized in, and carries that space", async () => {
      const { problems, captured } = await captureCross();
      expect(problems).toEqual([]);
      expect(captured).toHaveLength(1);

      const [pinned] = await collectVintages(roots.vintagesRoot);
      const tmp = await Deno.makeTempDir({ prefix: "vintage-gate-cross-" });
      const vintage = await openFileBackedRuntime(signer, tmp, pinned.path);
      try {
        const entries = (await readVintageManifest(vintage))?.entries ?? [];
        // The child's root is in the child's space, not the fixture's own. This
        // is the premise every case below rests on: if the capture stopped
        // producing a cross-space entry, they would all pass vacuously.
        const child = entries.find((e) => e.symbol === "Child");
        expect(child?.space).toBe(CHILD_SPACE);
        expect(child?.space).not.toBe(vintage.space);
        // ...and the fixture RESTORED it. A recorded space that did not travel
        // with the state is a root the replay cannot reach.
        expect([...vintage.restoredSpaces].sort()).toEqual(
          [CHILD_SPACE, signer.did()].sort(),
        );
      } finally {
        await vintage.dispose().catch(() => {});
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      }
      // On disk that is a companion store beside the primary file, named for
      // the space it holds.
      const companions: string[] = [];
      for await (
        const entry of Deno.readDir(vintageCompanionDir(pinned.path))
      ) {
        companions.push(entry.name);
      }
      expect(companions).toEqual([`${encodeURIComponent(CHILD_SPACE)}.sqlite`]);
    });

    it("reads the child's CAPTURED root, not an empty cell in the wrong space", async () => {
      // The case this whole block exists for. An entity id is content-derived
      // and carries no space, so reading the child's id under the FIXTURE's DID
      // is a lookup that succeeds at finding nothing: the cell is absent,
      // today's source materializes onto it, the root then holds today's
      // defaults, and the entry is counted as updated cleanly. Measured — with
      // the replay reading `vintage.space` this exact break replays with zero
      // failures.
      await captureCross();
      await writeCross(crossSource("remove-existing-output"));

      const { failures } = await replayAll(roots);

      const childFailure = failures.find((f) => f.detail.includes("(Child)"));
      expect(childFailure?.detail).toContain("APPLIED CLEANLY but stranded");
      // The proof that the CAPTURED root was reached, and not some empty cell:
      // the detail contains the value written by the capture's handler. A cell
      // in a space the fixture never wrote would have no prior note to strand.
      expect(childFailure?.detail).toContain(
        'note (was "written", now undefined)',
      );
    });

    it("only WARNS on a moved storage key whose new slot is SEEDED", async () => {
      // A PINNED LIMIT, not a passing check. Read it before trusting a green
      // run over a pattern whose fields carry initial values.
      //
      // The gate fails on a stranded key only when the value went from
      // something to NOTHING — see `StateFinding`, and the measurements that
      // bought that grading: a replay recomputes as well as reads, so a derived
      // value the vintage never pulled on resolves to something better this
      // time and failing on it would red every real edit.
      //
      // A moved `.for()` key does not always read back as nothing. Here the
      // child seeds its cell (`new Writable<string>('captured')`), so the fresh
      // cell under the NEW name reads `"captured"` — non-empty, and therefore
      // graded as changed rather than lost. `"written"`, which a handler wrote
      // and the vintage held, is unreachable and the run is GREEN.
      //
      // The companion case is the one that still fails: an undeclared `notes`
      // moved to `notesMoved` reads back `[]`, and
      // "reports a key that rides an INDEX SIGNATURE" pins it. So the class is
      // caught when the new slot stays empty and warned when the pattern fills
      // it — which is the blind spot to close if this grading is ever revisited
      // (weighting by `of:` versus `computed:` backing is the candidate).
      //
      // What this shape still uniquely exercises, and must keep exercising:
      //
      // - the before-state is read in the CHILD's space. Read under the
      //   fixture's own DID it comes back absent, and an absent before-state is
      //   reported as unreadable rather than as loss — a different failure, for
      //   a different reason, which would pass for this one.
      // - the child's prior state is snapshotted before the PARENT is
      //   materialized. The parent's setup re-instantiates the child, so a
      //   before-read taken when the child's own turn came would be reading a
      //   root today's source had already rewritten, and the comparison would
      //   be against itself.
      await captureCross();
      await writeCross(crossSource().replace(".for('note')", ".for('moved')"));

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      let stranded: number;
      let failures: { detail: string }[];
      try {
        ({ stranded, failures } = await replayAll(roots));
      } finally {
        console.warn = originalWarn;
      }

      // Asserted rather than merely absent: the gate must still NOTICE, and a
      // change that stopped reading either root would produce no warning at
      // all — indistinguishable here from the limit being pinned.
      const childWarning = warnings.find((line) => line.includes("(Child)"));
      expect(
        childWarning,
        "the child's moved key produced no warning, so the comparison did not " +
          "read the child's root at all — the limit below would then be pinning " +
          "nothing",
      ).toBeDefined();
      expect(childWarning).toContain('note (was "written", now "captured")');
      // TWO roots examined for one move, pinned rather than loosened to "at
      // least one": the child's own root reports `note`, and the parent — whose
      // result projects the child's — reports `child`.
      const parentWarning = warnings.find((line) => line.includes("(default)"));
      expect(parentWarning).toContain("changed state the vintage held: child");

      // ...and the limit itself: nothing FAILED.
      expect(failures.filter((f) => f.detail.includes("stranded"))).toEqual([]);
      expect(stranded).toBe(0);
    });

    it("allows a generated required output on the cross-space child", async () => {
      // The compatible direction proves the cross-space root is genuinely
      // migrated rather than merely reported on. `addedLater` is required and
      // has no schema default, but the candidate Child generates it.
      await captureCross();
      await writeCross(crossSource("add-generated-output"));

      const { targets, changed, updated, failures } = await replayAll(roots);

      expect(failures).toEqual([]);
      // Both the parent and the child changed and both applied — `> 1` is what
      // keeps this from staying green if a future change stopped materializing
      // the cross-space root and only the entry pattern was applied.
      expect(targets).toBeGreaterThan(1);
      expect(changed).toBeGreaterThan(1);
      expect(updated).toBe(changed);
    });

    it("leaves NOTHING behind when a companion store cannot be written", async () => {
      // A fixture is written in pieces: the primary file, then one companion per
      // other space. A failure part way through is worse than no fixture at all
      // — `--update` only ever ADDS, so it would skip the key as already covered
      // and the partial would sit there being replayed forever.
      //
      // Forced through the layout rather than by stubbing: a stale companion
      // store at the destination makes `VACUUM INTO` refuse (its output file
      // must not exist), which is also the real hazard of a half-deleted
      // fixture.
      const first = await captureVintage(roots, CROSS_TEST_KEY, STAMP);
      await Deno.remove(first);

      await expect(captureVintage(roots, CROSS_TEST_KEY, STAMP)).rejects
        .toThrow();

      expect(await collectVintages(roots.vintagesRoot)).toEqual([]);
      // The companion directory goes too. Leaving it would strand the next
      // capture on the same failure, with nothing on disk to explain why.
      await expect(Deno.stat(vintageCompanionDir(first))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    });

    it("refuses to write over an existing vintage, rather than replacing it", async () => {
      // `--update` can only ADD: a command that could replace a fixture could
      // replace the very fixture that would have caught a break. The cleanup
      // above is why this is enforced HERE and not only in `captureMissing` —
      // a capture that wrote over someone else's state and then failed would
      // delete it on the way out.
      //
      // The guard covers BOTH tiers. An auto capture's whole job is to add a
      // generation beside the existing ones, and it is still never allowed to
      // land on top of one: the name carries a millisecond stamp and the
      // identity, so a collision is a second capture of a generation already
      // on disk rather than a new one.
      const first = await captureVintage(roots, CROSS_TEST_KEY, STAMP);
      const before = await Deno.stat(first);

      await expect(captureVintage(roots, CROSS_TEST_KEY, STAMP)).rejects
        .toThrow(
          "never overwrites a vintage",
        );

      expect((await Deno.stat(first)).mtime).toEqual(before.mtime);
      expect(await collectVintages(roots.vintagesRoot)).toHaveLength(1);
    });

    it("FAILS a fixture whose recorded root is not IN the space it carries", async () => {
      // Carrying the space is not the same claim as holding the root. A space
      // store that opened but never committed is a valid EMPTY database, so it
      // restores, `restoredSpaces` lists it, and every space-level check passes
      // — while the recorded cell is absent, the candidate materializes onto
      // nothing, and the entry counts as updated cleanly. Measured: without the
      // per-root control this replays the removed-output break above with zero
      // failures.
      await captureCross();
      const [pinned] = await collectVintages(roots.vintagesRoot);
      const companion = `${vintageCompanionDir(pinned.path)}/${
        encodeURIComponent(CHILD_SPACE)
      }.sqlite`;
      await Deno.writeFile(companion, new Uint8Array());
      await writeCross(crossSource("remove-existing-output"));

      const { failures } = await replayAll(roots);

      const childFailure = failures.find((f) => f.detail.includes("#Child"));
      // Names the EVIDENCE the control looked for — both markers, since the
      // predicate accepts either — so a doc that is present but unstamped, the
      // one shape a false red could take, reads differently from a doc that is
      // not there at all.
      expect(childFailure?.detail).toContain(
        "neither a pattern identity nor a setup marker",
      );
      expect(childFailure?.detail).toContain("recorded but NOT validated");
      // NOT the missing-space diagnosis: the space is right there, empty. A
      // message that blamed the space would send the reader after the wrong
      // thing.
      expect(childFailure?.detail).not.toContain("does not carry");
    });

    it("FAILS a fixture that dropped a recorded space, rather than reading it clean", async () => {
      // The same worst-available-green as an unrestored fixture, one space in:
      // the primary store restores, every check about it passes, and the roots
      // in the missing space are silently not replayed. Today's source is left
      // UNCHANGED so nothing else can account for the failure — the fixture is
      // reported as under-covering on its own.
      await captureCross();
      const [pinned] = await collectVintages(roots.vintagesRoot);
      await Deno.remove(vintageCompanionDir(pinned.path), { recursive: true });

      const { replayed, failures } = await replayAll(roots);

      expect(replayed).toBe(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].detail).toContain(
        `was materialized in ${CHILD_SPACE}, which this fixture does not carry`,
      );
      expect(failures[0].detail).toContain("recorded but NOT validated");
    });
  });
});

describe("the stranded-value snippet", () => {
  it("never throws, whatever the value is", () => {
    // A report that can take the run down is a report that fails exactly when
    // it is needed. `JSON.stringify` throws on a `bigint` — a value a durable
    // doc may hold — and on anything cyclic, and both reach this on the one
    // path where a finding is being printed.
    expect(snippet(1n)).toBe('"1n"');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(typeof snippet(loop)).toBe("string");
    expect(snippet(undefined)).toBe("undefined");
  });

  it("keeps a finding short enough to read", () => {
    expect(snippet("x".repeat(500)).length).toBe(80);
  });
});

describe("deciding when the next generation is due", () => {
  const outcome = (
    testKey: string,
    changed: number,
    targets = 1,
    failed = false,
  ) => ({
    ref: {
      testKey,
      tier: AUTO,
      stamp: "2026-01-01T00-00-00.000Z",
      identity: "bafy",
      path: `vintages/${testKey}/${AUTO}/x.sqlite`,
    },
    targets,
    changed,
    failed,
  });

  it("says nothing is due while ONE generation still matches today", () => {
    // The whole point of the rule. A tree holding a current generation and
    // three older ones has a positive `changed` in aggregate, which says
    // nothing — only the per-fixture answer decides.
    expect(staleTestKeys([
      outcome("a/a.test.tsx", 3),
      outcome("a/a.test.tsx", 1),
      outcome("a/a.test.tsx", 0),
    ])).toEqual([]);
  });

  it("says a generation is due once every fixture has moved on", () => {
    expect(staleTestKeys([
      outcome("a/a.test.tsx", 3),
      outcome("a/a.test.tsx", 1),
    ])).toEqual(["a/a.test.tsx"]);
  });

  it("does not let a fixture with no targets vouch for currency", () => {
    // It proved nothing, so it cannot be the evidence that the world has not
    // moved. Counting it would suppress the capture that a key with one dead
    // fixture most needs.
    expect(staleTestKeys([outcome("a/a.test.tsx", 0, 0)]))
      .toEqual(["a/a.test.tsx"]);
  });

  it("does not let a FAILED fixture decide either way", () => {
    // A failure is the gate's own red, not a statement about which generation
    // the world is on. Reading it as current would suppress a capture; reading
    // it as stale would capture beside a break. It abstains.
    expect(staleTestKeys([outcome("a/a.test.tsx", 0, 1, true)]))
      .toEqual(["a/a.test.tsx"]);
    // ...and a healthy sibling still settles it.
    expect(staleTestKeys([
      outcome("a/a.test.tsx", 0, 1, true),
      outcome("a/a.test.tsx", 0),
    ])).toEqual([]);
  });

  it("returns per test key", () => {
    expect(staleTestKeys([
      outcome("a/a.test.tsx", 0),
      outcome("b/b.test.tsx", 2),
    ])).toEqual(["b/b.test.tsx"]);
  });

  it("returns nothing for an empty tree, rather than capturing blind", () => {
    // No fixtures is a COVERAGE problem, reported by `reportUncovered` with
    // the test key it cannot derive. Treating it as staleness would have this
    // command inventing captures for keys nobody named.
    expect(staleTestKeys([])).toEqual([]);
  });
});
