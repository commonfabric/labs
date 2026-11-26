import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";

import { PatternCompiler } from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import type { CfcMetadata } from "../../../../runtime/runner/src/cfc/types.ts";
// The modules under test are imported whole, so that a case that names a
// function the instrument lacks fails at that case and not at loading.
import * as cli from "../both-paths.ts";
import * as gate from "../both-paths-gate.ts";
import { NAMED_SCENARIOS } from "../both-paths-named.ts";
import * as serving from "../both-paths-serving.ts";
import { linksIn, type StoredDocument } from "../both-paths-store.ts";

type BothRuns = gate.BothRuns;
type Finding = gate.Finding;
type PathRun = serving.PathRun;

// An item whose title, a state cell whose type declares the clause
// `item-title`, a handler writes.
const ITEM: serving.GateScenario = {
  name: "an item with a labeled title",
  pieces: [{
    name: "item",
    module: "base/pattern-compiler/compare/fixtures/labeled-item.tsx",
    as: "alice",
  }],
  steps: [{ stream: "name", event: { title: "first" }, as: "alice" }],
};

const ROLES = { alice: "A", bob: "B" } as const;

/** The kinds and positions of what the comparison found, as text. */
const found = (findings: readonly Finding[], kinds?: readonly string[]) =>
  findings.filter(({ kind }) => kinds === undefined || kinds.includes(kind))
    .map(({ kind, position, principal, on }) =>
      `${kind} ${position}${principal === undefined ? "" : ` ${principal}`}${
        on === undefined ? "" : ` on ${on}`
      }`
    );

/** A copy of `run` whose documents and reads an edit may change. */
const copyOf = (run: PathRun): PathRun => ({
  ...run,
  checkpoints: run.checkpoints.map((checkpoint) => {
    const documents = checkpoint.snapshot.documents.map((document) => ({
      ...document,
      ...(document.metadata === undefined
        ? {}
        : { metadata: structuredClone(document.metadata) }),
    }));
    return {
      ...checkpoint,
      reads: { A: { ...checkpoint.reads.A }, B: { ...checkpoint.reads.B } },
      snapshot: {
        ...checkpoint.snapshot,
        documents,
        get: (id: string, scopeKey: string) =>
          documents.find((document) =>
            document.id === id && document.scopeKey === scopeKey
          ),
      },
    };
  }),
});

/** The document the result's `title` links to, and the path in it. */
const titleOf = (run: PathRun, at: number) => {
  const { snapshot } = run.checkpoints[at];
  const result = snapshot.get(run.results.item, "space")!;
  const [{ link }] = linksIn(result).filter(({ path }) => path[0] === "title");
  return { document: snapshot.get(link.id, "space")!, path: link.path };
};

/** The label entries of the title, at the checkpoint `at`. */
const titleEntries = (run: PathRun, at: number) => {
  const { document, path } = titleOf(run, at);
  return (document.metadata?.labelMap.entries ?? []).filter((entry) =>
    entry.path.join("/") === path.join("/")
  );
};

/**
 * Adds to the last checkpoint of `run` a document no walk reaches, of the
 * scope `scope` (`space`, or `user` of a principal), holding `value` and
 * labeled with `confidentiality` and `integrity` at its root.
 */
