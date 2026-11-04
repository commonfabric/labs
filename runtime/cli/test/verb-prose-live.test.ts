/**
 * An author's documentation reaching the caller who asks for it, across the
 * three surfaces that answer: `cf piece verbs --json`, and both spellings of a
 * verb's own help page.
 *
 * Every case runs against a COMPILED, RUN pattern rather than a hand-built
 * schema, because the subject is precisely what the compile pipeline does with
 * an author's words. The prose reaches the pattern by several different routes
 * — a sibling of a `$ref`, a field inside the `$defs` target that `$ref` names,
 * a field two definitions deep — and only a real compile puts each where it
 * actually lands. A fixture asserting those positions by hand would agree with
 * any implementation, the one that loses the prose included.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
import { executePieceCallable, listPieceCallables } from "../lib/piece.ts";
import { verbListingJson } from "../commands/piece.ts";

/**
 * One pattern documented the way an author is told to document one: the verb
 * says what it does where its `Stream` is declared, and each event field says
 * what it means where it is declared.
 *
 * The shapes here are chosen because the two documents the fix reconciles make
 * DIFFERENT inlining choices, measured on this fixture:
 *
 * - `details` is a `$ref` on the declared side and inlined on the served one,
 *   so reaching `details.note` and `details.tags` means following a declared
 *   reference the served document does not have.
 * - `details.tags.items` is a `$ref` on BOTH sides, so its element prose is
 *   already in place — and the served `$ref` must survive, since a caller's
 *   tooling reads that shape.
 * - `primary` is the same `Tag` reached a second way, inlined. It proves the
 *   walk annotates a position without disturbing the shared definition, and
 *   that reaching one definition twice is handled.
 *
 * `rename` carries no prose at all. It is the control: a verb an author has
 * not documented must gain no description, so an implementation that invents
 * one (the property's name, the event type's name, an empty string) fails
 * against it rather than passing everything.
 *
 * `AddEvent.urgent` is the other control, and it is the more interesting one.
 * It is declared, documented, and ABSENT from the schema the verb dispatches
 * through, because the handler's body never reads it and that schema is the
 * handler's read rather than the declared type. So the two documents disagree
 * on shape as well as on prose, and the assertions below pin which one wins:
 * the prose is folded into what a caller is served, never served in its place.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, pattern, Stream } from "commonfabric";',
      "",
      "interface Tag {",
      "  /** The tag's visible text. */",
      "  label: string;",
      "}",
      "",
      "interface Details {",
      "  /** Free text the caller may attach. */",
      "  note: string;",
      "  /** Labels to file it under. */",
      "  tags: Tag[];",
      "}",
      "",
      "interface AddEvent {",
      "  /** One line naming the work. */",
      "  title: string;",
      "  /** Whether to file it at the top of the board. */",
      "  urgent?: boolean;",
      "  /** Anything else worth recording. */",
      "  details: Details;",
      "  /** The tag that leads. */",
      "  primary: Tag;",
      "}",
      "",
      "interface Node {",
      "  /** What this node is called. */",
      "  label: string;",
      "  /** Nodes filed under this one. */",
      "  children: Node[];",
      "}",
      "",
      "interface GraftEvent {",
      "  /** The subtree to graft. */",
      "  node: Node;",
      "}",
      "",
      "interface Cat {",
      "  /** How loud it is. */",
      "  meow: string;",
      "  kind: 'cat';",
      "}",
      "",
      "interface Dog {",
      "  /** How deep it is. */",
      "  woof: string;",
      "  kind: 'dog';",
      "}",
      "",
      "interface ClassifyEvent {",
      "  /** The animal to file. */",
      "  pet: Cat | Dog;",
      "}",
      "",
      "interface RenameEvent { title: string; }",
      "",
      "interface Out {",
      "  /** Root items only. */",
      "  items: string[];",
      "  /** File a new root item on the board. */",
      "  add: Stream<AddEvent>;",
      "  /** Attach a note to the board. */",
      "  annotate: Stream<AddEvent>;",
      "  /** Graft a subtree onto the board. */",
      "  graft: Stream<GraftEvent>;",
      "  /** File an animal by its kind. */",
      "  classify: Stream<ClassifyEvent>;",
      "  rename: Stream<RenameEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<string[]>([]);",
      "  const add = action((event: AddEvent) => {",
      "    items.push(",
      "      event.title + event.primary.label +",
      "        event.details.tags.map((tag) => tag.label).join(','),",
      "    );",
      "  });",
      "  const annotate = action((event: AddEvent) => {",
      "    items.push(event.details.note);",
      "  });",
      "  const graft = action((event: GraftEvent) => {",
      "    items.push(",
      "      event.node.label +",
      "        event.node.children.map((child) => child.label).join(','),",
      "    );",
      "  });",
      "  const classify = action((event: ClassifyEvent) => {",
      "    items.push(",
      "      event.pet.kind === 'cat' ? event.pet.meow : event.pet.woof,",
      "    );",
      "  });",
      "  const rename = action((event: RenameEvent) => {",
      "    items.set([event.title]);",
      "  });",
      "  return { items, add, annotate, graft, classify, rename };",
      "});",
    ].join("\n"),
  }],
};

