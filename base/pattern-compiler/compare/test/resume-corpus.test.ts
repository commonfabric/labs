import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";

import type { Artifact } from "../../exec/executor.ts";
import { artifactsOf, type CorpusModule, corpusModules } from "../corpus.ts";
import { runOne } from "../runner-corpus.ts";

type Emitted = Parameters<typeof runOne>[0];

// These cases run the release build of the crate over the corpus, which
// `cargo build --release` in `base/pattern-compiler` makes. Each module is
// run with a generated scenario: a first runtime handles the first half of
// the events, and a second runtime on the same memory server resumes the
// piece from its basis, is woken, and handles the rest.
describe("a module of the corpus that a second runtime resumes from its basis", () => {
  let modules: Emitted[];
  let artifacts: (id: string) => Artifact | undefined;

  beforeAll(async () => {
    const emitted = await corpusModules();
    modules = emitted as unknown as Emitted[];
    artifacts = artifactsOf(emitted as CorpusModule[]);
  });

  const resumed = async (path: string) => {
    const module = modules.find(({ module }) => module === path);
    expect(module).toBeDefined();
    return await runOne(module!, artifacts, true);
  };

  it("is current and holds the values of the executor in memory after the later events, for a list that handlers write", async () => {
    const outcome = await resumed("/examples/simple-list/simple-list.tsx");

    expect(outcome.resume?.current).toBe(true);
    expect(outcome.events?.handled).toBe(outcome.events?.sent);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.equal).toBe(true);
  });

  it("starts the executor and has no commit refused, for a piece with state of the scope `session`, outputs in documents of their own and a stream in each row of a list stored in place", async () => {
    const outcome = await resumed("/showcase/wordsearch/play.tsx");

    // The piece declares state of the scope `session`, which has an
    // instance for each session: its basis names that document, which has
    // no number, so the resume starts the executor.
    expect(outcome.resume?.current).toBe(false);
    expect(outcome.events?.handled).toBe(outcome.events?.sent);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.equal).toBe(true);
  });

  it("holds the values of the executor in memory after the later events, for a piece whose handler makes an instance of a pattern", async () => {
    const outcome = await resumed(
      "/dev/self-reference-test/self-reference-test.tsx",
    );

    expect(outcome.resume?.current).toBe(true);
    expect(outcome.events?.handled).toBe(outcome.events?.sent);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.equal).toBe(true);
  });

  // Each of the two renders a record as text, so the text holds the order
  // in which the value code read the members of the record: the order of
  // the storage, in the runtime that wrote the record as in the one that
  // read it from the storage.
  for (
    const path of [
      "/dev/gideon-tests/test-record-key-set-56.tsx",
      "/apps/budget-tracker/expense-form.tsx",
    ]
  ) {
    it(`holds the values of the executor in memory after the later events, for ${path}, which renders the members of a record in their order`, async () => {
      const outcome = await resumed(path);

      expect(outcome.resume?.current).toBe(true);
      expect(outcome.events?.handled).toBe(outcome.events?.sent);
      expect(outcome.refusals).toEqual([]);
      expect(outcome.equal).toBe(true);
    });
  }
});