const addUnreached = (
  run: PathRun,
  id: string,
  value: FabricValue,
  label: { confidentiality?: unknown[]; integrity?: unknown[] },
  scope: "space" | serving.Who = "space",
) => {
  const checkpoint = run.checkpoints.at(-1)!;
  const template = titleOf(run, run.checkpoints.length - 1).document;
  const principal = scope === "space"
    ? undefined
    : run.identities.principals[scope];
  const document: StoredDocument = {
    space: template.space,
    id,
    scopeKey: principal === undefined ? "space" : `user:${principal}`,
    scope: principal === undefined
      ? { kind: "space" }
      : { kind: "user", principal },
    value,
    metadata: {
      ...(structuredClone(template.metadata) as CfcMetadata),
      labelMap: {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: (label.confidentiality ?? []) as never,
            integrity: (label.integrity ?? []) as never,
          },
        }],
      },
    },
  };
  checkpoint.snapshot.documents.push(document);
};

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("the two-principal gate's readings", () => {
  const compiler = new PatternCompiler();
  // One run of the item on both paths, which each case copies and edits.
  let ran: BothRuns;

  beforeAll(async () => {
    const result = await gate.runScenario(ITEM, { roles: ROLES, compiler });
    ran = result.runs!;
  });

  /** A copy of the runs that `edit` changes. */
  const edited = (
    edit: (runs: { today: PathRun; compiled: PathRun }) => void,
    extra: Partial<BothRuns> = {},
  ): BothRuns => {
    const runs = { today: copyOf(ran.today), compiled: copyOf(ran.compiled) };
    edit(runs);
    return { ...ran, ...runs, ...extra };
  };

  describe("labels", () => {
    it("reports no difference for a clause both paths store with its members in another order", () => {
      const runs = edited(({ today, compiled }) => {
        for (const entry of titleEntries(today, 1)) {
          entry.label.confidentiality = [
            ...entry.label.confidentiality!,
            { type: "https://example.com/atom/Ordered", subject: "one" },
          ] as never;
        }
        for (const entry of titleEntries(compiled, 1)) {
          entry.label.confidentiality = [
            ...entry.label.confidentiality!,
            { subject: "one", type: "https://example.com/atom/Ordered" },
          ] as never;
        }
      });

      const { findings } = gate.compareRuns(runs);

      expect(
        findings.filter(({ kind, today, compiled }) =>
          kind.startsWith("label-") &&
          JSON.stringify([today, compiled]).includes("Ordered")
        ),
      ).toEqual([]);
    });

    it("reports a flow atom one path stores at a position as `flow`, with its identity masked, and not as a label", () => {
      const transformedBy = (identity: unknown) => ({
        type: CFC_ATOM_TYPE.TransformedBy,
        identity,
      });
      // The title's entries at every checkpoint.
      const entriesOf = (run: PathRun) =>
        run.checkpoints.flatMap((_, at) => titleEntries(run, at));
      const strip = (run: PathRun) => {
        for (const entry of entriesOf(run)) {
          entry.label.integrity = (entry.label.integrity ?? []).filter(
            (atom) => !gate.isFlowAtom(atom),
          );
        }
      };
      const one = edited(({ today, compiled }) => {
        strip(today);
        strip(compiled);
        for (const entry of entriesOf(compiled)) {
          entry.label.integrity = [
            ...entry.label.integrity!,
            transformedBy({ kind: "compiled" }),
          ] as never;
        }
      });
      const both = edited(({ today, compiled }) => {
        strip(today);
        strip(compiled);
        for (const [run, kind] of [[today, "verified"], [compiled, "x"]]) {
          for (const entry of entriesOf(run as PathRun)) {
            entry.label.integrity = [
              ...entry.label.integrity!,
              transformedBy({ kind }),
            ] as never;
          }
        }
      });

      const atTitle = (findings: readonly Finding[]) =>
        found(findings.filter(({ position }) => position === "item/title"));
      const compared = gate.compareRuns(one);

      expect(atTitle(compared.findings)).toEqual(["flow item/title"]);
      expect(compared.flow.compiledOnly).toBeGreaterThan(0);
      expect(atTitle(gate.compareRuns(both).findings)).toEqual([]);
    });
  });

  describe("documents no walk reaches", () => {
    it("reports a clause one of two documents of a pool lacks on the compiled path, where the other holds it", () => {
      const clause = ["pooled-clause"];
      const runs = edited(({ today, compiled }) => {
        addUnreached(today, "of:test-one", { n: 1 }, {
          confidentiality: [clause],
        });
        addUnreached(today, "of:test-two", { n: 2 }, {
          confidentiality: [clause],
        });
        addUnreached(compiled, "of:test-one-c", { n: 1 }, {
          confidentiality: [clause],
        });
        addUnreached(compiled, "of:test-two-c", { n: 2 }, {});
      });

      const { findings } = gate.compareRuns(runs);

      expect(
        findings.filter(({ kind, today }) =>
          kind === "label-missing" && String(today).includes("pooled-clause")
        ).length,
      ).toBe(1);
    });

    it("compares documents it cannot match by the number that hold each clause", () => {
      const clause = ["counted-clause"];
      const runs = edited(({ today, compiled }) => {
        // Two documents of one value: neither is matched by its value.
        for (const id of ["of:test-a", "of:test-b"]) {
          addUnreached(today, id, { same: true }, {
            confidentiality: [clause],
          });
        }
        addUnreached(compiled, "of:test-a-c", { same: true }, {
          confidentiality: [clause],
        });
        addUnreached(compiled, "of:test-b-c", { same: true }, {});
      });

      const counted = gate.compareRuns(runs).findings.filter(({ today }) =>
        String(today).includes("counted-clause")
      );

      expect(found(counted)).toEqual(["label-missing pool:space"]);
      expect(counted[0].today).toContain("in 2 documents");
      expect(counted[0].compiled).toContain("in 1 documents");
    });

    it("compares the integrity of a document matched on both paths", () => {
      const runs = edited(({ today, compiled }) => {
        addUnreached(today, "of:test-row", { row: "first" }, {});
        addUnreached(compiled, "of:test-row-c", { row: "first" }, {
          integrity: [{ kind: "added-by-the-test" }],
        });
      });

      const { findings } = gate.compareRuns(runs);

      expect(
        found(
          findings.filter(({ compiled }) =>
            String(compiled).includes("added-by-the-test")
          ),
        ),
      ).toEqual([
        expect.stringMatching(/^label-extra unreached space value /),
      ]);
    });
  });

  describe("the scope rule", () => {
    it("reports B's `User` clause in a document of the space on each path that stores it, today's path as a kind of its own", () => {
      const runs = edited(({ today, compiled }) => {
        for (const run of [today, compiled]) {
          for (const entry of titleEntries(run, 1)) {
            entry.label.confidentiality = [
              ...entry.label.confidentiality!,
              [cfcAtom.user(run.identities.principals.B)],
            ];
          }
        }
      });

      const { findings } = gate.compareRuns(runs);

      expect(
        found(findings, ["foreign-clause", "today-foreign-clause"]),
      ).toEqual([
        "today-foreign-clause item/title B on today",
        "foreign-clause item/title B on compiled",
      ]);
    });

    it("reports A's clause in an instance of B's scope as crossed, on each path", () => {
      const runs = edited(({ today, compiled }) => {
        for (const [run, id] of [[today, "of:test-u"], [compiled, "of:x"]]) {
          addUnreached(run as PathRun, id as string, { mine: "B" }, {
            confidentiality: [[
              cfcAtom.user((run as PathRun).identities.principals.A),
            ]],
          }, "B");
        }
      });

      const { findings } = gate.compareRuns(runs);

      expect(
        found(findings, ["crossed-clause", "today-crossed-clause"]).map((
          line,
        ) => line.replace(/unreached \S+ value \S+/, "unreached <value>")),
      ).toEqual([
        "today-crossed-clause unreached <value> A on today",
        "crossed-clause unreached <value> A on compiled",
      ]);
    });

    it("reports no clause at a path whose value holds text a step declared shared", () => {
      const runs = edited(({ today, compiled }) => {
        for (const run of [today, compiled]) {
          run.checkpoints.at(-1)!.shared = ["shared by a step"];
          addUnreached(run, `of:test-shared-${run.path}`, {
            note: "A wrote this, shared by a step",
          }, {
            confidentiality: [[cfcAtom.user(run.identities.principals.A)]],
          });
        }
      });

      const { findings } = gate.compareRuns(runs);

      expect(found(findings, ["foreign-clause", "today-foreign-clause"]))
        .toEqual([]);
    });

    it("finds a `User` clause a stored schema declares, at the path and below", () => {
      const schema = {
        type: "object",
        properties: {
          pinned: {
            type: "string",
            ifc: {
              confidentiality: [{
                type: CFC_ATOM_TYPE.User,
                subject: { __ctCurrentPrincipal: true },
              }],
            },
          },
          open: { type: "string" },
        },
      } as FabricValue;
      const document = {
        metadata: { schemaHash: "schema" },
      } as unknown as StoredDocument;
      const contentOf = (id: string) =>
        id === "cid:schema" ? schema : undefined;

      expect(gate.declaresUserClause(document, ["pinned"], contentOf)).toBe(
        true,
      );
      expect(
        gate.declaresUserClause(document, ["pinned", "below"], contentOf),
      ).toBe(true);
      expect(gate.declaresUserClause(document, ["open"], contentOf)).toBe(
        false,
      );
    });
  });

  describe("check (b)", () => {
    const derived = [{
      path: ["item", "size"],
      values: { alice: 23, bob: 21 },
    }];

    it("reports a value only A's inputs produce that B reads, and not one B's inputs produce", () => {
      const leaked = edited(({ compiled }) => {
        compiled.checkpoints[1].reads.B["item.size"] = { value: 23 };
      }, { derived, roles: ROLES });
      const own = edited(({ compiled }) => {
        compiled.checkpoints[1].reads.B["item.size"] = { value: 21 };
      }, { derived, roles: ROLES });

      expect(found(gate.compareRuns(leaked).findings, ["foreign-value"]))
        .toEqual(["foreign-value item.size B on compiled"]);
      expect(found(gate.compareRuns(own).findings, ["foreign-value"]))
        .toEqual([]);
    });

    it("reports a value only A's inputs produce that a document of the space holds at the position", () => {
      const runs = edited(({ compiled }) => {
        const { document, path } = titleOf(compiled, 1);
        const value = structuredClone(document.value) as Record<
          string,
          unknown
        >;
        let node = value;
        for (const step of path.slice(0, -1)) {
          node = node[step] as Record<string, unknown>;
        }
        if (path.length === 0) {
          document.value = "title of A" as never;
        } else {
          node[path.at(-1)!] = "title of A";
          document.value = value as never;
        }
      }, {
        derived: [{
          path: ["item", "title"],
          values: { alice: "title of A", bob: "title of B" },
        }],
        roles: ROLES,
      });

      expect(
        found(gate.compareRuns(runs).findings, ["foreign-value"]),
      ).toContain("foreign-value item/title B on compiled");
    });

    it("reports text of A's scope in an event's payload in a stream's sidecar as `event-payload`", () => {
      const runs = edited(({ compiled }) => {
        addUnreached(compiled, "of:stream-events:test", {
          entries: [{ payload: { name: serving.PROFILE_NAMES.A } }],
        }, {});
      });

      const { findings } = gate.compareRuns(runs);

      expect(found(findings, ["event-payload", "foreign-value"])).toEqual([
        "event-payload space <document>/entries/0/payload/name B on compiled",
      ]);
    });
  });

  describe("kinds of finding", () => {
    it("reports a commit on one path that the other refused", () => {
      const runs = edited(({ compiled }) => {
        compiled.checkpoints[1] = {
          ...compiled.checkpoints[1],
          committed: false,
          message: "Error: refused by the test",
        };
      });

      const commits = gate.compareRuns(runs).findings.filter(({ kind }) =>
        kind === "commit"
      );

      expect(found(commits)).toEqual(["commit A"]);
      expect(commits[0].compiled).toBe("Error: refused by the test");
    });

    it("reports a read one path refuses as `hidden`", () => {
      const runs = edited(({ today }) => {
        today.checkpoints[1].reads.B["item.name"] = {
          hidden: "hidden by policy (consumed)",
        };
      });

      expect(found(gate.compareRuns(runs).findings, ["hidden"])).toEqual([
        "hidden item.name B",
      ]);
    });

    it("reports a write policy the stored schema declares on one path alone", () => {
      const runs = edited(({ compiled }) => {
        const checkpoint = compiled.checkpoints[1];
        const { document } = titleOf(compiled, 1);
        document.metadata!.schemaHash = "test-policy";
        const contentOf = checkpoint.snapshot.contentOf;
        checkpoint.snapshot = {
          ...checkpoint.snapshot,
          contentOf: (id: string) =>
            id === "cid:test-policy"
              ? {
                ifc: { writeAuthorizedBy: "test-writer" },
                additionalProperties: {
                  ifc: { writeAuthorizedBy: "test-writer" },
                },
              } as FabricValue
              : contentOf(id),
        };
      });

      const policies = gate.compareRuns(runs).findings.filter(({ kind }) =>
        kind === "policy"
      );

      expect(policies.length).toBeGreaterThan(0);
      expect(JSON.stringify(policies[0].compiled)).toContain("test-writer");
    });
  });

  describe("settling", () => {
    it("reads again until a pass moves nothing, and gives that pass's reads", async () => {
      const moves = [["a document"], ["another document"], []];
      let pass = 0;

      const settled = await serving.readUntilStill(
        () => Promise.resolve(`reads of pass ${pass + 1}`),
        () => Promise.resolve(),
        () => moves[pass++],
      );

      expect(settled).toEqual({ reads: "reads of pass 3", passes: 3 });
    });

    it("ends with what kept moving where a pass moves what an earlier one moved", async () => {
      const moves = [["a"], ["b"], ["a"]];
      let pass = 0;

      const settled = await serving.readUntilStill(
        () => Promise.resolve(pass),
        () => Promise.resolve(),
        () => moves[pass++],
      );

      expect(settled).toEqual({ reads: 2, passes: 3, unsettled: ["a"] });
    });

    it("records the passes of each checkpoint of a real run", () => {
      for (const run of [ran.today, ran.compiled]) {
        for (const checkpoint of run.checkpoints) {
          expect(checkpoint.passes).toBeGreaterThanOrEqual(1);
          expect(checkpoint.unsettled).toBeUndefined();
        }
      }
    });
  });

  describe("the command", () => {
    it("exits 1 where no scenario ran, and where every scenario was skipped", () => {
      const skipped = { status: "skipped" as const, reason: "a reason" };

      expect(gate.exitStatusOf([], [])).toBe(1);
      expect(gate.exitStatusOf([skipped], [])).toBe(1);
      expect(gate.exitStatusOf([{ status: "equal" }, skipped], [])).toBe(0);
    });

    it("exits 1 for a full run that ran fewer scenarios than the ledger records", () => {
      const equal = { status: "equal" as const };

      expect(
        gate.exitStatusOf([equal, equal], [], { scenarios: 3, ran: 2 }),
      ).toBe(1);
      expect(
        gate.exitStatusOf([equal, equal, equal], [], { scenarios: 3, ran: 2 }),
      ).toBe(0);
    });

    it("takes a comma list for `--only` and counts only a run of every set as full", () => {
      expect(cli.gateArguments(["out.jsonl", "--only=a,b c"])).toEqual({
        file: "out.jsonl",
        sets: ["hand", "named", "corpus"],
        only: ["a", "b c"],
        full: false,
      });
      expect(cli.gateArguments(["out.jsonl"])).toEqual({
        file: "out.jsonl",
        sets: ["hand", "named", "corpus"],
        full: true,
      });
      expect(cli.gateArguments(["out.jsonl", "--only=a,"])).toEqual({
        refused: "`--only` lists an empty part",
      });
      expect(cli.gateArguments(["out.jsonl", "--sets=hands"])).toEqual({
        refused: "no set is named hands",
      });
    });

    it("keeps the first error of a refusal that lists warnings before it", () => {
      const message = [
        "The pattern compiler refused the program:",
        "",
        "main.tsx:252:14: warning [array-by-key:state-without-key] The body of this `map` holds a handler binding",
        "  more of the warning",
        "main.tsx:40:3: error [unsupported] A spread of a cell is not supported",
      ].join("\n");

      expect(serving.firstErrorOf(message)).toBe(
        "The pattern compiler refused the program: main.tsx:40:3: error [unsupported] A spread of a cell is not supported",
      );
    });
  });

  describe("a named scenario run on both paths", () => {
    it("reports the kinds the Z100 scenario finds today: the list A reads on the compiled path, and a flow atom", async () => {
      const scenario = NAMED_SCENARIOS.find(({ name }) =>
        name === "named/typed event payload (Z100)"
      )!;

      const result = await gate.runScenario(scenario, {
        roles: ROLES,
        compiler,
      });
      const kinds = [...new Set(result.findings.map(({ kind }) => kind))]
        .sort();

      expect(kinds).toEqual(["flow", "value"]);
      expect([
        ...new Set(
          result.findings.filter(({ kind }) => kind === "value").map((
            { position, principal },
          ) => `${position} ${principal}`),
        ),
      ]).toEqual(["notes.notes A"]);
    });
  });
});
