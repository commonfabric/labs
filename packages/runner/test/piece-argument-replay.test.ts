/**
 * Setting up a piece whose argument document already exists writes that whole
 * document, so what the write carries decides what survives. A caller names
 * some of the argument's slots and leaves the rest to the piece: a nested
 * piece is instantiated with the argument its parent's expression carries —
 * `Child({ supplied })` names one slot — and the piece's own durable state
 * lives in the slots that expression never mentions.
 *
 * These tests pin both routes a same-pattern setup takes over an existing
 * argument document: `Runner.#applySetupState`, which a piece reaches when it
 * holds no registration (the nested piece its parent restarts), and
 * `Runner.#maybeReuseRunningSetup`, which a registered piece reaches when it is
 * run again with an argument. They pin the route a changed pattern takes as
 * well, the restage in `Runner.#applySetupState`, which a nested piece reaches
 * when its code changed: the stored slots survive it, and a slot holding
 * nothing takes its default, as does a stored slot the new code's input type
 * refuses, with a warning, once the value it held is copied into the piece's
 * refused-slot store.
 *
 * The document's bindings are the setup's to write, and the cells they name
 * are not. A setup that binds a slot, or the whole argument, another way
 * replaces the binding, and leaves the cell it named as that cell's owner left
 * it; a setup that binds it the same way leaves the document as it was, also
 * where the bound content is realized at a narrower scope.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";

import {
  type PieceAddress,
  type RefusedArgumentSlots,
  refusedArgumentSlotsCell,
} from "../src/refused-argument-slots.ts";
import { isPrimitiveCellLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("piece argument replay");
const space = signer.did();

// `kept` and `label` are the piece's own state: each seeded from its schema
// default at the first setup, and changed by `add` and `relabel` after that.
// `supplied` is what a caller passes in.
const CHILD_SOURCE = [
  "import { Default, handler, pattern, Stream, Writable } from 'commonfabric';",
  "",
  "export interface Arguments {",
  "  supplied?: string | Default<'seed'>;",
  "  kept?: string[] | Default<[]>;",
  "  label?: string | Default<'unlabeled'>;",
  "}",
  "",
  "export interface Surface {",
  "  add: Stream<{ text: string }>;",
  "  relabel: Stream<{ text: string }>;",
  "  kept: readonly string[];",
  "  label: string;",
  "}",
  "",
  "const add = handler<{ text: string }, { kept: Writable<string[]> }>(",
  "  ({ text }, { kept }) => {",
  "    kept.push(text);",
  "  },",
  ");",
  "",
  "const relabel = handler<{ text: string }, { label: Writable<string> }>(",
  "  ({ text }, { label }) => {",
  "    label.set(text);",
  "  },",
  ");",
  "",
  "export default pattern<Arguments, Surface>(({ kept, label }) => ({",
  "  add: add({ kept }),",
  "  relabel: relabel({ label }),",
  "  kept,",
  "  label,",
  "}));",
  "",
].join("\n");

// The parent's expression names `supplied` alone, so the nested piece's `kept`
// and `label` are state no caller passes down. Its streams and readings are
// re-exported so a test drives and reads the nested piece through the root.
const PARENT_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "import Child, { type Arguments, type Surface } from './child.tsx';",
  "",
  "export default pattern<Arguments, Surface>(({ supplied }) => {",
  "  const child = Child({ supplied });",
  "  return {",
  "    add: child.add,",
  "    relabel: child.relabel,",
  "    kept: child.kept,",
  "    label: child.label,",
  "  };",
  "});",
  "",
].join("\n");

const files = [
  { name: "/child.tsx", contents: CHILD_SOURCE },
  { name: "/main.tsx", contents: PARENT_SOURCE },
];

const parentProgram: RuntimeProgram = { main: "/main.tsx", files };
const childProgram: RuntimeProgram = { main: "/child.tsx", files };

/** Run `probe` against a fresh runtime over an emulated store. */
const withRuntime = async (
  probe: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    await probe(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * Run `program` at `cause` with `supplied` alone, then grow the piece's `kept`
 * to `["one", "two"]` through its `add` stream, and set its `label` to `mine`
 * through its `relabel` stream.
 */
const startedPiece = async (
  runtime: Runtime,
  program: RuntimeProgram,
  cause: string,
) => {
  const tx = runtime.edit();
  const pattern = await runtime.patternManager.compilePattern(program, {
    space,
    tx,
  });
  const cell = runtime.getCell<Record<string, unknown>>(
    space,
    cause,
    undefined,
    tx,
  );
  const running = runtime.run(tx, pattern, { supplied: "first" }, cell);
  await tx.commit().settled;
  await running.pull();
  await runtime.idle();

  for (const text of ["one", "two"]) {
    (cell.key("add") as unknown as { send: (event: unknown) => void })
      .send({ text });
    await runtime.idle();
  }
  (cell.key("relabel") as unknown as { send: (event: unknown) => void })
    .send({ text: "mine" });
  await runtime.idle();
  await cell.pull();
  expect(cell.key("kept").get()).toEqual(["one", "two"]);
  expect(cell.key("label").get()).toBe("mine");
  return { cell, pattern };
};

/**
 * The parent and child sources with `childSource` in place of the child's, and
 * `parentSource` in place of the parent's when it is given.
 */
const changedFiles = (childSource: string, parentSource = PARENT_SOURCE) => [
  { name: "/child.tsx", contents: childSource },
  { name: "/main.tsx", contents: parentSource },
];

/** Compile the program `files` makes, rooted at the parent. */
const compiledParent = (
  runtime: Runtime,
  files: { name: string; contents: string }[],
  tx: ReturnType<Runtime["edit"]>,
) =>
  runtime.patternManager.compilePattern({ main: "/main.tsx", files }, {
    space,
    tx,
  });

/**
 * Stop the piece in `cell` and run it again on the program `files` makes,
 * leaving its argument to what the piece has stored, as an update of its code
 * does.
 */
const runChanged = async (
  runtime: Runtime,
  cell: Awaited<ReturnType<typeof startedPiece>>["cell"],
  files: { name: string; contents: string }[],
) => {
  runtime.runner.stop(cell);
  const tx = runtime.edit();
  const pattern = await compiledParent(runtime, files, tx);
  const running = runtime.run(tx, pattern, undefined, cell);
  await tx.commit().settled;
  await running.pull();
  await runtime.idle();
  await cell.pull();
};

/** The piece a `setup-stored-slot-dropped` warning names, in `space`. */
const pieceNamedIn = (warning: string): PieceAddress => {
  const id = /on piece `([^`]+)`/.exec(warning)?.[1];
  expect(id).toBeDefined();
  // The pieces these tests set up live at space scope.
  return { space, id: id as PieceAddress["id"], scope: "space" };
};

/** The refused-slot store of `piece`, as stored. */
const refusedSlotsOf = async (
  runtime: Runtime,
  piece: PieceAddress,
): Promise<RefusedArgumentSlots> => {
  const record = refusedArgumentSlotsCell(runtime, piece);
  await record.sync();
  return record.getRaw() as RefusedArgumentSlots;
};

/**
 * The message of each warning the runner's logger emits under `key` while
 * `fn` runs, resolving each lazy message the way the logger itself does. The
 * capture is at the logger rather than at the console, which `LOG_TO_STDERR`
 * would route around.
 */
const warningsDuring = async (
  key: string,
  fn: () => Promise<void>,
): Promise<string[]> => {
  const logger = getLogger("runner");
  const original = logger.warn;
  const warnings: string[] = [];
  logger.warn = (warnedKey, ...messages) => {
    if (warnedKey === key) {
      warnings.push(
        messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved : [resolved];
        }).join(" "),
      );
    }
    original.call(logger, warnedKey, ...messages);
  };
  try {
    await fn();
  } finally {
    logger.warn = original;
  }
  return warnings;
};

describe("piece argument replay", () => {
  it("keeps a nested piece's state when its parent is restarted", async () => {
    await withRuntime(async (runtime) => {
      const { cell } = await startedPiece(
        runtime,
        parentProgram,
        "parent-restart",
      );

      runtime.runner.stop(cell);
      expect(await runtime.start(cell)).toBe(true);
      await runtime.idle();
      await cell.pull();

      expect(
        cell.key("kept").get(),
        "the restart re-instantiated the nested piece with the argument its " +
          "parent's expression names, and dropped the slots that expression " +
          "leaves to the piece",
      ).toEqual(["one", "two"]);
    });
  });

  describe("when the nested piece's code changes", () => {
    // Each change gives the nested piece a new pattern identity, so its
    // parent sets it up again over its existing argument document with the
    // argument the parent's expression carries.

    it("keeps the nested piece's state across a change to a comment", async () => {
      await withRuntime(async (runtime) => {
        const { cell } = await startedPiece(
          runtime,
          parentProgram,
          "child-comment-change",
        );

        await runChanged(
          runtime,
          cell,
          changedFiles("// A comment and nothing else.\n" + CHILD_SOURCE),
        );

        expect(
          cell.key("kept").get(),
          "the nested piece was set up again with the argument its parent's " +
            "expression names, and `kept` was written over with its default",
        ).toEqual(["one", "two"]);
      });
    });

    it("fills an input the changed code adds with its default, and keeps the stored ones", async () => {
      await withRuntime(async (runtime) => {
        const { cell } = await startedPiece(
          runtime,
          parentProgram,
          "child-input-added",
        );

        const child = CHILD_SOURCE
          .replace(
            "  kept?: string[] | Default<[]>;\n",
            "  kept?: string[] | Default<[]>;\n" +
              "  note?: string | Default<'fresh'>;\n",
          )
          .replace(
            "  kept: readonly string[];\n",
            "  kept: readonly string[];\n  note: string;\n",
          )
          .replace(
            "(({ kept, label }) => ({",
            "(({ kept, label, note }) => ({\n  note,",
          );
        const parent = PARENT_SOURCE.replace(
          "    label: child.label,\n",
          "    label: child.label,\n    note: child.note,\n",
        );
        expect(child).not.toBe(CHILD_SOURCE);
        expect(child).toContain("({\n  note,");
        expect(parent).not.toBe(PARENT_SOURCE);

        await runChanged(runtime, cell, changedFiles(child, parent));

        expect(cell.key("note").get()).toBe("fresh");
        expect(cell.key("kept").get()).toEqual(["one", "two"]);
      });
    });

    describe("to an input type that refuses a stored value", () => {
      // `kept` holds a list, and the changed code's input takes a number,
      // while `label` keeps a type that accepts what it holds. The parent's
      // own argument stops declaring `kept`, so the nested piece's argument is
      // the only one the change reaches.

      const narrowedChild = CHILD_SOURCE
        .replace(
          "kept?: string[] | Default<[]>;",
          "kept?: number | Default<0>;",
        )
        .replace("kept: readonly string[];", "kept: number;")
        .replace("kept: Writable<string[]>", "kept: Writable<number>")
        .replace("kept.push(text);", "kept.set(text.length);");
      const narrowedParent = PARENT_SOURCE
        .replace(
          "import Child, { type Arguments, type Surface }",
          "import Child, { type Surface }",
        )
        .replace(
          "pattern<Arguments, Surface>",
          "pattern<{ supplied?: string }, Surface>",
        );

      it("sets the refused slot to its default, and keeps the stored slots the type accepts", async () => {
        await withRuntime(async (runtime) => {
          const { cell } = await startedPiece(
            runtime,
            parentProgram,
            "child-input-narrowed",
          );
          expect(narrowedChild).toContain("kept.set(text.length);");
          expect(narrowedParent).toContain("pattern<{ supplied?: string }");

          await runChanged(
            runtime,
            cell,
            changedFiles(narrowedChild, narrowedParent),
          );

          expect(cell.key("kept").get()).toBe(0);
          expect(cell.key("label").get()).toBe("mine");
        });
      });

      it("warns of the refused slot alone, naming the pattern, the slot and the mismatch", async () => {
        await withRuntime(async (runtime) => {
          const { cell } = await startedPiece(
            runtime,
            parentProgram,
            "child-input-narrowed-warning",
          );

          const warnings = await warningsDuring(
            "setup-stored-slot-dropped",
            () =>
              runChanged(
                runtime,
                cell,
                changedFiles(narrowedChild, narrowedParent),
              ),
          );

          expect(warnings.length).toBe(1);
          expect(warnings[0]).toContain("/child.tsx");
          expect(warnings[0]).toContain("its stored `kept`");
          expect(warnings[0]).toContain("does not match type number");
        });
      });

      it("keeps the value the refused slot held in the piece's refused-slot store", async () => {
        await withRuntime(async (runtime) => {
          const { cell } = await startedPiece(
            runtime,
            parentProgram,
            "child-input-narrowed-kept",
          );

          const warnings = await warningsDuring(
            "setup-stored-slot-dropped",
            () =>
              runChanged(
                runtime,
                cell,
                changedFiles(narrowedChild, narrowedParent),
              ),
          );

          const record = await refusedSlotsOf(
            runtime,
            pieceNamedIn(warnings[0]),
          );
          expect(Object.keys(record)).toEqual(["kept"]);
          const entries = Object.values(record.kept).flat();
          expect(entries.length).toBe(1);
          expect(entries[0].value).toEqual(["one", "two"]);
          expect(entries[0].reason).toContain("does not match type number");
          expect(cell.key("kept").get()).toBe(0);
        });
      });

      it("names the refused-slot store in its warning", async () => {
        await withRuntime(async (runtime) => {
          const { cell } = await startedPiece(
            runtime,
            parentProgram,
            "child-input-narrowed-record-warning",
          );

          const warnings = await warningsDuring(
            "setup-stored-slot-dropped",
            () =>
              runChanged(
                runtime,
                cell,
                changedFiles(narrowedChild, narrowedParent),
              ),
          );

          const id = refusedArgumentSlotsCell(
            runtime,
            pieceNamedIn(warnings[0]),
          ).getAsNormalizedFullLink().id;
          expect(warnings.length).toBe(1);
          expect(warnings[0]).toContain(
            `the value it held is kept in \`${id}\``,
          );
        });
      });

      it("keeps a labeled refused value under that label, and still sets the piece up, under strict enforcement", async () => {
        // The nested piece's argument document is declared personal to the
        // signer at its root, as a manager's is once Home has stamped it. The
        // setup reads that value to copy it, so a record declaring nothing
        // would be a misfit the strict rung refuses, and the whole setup with
        // it.

        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
        const personal = {
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: signer.did(),
        };
        const storedLabels = (id: string) =>
          (storageManager.open(space).replica as unknown as {
            getDocument(id: string): {
              cfc?: {
                labelMap?: {
                  entries: { label: { confidentiality?: unknown[] } }[];
                };
              };
            } | undefined;
          }).getDocument(id)?.cfc?.labelMap?.entries ?? [];
        try {
          const { cell } = await startedPiece(
            runtime,
            parentProgram,
            "child-input-narrowed-labeled",
          );
          const argument = {
            ...cell.key("kept").resolveAsCell().getAsNormalizedFullLink(),
            path: [],
          };
          const tx = runtime.edit();
          runtime.getCellFromLink(
            argument,
            { type: "object", ifc: { confidentiality: [personal] } },
            tx,
          ).set(runtime.getCellFromLink(argument).getRaw() as never);
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          expect(
            storedLabels(argument.id).flatMap(({ label }) =>
              label.confidentiality ?? []
            ),
          ).toContainEqual(personal);

          const warnings = await warningsDuring(
            "setup-stored-slot-dropped",
            () =>
              runChanged(
                runtime,
                cell,
                changedFiles(narrowedChild, narrowedParent),
              ),
          );

          expect(cell.key("kept").get()).toBe(0);
          expect(cell.key("label").get()).toBe("mine");
          const piece = pieceNamedIn(warnings[0]);
          const record = await refusedSlotsOf(runtime, piece);
          expect(Object.values(record.kept).flat().map(({ value }) => value))
            .toEqual([["one", "two"]]);
          const recordId = refusedArgumentSlotsCell(runtime, piece)
            .getAsNormalizedFullLink().id;
          expect(
            storedLabels(recordId).flatMap(({ label }) =>
              label.confidentiality ?? []
            ),
          ).toContainEqual(personal);
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    });

    it("sets every stored slot to its default when the argument as a whole refuses them, and warns of each", async () => {
      // The argument is a union whose branch the parent's `mode` picks. The
      // stored `kept` fits one branch, so it passes when judged alone, and
      // the parent's new `mode` picks the other.

      const child = [
        "import { Default, handler, pattern, Stream, Writable } from 'commonfabric';",
        "",
        "export type Arguments =",
        "  | { mode: 'list'; kept?: string[] | Default<[]> }",
        "  | { mode: 'count'; kept?: number | Default<0> };",
        "",
        "const add = handler<{ text: string }, { kept: Writable<unknown> }>(",
        "  ({ text }, { kept }) => {",
        "    kept.set([text]);",
        "  },",
        ");",
        "",
        "export default pattern<",
        "  Arguments,",
        "  { add: Stream<{ text: string }>; kept: unknown }",
        ">(({ kept }) => ({ add: add({ kept }), kept }));",
        "",
      ].join("\n");
      const parent = (mode: string) =>
        [
          "import { pattern } from 'commonfabric';",
          "import Child from './child.tsx';",
          "",
          "export default pattern<{ unused?: string }, any>(() => {",
          `  const child = Child({ mode: '${mode}' });`,
          "  return { add: child.add, kept: child.kept };",
          "});",
          "",
        ].join("\n");

      await withRuntime(async (runtime) => {
        const tx = runtime.edit();
        const pattern = await compiledParent(
          runtime,
          changedFiles(child, parent("list")),
          tx,
        );
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "child-union-branch",
          undefined,
          tx,
        );
        const running = runtime.run(tx, pattern, {}, cell);
        await tx.commit().settled;
        await running.pull();
        await runtime.idle();
        (cell.key("add") as unknown as { send: (event: unknown) => void })
          .send({ text: "one" });
        await runtime.idle();
        await cell.pull();
        expect(cell.key("kept").get()).toEqual(["one"]);

        const warnings = await warningsDuring(
          "setup-stored-slot-dropped",
          () =>
            runChanged(
              runtime,
              cell,
              changedFiles("// A comment.\n" + child, parent("count")),
            ),
        );

        expect(cell.key("kept").get()).toBe(0);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("its stored `kept`");
        expect(warnings[0]).toContain("the argument as a whole refuses it");
        const record = await refusedSlotsOf(runtime, pieceNamedIn(warnings[0]));
        expect(Object.values(record.kept).flat().map(({ value }) => value))
          .toEqual([
            ["one"],
          ]);
      });
    });

    it("keeps a session-scoped nested piece's argument object when its code changes under the same session", async () => {
      // The parent mounts the nested piece per session over a computed
      // object, so the nested piece's argument document holds a redirect to
      // the computed's space slot. Here that slot's content is realized at
      // its user instance, behind a same-document redirect. Setting the
      // nested piece up again in the session that already holds its
      // argument re-sets the argument to the redirect it holds, and the
      // object at the user instance stays an object.
      const childSource = (suffix: string) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          "",
          "export interface Arguments { a: string; items: string[] }",
          "export interface Surface { joined: string }",
          "",
          "export default pattern<Arguments, Surface>(({ a, items }) => ({",
          `  joined: computed(() => a + ':' + items.join(',') + '${suffix}'),`,
          "}));",
          "",
        ].join("\n");
      const parentSource = [
        "import { computed, pattern, Writable } from 'commonfabric';",
        "import Child from './child.tsx';",
        "",
        "export default pattern<",
        "  { x: string },",
        "  { joined: string; child: unknown }",
        ">(({ x }) => {",
        "  const items = Writable.of<string[]>(['i1']);",
        "  const child = Child.asScope('session')(",
        "    computed(() => ({ a: x, items })),",
        "  );",
        "  return { joined: child.joined, child };",
        "});",
        "",
      ].join("\n");

      await withRuntime(async (runtime) => {
        const tx = runtime.edit();
        const pattern = await compiledParent(
          runtime,
          changedFiles(childSource(""), parentSource),
          tx,
        );
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          "session-child-realized-argument",
          undefined,
          tx,
        );
        const running = runtime.run(tx, pattern, { x: "hello" }, cell);
        await tx.commit().settled;
        await running.pull();
        await runtime.idle();
        await cell.pull();
        expect(cell.key("joined").get()).toBe("hello:i1");

        const argument = cell.key("child").resolveAsCell().getArgumentCell();
        expect(argument?.getAsNormalizedFullLink().scope).toBe("session");
        const argumentLink = parseLink(argument?.getRaw(), argument);
        expect(argumentLink?.overwrite).toBe("redirect");
        const slot = (scope: "space" | "user") =>
          runtime.getCellFromLink<FabricValue>({
            ...argumentLink!,
            path: [],
            scope,
          });
        const content = slot("space").getRaw();
        expect(isPrimitiveCellLink(content)).toBe(false);

        const realize = runtime.edit();
        slot("user").withTx(realize).setRaw(content);
        slot("space").withTx(realize).setRaw({
          "/": { "link@1": { overwrite: "redirect", path: [], scope: "user" } },
        });
        await realize.commit().settled;

        await runChanged(
          runtime,
          cell,
          changedFiles(childSource("!"), parentSource),
        );

        expect(
          isPrimitiveCellLink(slot("user").getRaw()),
          "the argument's re-set wrote a link to the space slot into the " +
            "instance that slot redirects to",
        ).toBe(false);
        expect(
          cell.key("joined").get(),
          "the nested piece started on the changed code; a link cycle at its " +
            "argument refuses the start's commit",
        ).toBe("hello:i1!");
      });
    });
  });

  describe("when the parent binds the nested piece's argument another way", () => {
    // A parent passing a cell of its own binds the nested piece's argument to
    // that cell: the argument document holds a write redirect to it, and the
    // nested piece's writes through the argument reach the parent's cell.
    // When the parent's code changes to pass something else, setting the
    // nested piece up again binds the argument anew. The cell it was bound to
    // stays the parent's, as it was.

    const BINDING_CHILD_SOURCE = [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "export interface Arguments { a: string; items: string[] }",
      "",
      "export default pattern<Arguments, { joined: string }>(",
      "  ({ a, items }) => ({",
      "    joined: computed(() => a + ':' + items.join(',')),",
      "  }),",
      ");",
      "",
    ].join("\n");

    // `argument` is the expression the parent passes the nested piece. The
    // parent returns its own two cells, so a test reads what they hold.
    const bindingParentSource = (argument: string) =>
      [
        "import { computed, pattern, Writable } from 'commonfabric';",
        "import Child from './child.tsx';",
        "",
        "export default pattern<",
        "  { x: string },",
        "  {",
        "    joined: string;",
        "    shared: { a: string; items: string[] };",
        "    sharedItems: string[];",
        "  }",
        ">(({ x }) => {",
        "  const shared = Writable.of<{ a: string; items: string[] }>({",
        "    a: 'shared',",
        "    items: ['s1'],",
        "  });",
        "  const sharedItems = Writable.of<string[]>(['parent-item']);",
        `  const child = Child(${argument});`,
        "  return { joined: child.joined, shared, sharedItems };",
        "});",
        "",
      ].join("\n");

    /**
     * Run the parent passing `before`, then run it again on code passing
     * `after`, and return what the nested piece and the parent's two cells
     * hold afterwards.
     */
    const rebound = async (
      runtime: Runtime,
      cause: string,
      before: string,
      after: string,
    ) => {
      const tx = runtime.edit();
      const pattern = await compiledParent(
        runtime,
        changedFiles(BINDING_CHILD_SOURCE, bindingParentSource(before)),
        tx,
      );
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
        tx,
      );
      const running = runtime.run(tx, pattern, { x: "hello" }, cell);
      await tx.commit().settled;
      await running.pull();
      await runtime.idle();
      await cell.pull();

      await runChanged(
        runtime,
        cell,
        changedFiles(BINDING_CHILD_SOURCE, bindingParentSource(after)),
      );
      return {
        joined: cell.key("joined").get(),
        shared: cell.key("shared").get(),
        sharedItems: cell.key("sharedItems").get(),
      };
    };

    it("leaves the parent's cell as it was when the parent passes a record in its place", async () => {
      await withRuntime(async (runtime) => {
        const after = await rebound(
          runtime,
          "rebind-whole-to-record",
          "shared",
          "{ a: x, items: ['lit'] }",
        );

        expect(after.joined).toBe("hello:lit");
        expect(
          after.shared,
          "the record was written through the old binding into the cell it " +
            "named",
        ).toEqual({ a: "shared", items: ["s1"] });
      });
    });

    it("leaves the parent's cell as it was when the parent passes a computed object in its place", async () => {
      await withRuntime(async (runtime) => {
        const after = await rebound(
          runtime,
          "rebind-whole-to-computed",
          "shared",
          "computed(() => ({ a: x, items: ['c1'] }))",
        );

        expect(after.joined).toBe("hello:c1");
        expect(after.shared).toEqual({ a: "shared", items: ["s1"] });
      });
    });

    it("leaves the parent's cell as it was when the parent passes a value for the slot bound to it", async () => {
      await withRuntime(async (runtime) => {
        const after = await rebound(
          runtime,
          "rebind-slot-to-value",
          "{ a: x, items: sharedItems }",
          "{ a: x, items: ['lit'] }",
        );

        expect(after.joined).toBe("hello:lit");
        expect(
          after.sharedItems,
          "the value was written through the slot's old binding into the " +
            "cell it named",
        ).toEqual(["parent-item"]);
      });
    });
  });

  it("keeps the slots an argument does not name when a running piece is run again", async () => {
    await withRuntime(async (runtime) => {
      const { cell, pattern } = await startedPiece(
        runtime,
        childProgram,
        "running-rerun",
      );

      const tx = runtime.edit();
      runtime.run(tx, pattern, { supplied: "second" }, cell);
      await tx.commit().settled;
      await runtime.idle();
      await cell.pull();

      expect(
        cell.key("kept").get(),
        "the re-run wrote the whole argument document from a value naming " +
          "`supplied` alone, so `kept` fell back to its schema default",
      ).toEqual(["one", "two"]);
    });
  });
});