const VERB_PROSE = "File a new root item on the board.";
const FIELD_PROSE = "One line naming the work.";

/** `Details.note` — one declared reference deep. */
const NESTED_PROSE = "Free text the caller may attach.";

/** `Details.tags` — the array property, one declared reference deep. */
const NESTED_ARRAY_PROSE = "Labels to file it under.";

/** `Tag.label` — reached through the inlined `primary`, two deep. */
const ELEMENT_PROSE = "The tag's visible text.";

interface LivePiece {
  piece: unknown;
  space: string;
  dispose: () => Promise<void>;
}

/**
 * Compile and run the program above, and hand back the piece surface both
 * caller-facing commands walk.
 */
async function runLivePiece(passphrase: string): Promise<LivePiece> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();
  const compiled = await runtime.patternManager.compilePattern(
    PROGRAM as never,
    { space },
  );
  const tx = runtime.edit();
  const rootCell = runtime.getCell(space, "verb-prose-live", undefined, tx);
  const root = runtime.run(tx, compiled, {}, rootCell);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await root.pull();

  // `getResultCellWithSourceSchema` is the one narrowing `PiecesController`
  // applies before any `cf` command sees a piece; skipping it would hand the
  // lister a cell no caller is ever served.
  const result = getResultCellWithSourceSchema(root);
  return {
    space,
    piece: {
      result: { getCell: () => Promise.resolve(result) },
      input: {
        getCell: () =>
          Promise.resolve(runtime.getCell(space, "verb-prose-live-input")),
      },
      getCell: () => result,
      getPattern: () => Promise.resolve(compiled),
    },
    dispose: async () => {
      await runtime.dispose?.();
      await storageManager.close?.();
    },
  };
}

function configFor(space: string) {
  return {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:live",
    space,
  };
}

function depsFor(live: LivePiece) {
  return {
    loadPieces: () => Promise.resolve({ getSpace: () => live.space } as never),
    loadPiece: () => Promise.resolve(live.piece as never),
  };
}

/** The `cf piece verbs --json` payload, exactly as the command emits it. */
async function verbsJson(live: LivePiece): Promise<Record<string, unknown>> {
  const listing = await listPieceCallables(
    configFor(live.space),
    depsFor(live),
  );
  return verbListingJson(listing, false);
}

/** The `cf piece call <verb> --help --json` payload, as the command emits it. */
async function callHelpJson(
  live: LivePiece,
  verb: string,
): Promise<Record<string, unknown>> {
  const executed = await executePieceCallable(
    configFor(live.space),
    verb,
    ["--help", "--json"],
    depsFor(live),
  );
  return JSON.parse(executed.helpText ?? "{}");
}

/** The `cf piece call <verb> --help` text page. */
async function callHelpText(live: LivePiece, verb: string): Promise<string> {
  const executed = await executePieceCallable(
    configFor(live.space),
    verb,
    ["--help"],
    depsFor(live),
  );
  return executed.helpText ?? "";
}

function verbRow(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const verbs = payload.verbs as Record<string, unknown>[];
  const row = verbs.find((verb) => verb.name === name);
  expect(row).toBeDefined();
  return row!;
}

describe("an author's verb prose reaching a caller", () => {
  describe("cf piece verbs --json", () => {
    it("carries the verb's own doc comment as its description", async () => {
      const live = await runLivePiece("verb-prose-listing");
      try {
        expect(verbRow(await verbsJson(live), "add").description)
          .toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });

    it("carries an event field's doc comment in the row's input schema", async () => {
      const live = await runLivePiece("verb-prose-listing-field");
      try {
        const row = verbRow(await verbsJson(live), "add");
        expect(row.inputSchema).toMatchObject({
          properties: { title: { type: "string", description: FIELD_PROSE } },
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries every declared field, read by the body or not", async () => {
      const live = await runLivePiece("verb-prose-listing-shape");
      try {
        const inputSchema = verbRow(await verbsJson(live), "add")
          .inputSchema as Record<string, unknown>;
        // `AddEvent.urgent` is declared and documented, and this handler's
        // body reads only `title`. The listing carries `urgent` anyway,
        // because the served schema is the verb's input contract — the
        // authored event — per docs/history/plans/verb-input-contract.md: a contract
        // is edited deliberately, and a field the body ignores today is
        // still one the author asked callers to send. Dispatch delivers it
        // like any interface delivers an unused parameter; what the handler
        // may DO stays usage-derived.
        expect(Object.keys(inputSchema.properties as object)).toEqual([
          "title",
          "urgent",
          "details",
          "primary",
        ]);
      } finally {
        await live.dispose();
      }
    });

    it("carries an array field's prose from behind a declared reference", async () => {
      const live = await runLivePiece("verb-prose-listing-nested-array");
      try {
        const row = verbRow(await verbsJson(live), "add");
        // `details` is a `$ref` to `Details` on the served side too — the
        // contract serves the authored shape (verb-input-contract.md) — so
        // `tags` and its prose live in the shared definition, one reference
        // in, and the position itself carries the field's own sentence.
        expect(row.inputSchema).toMatchObject({
          properties: {
            details: {
              $ref: "#/$defs/Details",
              description: "Anything else worth recording.",
            },
          },
          $defs: {
            Details: {
              properties: {
                tags: { type: "array", description: NESTED_ARRAY_PROSE },
              },
            },
          },
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries an object field's prose from behind a declared reference", async () => {
      const live = await runLivePiece("verb-prose-listing-nested-object");
      try {
        // `annotate` reads `details.note` and nothing else; the served
        // schema is the authored contract regardless, so the note's prose
        // sits in the shared `Details` definition the position references.
        const row = verbRow(await verbsJson(live), "annotate");
        expect(row.inputSchema).toMatchObject({
          properties: {
            details: { $ref: "#/$defs/Details" },
          },
          $defs: {
            Details: {
              properties: {
                note: { type: "string", description: NESTED_PROSE },
              },
            },
          },
        });
      } finally {
        await live.dispose();
      }
    });

    it("terminates on a self-referential event type and annotates it", async () => {
      const live = await runLivePiece("verb-prose-listing-cycle");
      try {
        // `Node.children` is `Node[]`, a genuine cycle in the served
        // document: `$defs.Node.children.items` references `$defs.Node`
        // again. Reaching the assertion at all — no exhausted stack — is
        // half of what this pins.
        const row = verbRow(await verbsJson(live), "graft");
        // The other half: the recursion serves as the authored reference,
        // and the prose rides both the position and the definition.
        expect(row.inputSchema).toMatchObject({
          properties: {
            node: {
              $ref: "#/$defs/Node",
              description: "The subtree to graft.",
            },
          },
          $defs: {
            Node: {
              properties: {
                children: {
                  description: "Nodes filed under this one.",
                  items: { $ref: "#/$defs/Node" },
                },
              },
            },
          },
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries prose in the arms of a union the served side keeps", async () => {
      const live = await runLivePiece("verb-prose-listing-union");
      try {
        // `pet: Cat | Dog` is `anyOf` on the served side too — the contract
        // keeps the authored arms — and each arm's prose rides its own
        // definition, exactly where the author wrote it.
        const row = verbRow(await verbsJson(live), "classify");
        expect(row.inputSchema).toMatchObject({
          properties: {
            pet: { description: "The animal to file." },
          },
          $defs: {
            Cat: { properties: { meow: { description: "How loud it is." } } },
            Dog: { properties: { woof: { description: "How deep it is." } } },
          },
        });
      } finally {
        await live.dispose();
      }
    });

    it("leaves a served reference as a reference and its definition untouched", async () => {
      const live = await runLivePiece("verb-prose-listing-ref-shape");
      try {
        const inputSchema = verbRow(await verbsJson(live), "add")
          .inputSchema as Record<string, unknown>;
        const properties = inputSchema.properties as Record<string, any>;
        // `Tag` is reached twice — through `Details.tags.items` and through
        // `primary` — and both are served as references that must stay
        // references, byte for byte. An implementation that inlined a target to
        // annotate it would satisfy every description assertion in this file
        // and silently change the shape a caller's tooling reads, so these are
        // equalities rather than subsets.
        const defs = inputSchema.$defs as Record<string, any>;
        expect(defs.Details.properties.tags.items).toEqual({
          $ref: "#/$defs/Tag",
        });
        expect(properties.primary).toEqual({
          $ref: "#/$defs/Tag",
          description: "The tag that leads.",
        });
        // And the shared definition is untouched. This is the assertion that
        // fails against writing a position's own prose into the target it
        // names: `primary` is "The tag that leads.", and a `Tag` carrying that
        // sentence would tell every OTHER holder of a tag the same thing —
        // including `details.tags`, which leads nothing.
        expect(defs.Tag).toEqual({
          type: "object",
          properties: {
            label: { type: "string", description: ELEMENT_PROSE },
          },
          required: ["label"],
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries a description on the documented verb and not on its neighbor", async () => {
      const live = await runLivePiece("verb-prose-listing-undocumented");
      try {
        const payload = await verbsJson(live);
        // An implementation that supplies a description from anywhere but the
        // author's comment — the property name, the event type's name, an
        // empty string — fails on the first of these while passing every other
        // assertion in this file.
        expect("description" in verbRow(payload, "rename")).toBe(false);
        // And one that keys the prose by anything looser than the property
        // name — the first documented verb, say — fails on the second.
        expect(verbRow(payload, "add").description).toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });
  });

  describe("cf piece call --help --json", () => {
    it("carries the verb's own doc comment as its description", async () => {
      const live = await runLivePiece("verb-prose-help-json");
      try {
        expect((await callHelpJson(live, "add")).description).toBe(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });

    it("carries an event field's doc comment in the served input schema", async () => {
      const live = await runLivePiece("verb-prose-help-json-field");
      try {
        expect((await callHelpJson(live, "add")).inputSchema).toMatchObject({
          properties: { title: { type: "string", description: FIELD_PROSE } },
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries an array field's prose from behind a declared reference", async () => {
      const live = await runLivePiece("verb-prose-help-json-nested-array");
      try {
        // The help path assembles its spec separately from the listing, so a
        // fix applied to one and not the other passes half this file. Both
        // nested shapes are asserted on both surfaces for that reason.
        expect((await callHelpJson(live, "add")).inputSchema).toMatchObject({
          properties: {
            details: { $ref: "#/$defs/Details" },
          },
          $defs: {
            Details: {
              properties: { tags: { description: NESTED_ARRAY_PROSE } },
            },
          },
        });
      } finally {
        await live.dispose();
      }
    });

    it("carries an object field's prose from behind a declared reference", async () => {
      const live = await runLivePiece("verb-prose-help-json-nested-object");
      try {
        expect((await callHelpJson(live, "annotate")).inputSchema)
          .toMatchObject({
            properties: {
              details: { $ref: "#/$defs/Details" },
            },
            $defs: {
              Details: {
                properties: { note: { description: NESTED_PROSE } },
              },
            },
          });
      } finally {
        await live.dispose();
      }
    });

    it("carries prose in the arms of a union the served side keeps", async () => {
      const live = await runLivePiece("verb-prose-help-json-union");
      try {
        expect((await callHelpJson(live, "classify")).inputSchema)
          .toMatchObject({
            $defs: {
              Cat: {
                properties: { meow: { description: "How loud it is." } },
              },
              Dog: {
                properties: { woof: { description: "How deep it is." } },
              },
            },
          });
      } finally {
        await live.dispose();
      }
    });

    it("leaves a served reference as a reference and its definition untouched", async () => {
      const live = await runLivePiece("verb-prose-help-json-ref-shape");
      try {
        const inputSchema = (await callHelpJson(live, "add"))
          .inputSchema as Record<string, any>;
        expect(inputSchema.$defs.Details.properties.tags.items).toEqual({
          $ref: "#/$defs/Tag",
        });
        expect(inputSchema.$defs.Tag).toEqual({
          type: "object",
          properties: {
            label: { type: "string", description: ELEMENT_PROSE },
          },
          required: ["label"],
        });
      } finally {
        await live.dispose();
      }
    });

    it("leaves an undocumented verb with no description", async () => {
      const live = await runLivePiece("verb-prose-help-json-undocumented");
      try {
        expect("description" in await callHelpJson(live, "rename")).toBe(false);
      } finally {
        await live.dispose();
      }
    });
  });

  describe("cf piece call --help", () => {
    it("prints the verb's own doc comment as the page's summary line", async () => {
      const live = await runLivePiece("verb-prose-help-text");
      try {
        const page = await callHelpText(live, "add");
        // Between Usage and JSON input, as a paragraph of its own: asserted as
        // a whole block rather than by containment, because the prose also
        // reaches the page through nothing else and a bare `toContain` would
        // pass against a page that printed it in the wrong place or twice.
        expect(page).toContain(`\n\n${VERB_PROSE}\n\nJSON input:\n`);
      } finally {
        await live.dispose();
      }
    });

    it("prints an event field's doc comment beside its flag", async () => {
      const live = await runLivePiece("verb-prose-help-text-field");
      try {
        // On the flag's own line, after its required-ness. The column width is
        // whatever the widest flag on the page needs, so the gap is matched as
        // whitespace rather than counted — but it must be a gap and not a line
        // break, which is what makes this an assertion about the flag line
        // rather than about the page containing the sentence anywhere.
        expect(await callHelpText(live, "add")).toMatch(
          new RegExp(`--title <string> +Required\\. ${FIELD_PROSE}`),
        );
      } finally {
        await live.dispose();
      }
    });

    it("prints no summary line for an undocumented verb", async () => {
      const live = await runLivePiece("verb-prose-help-text-undocumented");
      try {
        // Usage runs straight into JSON input, with no blank paragraph
        // standing where prose would be.
        expect(await callHelpText(live, "rename")).toContain(
          "\n\nJSON input:\n",
        );
        expect(await callHelpText(live, "rename")).not.toContain(VERB_PROSE);
      } finally {
        await live.dispose();
      }
    });
  });
});
