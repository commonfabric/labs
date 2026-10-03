import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime, UI } from "@commonfabric/runner";
import {
  createRenderConfidentialityResolver,
  type SpaceMembershipProvider,
} from "@commonfabric/runner/cfc";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { CellLinkRefPayload } from "../../runner/src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../../runner/src/storage/interface.ts";
import { interceptTransaction } from "../../runner/test/support/intercept-transaction.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type {
  WorkerReconcilerOptions,
  WorkerVNode,
} from "../src/worker/types.ts";

// A value the render policy does not admit reaches the page through a
// property, a `$` binding, or a text child read across a link no more than it
// does as a text child read from its own document. Every secret below
// carries a string that appears nowhere else, so a search of the emitted
// operations for it is a search for the value having escaped.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC ceiling over props and bindings", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler cfc prop ceiling",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const secretAtom = {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "SealedStance",
    subject: signer.did(),
  };
  const SECRET = "pizza-behind-the-seal";
  const PUBLIC = "posted-on-the-noticeboard";

  /**
   * Writes `value` to the cell named `id`, with stored labels giving each
   * path in `labels` its confidentiality, or with no label when `labels` is
   * undefined.
   */
  const writeLabeled = async (
    id: string,
    value: string | Record<string, unknown>,
    labels?: readonly [path: string[], confidentiality: readonly CfcAtom[]][],
  ): Promise<Cell<string>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell<string>(signer.did(), id, undefined, tx);
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(tx, {
      space: signer.did(),
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value: value as never,
      ...(labels === undefined ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: labels.map(([path, confidentiality]) => ({
              path,
              label: { confidentiality },
            })),
          },
        },
      }),
    });
    expect((await tx.commit().settled).ok).toBeDefined();
    return runtime.getCell<string>(signer.did(), id);
  };

  /**
   * Writes `value` to the cell named `id`, with a stored label whose
   * confidentiality is `confidentiality`, or with no label when it is
   * undefined.
   */
  const write = (
    id: string,
    value: string | Record<string, unknown>,
    confidentiality?: readonly CfcAtom[],
  ) =>
    writeLabeled(
      id,
      value,
      confidentiality === undefined ? undefined : [[[], confidentiality]],
    );

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  /**
   * Stores `tree` as a document, as a pattern's view is stored, and returns it
   * read as the renderer reads it.
   */
  const stored = async (id: string, tree: unknown) => {
    const tx = runtime.edit();
    runtime.getCell(signer.did(), id, undefined, tx).setRawUntyped(
      tree as never,
    );
    expect((await tx.commit().settled).ok).toBeDefined();
    return runtime.getCell(signer.did(), id).asSchema(rendererVDOMSchema);
  };

  const HOST_CEILING = { renderConfidentialityCeiling: { atoms: [] } };

  /** Mounts `tree`, settles, and returns what was emitted and the unmount. */
  const mount = async (
    tree: WorkerVNode | Cell<unknown>,
    options: Partial<WorkerReconcilerOptions> = {},
  ) => {
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      ...options,
    }).mount(tree);
    await t.settle();
    return {
      ops,
      cancel,
      emitted: () => JSON.stringify(ops),
      propsSet: (key: string) =>
        ops.flatMap((op) =>
          op.op === "set-prop" && op.key === key ? [op.value] : []
        ),
      removed: (key: string) =>
        ops.filter((op) => op.op === "remove-prop" && op.key === key).length,
      bindings: (propName: string) =>
        ops.filter((op) => op.op === "set-binding" && op.propName === propName)
          .length,
      texts: () =>
        ops.flatMap((op) =>
          op.op === "create-text" || op.op === "update-text" ? [op.text] : []
        ),
      placeholders: () =>
        ops.filter((op) =>
          op.op === "create-element" && op.tagName === "cf-cfc-blocked"
        ).length,
    };
  };

  try {
    const secret = await write("prop-ceiling-secret", SECRET, [secretAtom]);
    const plain = await write("prop-ceiling-plain", PUBLIC);

    await t.step(
      "withholds a cell-valued property the ceiling does not admit",
      async () => {
        const page = await mount({
          type: "vnode",
          name: "span",
          props: { title: secret as never, "aria-label": plain as never },
          children: [],
        }, HOST_CEILING);
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.propsSet("title")).toEqual([]);
          expect(page.removed("title")).toBe(0);
          expect(page.propsSet("aria-label")).toEqual([PUBLIC]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "sets a cell-valued property when no ceiling is in force",
      async () => {
        const page = await mount({
          type: "vnode",
          name: "span",
          props: { title: secret as never },
          children: [],
        });
        try {
          expect(page.propsSet("title")).toEqual([SECRET]);
          expect(page.removed("title")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a binding whose untyped field links to a document the ceiling refuses",
      async () => {
        // The host reads the whole of what a binding hands it, a field the
        // binding's schema leaves untyped included, so the read deciding the
        // binding is the read the host's reads are decided on.
        const untyped = { type: "object", properties: { entry: {} } } as const;
        const sealedHolder = await write("prop-ceiling-untyped-sealed", {
          entry: { inner: link(secret) },
        });
        const plainHolder = await write("prop-ceiling-untyped-plain", {
          entry: { inner: link(plain) },
        });
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [{
            type: "vnode",
            name: "cf-input",
            props: { $value: sealedHolder.asSchema(untyped) as never },
            children: [],
          }, {
            type: "vnode",
            name: "cf-textarea",
            props: { $value: plainHolder.asSchema(untyped) as never },
            children: [],
          }],
        }, HOST_CEILING);
        try {
          const bindings = page.ops.filter((op) => op.op === "set-binding");
          expect(bindings).toHaveLength(1);
          expect(page.emitted()).not.toContain(
            sealedHolder.getAsNormalizedFullLink().id,
          );
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "binds a cell the ceiling admits and withholds one it does not",
      async () => {
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [{
            type: "vnode",
            name: "cf-input",
            props: { $value: secret as never },
            children: [],
          }, {
            type: "vnode",
            name: "cf-textarea",
            props: { $value: plain as never },
            children: [],
          }],
        }, HOST_CEILING);
        try {
          const bindings = page.ops.filter((op) => op.op === "set-binding");
          expect(bindings).toHaveLength(1);
          expect(page.emitted()).not.toContain(
            secret.getAsNormalizedFullLink().id,
          );
          expect(page.removed("value")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "binds what a trusted component declares it uses only as a reference",
      async () => {
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [{
            type: "vnode",
            name: "cf-custody-seal",
            props: { $policy: secret as never, $value: secret as never },
            children: [],
          }, {
            type: "vnode",
            name: "cf-custody-answer",
            props: { $output: secret as never, $draft: secret as never },
            children: [],
          }],
        }, HOST_CEILING);
        try {
          expect(page.bindings("policy")).toBe(1);
          expect(page.bindings("output")).toBe(1);
          expect(page.bindings("value")).toBe(0);
          expect(page.bindings("draft")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "gates the properties and bindings of a node read from a cell",
      async () => {
        const root = await stored("prop-ceiling-cell-props", {
          type: "vnode",
          name: "cf-input",
          props: {
            title: link(secret),
            placeholder: link(plain),
            class: "literal",
            $value: link(secret),
          },
          children: [],
        });
        const page = await mount(root, HOST_CEILING);
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.propsSet("title")).toEqual([]);
          expect(page.propsSet("placeholder")).toEqual([PUBLIC]);
          expect(page.propsSet("class")).toEqual(["literal"]);
          expect(page.bindings("value")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a property or binding whose value links to a refused cell",
      async () => {
        const holding = async (id: string, held: Cell<string>) => {
          const tx = runtime.edit();
          runtime.getCell(signer.did(), id, undefined, tx).setRawUntyped({
            inner: link(held),
          } as never);
          expect((await tx.commit().settled).ok).toBeDefined();
          return runtime.getCell(signer.did(), id);
        };
        const secretHolder = await holding(
          "prop-ceiling-secret-holder",
          secret,
        );
        const plainHolder = await holding("prop-ceiling-plain-holder", plain);
        const view = await stored("prop-ceiling-nested-links", {
          type: "vnode",
          name: "cf-input",
          props: {
            data: { inner: link(secret) },
            items: [link(plain)],
            style: { color: link(secret) },
            $value: link(secretHolder),
          },
          children: [],
        });
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {
            data: secretHolder.asSchema(true) as never,
            context: plainHolder.asSchema(true) as never,
          },
          children: [view as never],
        }, HOST_CEILING);
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.propsSet("data")).toEqual([]);
          expect(page.propsSet("style")).toEqual([]);
          expect(page.bindings("value")).toBe(0);
          expect(page.propsSet("items")).toEqual([[PUBLIC]]);
          expect(page.propsSet("context")).toEqual([{ inner: PUBLIC }]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a value read along a path that crosses a link to a refused cell",
      async () => {
        // The table holding the link carries a label of its own, which the
        // ceiling admits; the row it links to carries one the ceiling refuses.
        const me = [cfcAtom.user(signer.did())];
        const row = async (id: string, name: string, secretRow: boolean) => {
          const cell = await write(
            `${id}-row`,
            { name },
            secretRow ? [secretAtom] : undefined,
          );
          await write(`${id}-table`, { row: link(cell) }, me);
          return runtime.getCell(signer.did(), `${id}-table`).key("row")
            .key("name");
        };
        const refused = await row("prop-ceiling-crossing-secret", SECRET, true);
        const admitted = await row(
          "prop-ceiling-crossing-plain",
          PUBLIC,
          false,
        );
        const view = await stored("prop-ceiling-crossing-view", {
          type: "vnode",
          name: "cf-input",
          props: { title: link(refused), $value: link(refused) },
          children: [],
        });
        const page = await mount({
          type: "vnode",
          name: "div",
          props: { title: refused as never, "aria-label": admitted as never },
          children: [view as never],
        }, { renderConfidentialityCeiling: { atoms: me } });
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.propsSet("title")).toEqual([]);
          expect(page.bindings("value")).toBe(0);
          expect(page.propsSet("aria-label")).toEqual([PUBLIC]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a cell child read along a path that crosses a link to a refused cell",
      async () => {
        const me = [cfcAtom.user(signer.did())];
        const crossing = async (
          id: string,
          name: string,
          confidentiality?: readonly CfcAtom[],
        ) => {
          const row = await write(`${id}-row`, { name }, confidentiality);
          await write(`${id}-table`, { row: link(row) }, me);
          return runtime.getCell(signer.did(), `${id}-table`).key("row")
            .key("name");
        };
        const refused = await crossing(
          "child-ceiling-crossing-secret",
          SECRET,
          [secretAtom],
        );
        const admitted = await crossing("child-ceiling-crossing-plain", PUBLIC);
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [refused as never, admitted as never],
        }, { renderConfidentialityCeiling: { atoms: me } });
        const root = await mount(refused, {
          renderConfidentialityCeiling: { atoms: me },
        });
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.texts()).toContain(PUBLIC);
          expect(page.placeholders()).toBe(1);
          expect(root.emitted()).not.toContain(SECRET);
          expect(root.placeholders()).toBe(1);

          // A label-only write to the row a child reads through blocks it, and
          // a write that lifts the label from the other unblocks it.
          await write("child-ceiling-crossing-plain-row", { name: PUBLIC }, [
            secretAtom,
          ]);
          await t.settle();
          expect(page.placeholders()).toBe(2);

          await write("child-ceiling-crossing-secret-row", { name: PUBLIC });
          await t.settle();
          expect(root.texts()).toContain(PUBLIC);
        } finally {
          page.cancel();
          root.cancel();
        }
      },
    );

    await t.step(
      "withholds a cell child whose path follows a link from a refused slot",
      async () => {
        // The label sits on the slot holding the second link the path
        // follows, not on either document's root, and following that link
        // consumes it.
        const me = [cfcAtom.user(signer.did())];
        const leaf = await write("child-ceiling-slot-leaf", { name: SECRET });
        const middle = await writeLabeled("child-ceiling-slot-middle", {
          inner: link(leaf),
          other: PUBLIC,
        }, [[[], me], [["inner"], [secretAtom]]]);
        await write("child-ceiling-slot-table", { row: link(middle) }, me);
        const row = runtime.getCell(signer.did(), "child-ceiling-slot-table")
          .key("row");
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [
            row.key("inner").key("name") as never,
            row.key("other") as never,
          ],
        }, { renderConfidentialityCeiling: { atoms: me } });
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.placeholders()).toBe(1);
          expect(page.texts()).toContain(PUBLIC);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds props reached through a chain of links past a labeled hop",
      async () => {
        // The props link to a document the ceiling admits, whose value is a
        // link to a document holding only a link on to the props. The refused
        // label sits on that middle document alone.
        const me = [cfcAtom.user(signer.did())];
        const chain = async (id: string, confidentiality?: CfcAtom[]) => {
          const props = await write(`${id}-props`, { title: id });
          const middle = await write(
            `${id}-middle`,
            link(props) as never,
            confidentiality,
          );
          const hop = await write(`${id}-hop`, link(middle) as never, me);
          return stored(`${id}-view`, {
            type: "vnode",
            name: "span",
            props: link(hop),
            children: [],
          });
        };
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [
            await chain("prop-ceiling-chain-secret", [secretAtom]) as never,
            await chain("prop-ceiling-chain-plain") as never,
          ],
        }, { renderConfidentialityCeiling: { atoms: me } });
        try {
          expect(page.propsSet("title")).toEqual(["prop-ceiling-chain-plain"]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step("refuses a cell whose stored label cannot be read", () => {
      const { canRenderCellUnderPolicy, rootRenderPolicy } =
        new WorkerReconciler({ onOps: () => {}, ...HOST_CEILING })
          .accessForTestingOnly;
      /** A cell with no schema whose every read returns as `readOrThrow` does. */
      const cellReading = (
        tx: IExtendedStorageTransaction,
        readOrThrow: () => unknown,
      ) =>
        runtime.getCell<unknown>(signer.did(), "prop-ceiling-label-read")
          .withTx(interceptTransaction(
            tx,
            (method, _args, proceed) =>
              method === "readOrThrow" ? readOrThrow() : proceed(),
          ));
      const tx = runtime.edit();
      try {
        expect(canRenderCellUnderPolicy(
          cellReading(tx, () => undefined),
          rootRenderPolicy,
        )).toBe(true);
        expect(canRenderCellUnderPolicy(
          cellReading(tx, () => {
            throw new Error("metadata read failed");
          }),
          rootRenderPolicy,
        )).toBe(false);
      } finally {
        tx.abort();
      }
    });

    await t.step(
      "withholds props linked from a document the ceiling refuses",
      async () => {
        // A binding in the refused document names an admitted cell; which
        // cell it names is the refused document's choice.
        const secretProps = await write(
          "prop-ceiling-secret-props",
          { title: SECRET, class: "secret-class", $value: link(plain) },
          [secretAtom],
        );
        const plainProps = await write("prop-ceiling-plain-props", {
          title: PUBLIC,
          $value: link(plain),
        });
        const view = (id: string, props: Cell<string>) =>
          stored(id, {
            type: "vnode",
            name: "cf-input",
            props: link(props),
            children: [],
          });
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [
            await view("prop-ceiling-secret-props-view", secretProps) as never,
            await view("prop-ceiling-plain-props-view", plainProps) as never,
          ],
        }, HOST_CEILING);
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.emitted()).not.toContain("secret-class");
          expect(page.propsSet("title")).toEqual([PUBLIC]);
          expect(page.bindings("value")).toBe(1);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a view reached through a refused link",
      async () => {
        const secretView = await write("prop-ceiling-secret-view", {
          type: "vnode",
          name: "span",
          props: { title: SECRET, style: "color: red" },
          children: [],
        }, [secretAtom]);
        const plainView = await write("prop-ceiling-plain-view", {
          type: "vnode",
          name: "span",
          props: { title: PUBLIC, style: "color: red" },
          children: [],
        });
        const root = await stored("prop-ceiling-view-links", {
          type: "vnode",
          name: "div",
          props: {},
          children: [
            { [UI]: link(secretView) },
            { [UI]: link(plainView) },
          ],
        });
        const page = await mount(root, HOST_CEILING);
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.placeholders()).toBe(1);
          expect(page.propsSet("title")).toContain(PUBLIC);
          expect(page.propsSet("style")).toEqual(["color: red"]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withholds a value named by a reference read from a refused document",
      async () => {
        // A link that declares only a reference, as the map builtin hands a
        // list element to its callback: reading through it yields a
        // reference, and the renderer reads the scalar that names.
        const referenceTo = (
          cell: Cell<unknown>,
          schema: { type: "unknown" | "string" },
          overwrite?: "redirect",
        ) => {
          const address = cell.getAsNormalizedFullLink();
          return linkRefFrom<CellLinkRefPayload>({
            id: address.id,
            space: address.space,
            scope: address.scope,
            path: [...address.path],
            schema,
            ...(overwrite !== undefined && { overwrite }),
          });
        };
        const record = await write("prop-ceiling-reference-record", {
          key: PUBLIC,
        });
        const choose = (id: string, labels?: readonly CfcAtom[]) =>
          write(`${id}-argument`, {
            element: referenceTo(record, { type: "unknown" }),
          }, labels);
        const view = async (
          id: string,
          prop: string,
          labels?: readonly CfcAtom[],
        ) => {
          await choose(id, labels);
          const argument = runtime.getCell(signer.did(), `${id}-argument`);
          return stored(`${id}-view`, {
            type: "vnode",
            name: "span",
            props: {
              [prop]: referenceTo(
                argument.key("element").key("key"),
                { type: "string" },
                "redirect",
              ),
            },
            children: [],
          });
        };
        const page = await mount({
          type: "vnode",
          name: "div",
          props: {},
          children: [
            await view("prop-ceiling-reference-secret", "data-chosen", [
              secretAtom,
            ]) as never,
            await view("prop-ceiling-reference-plain", "data-public") as never,
            await view(
              "prop-ceiling-reference-relabeled",
              "data-relabeled",
            ) as never,
          ],
        }, HOST_CEILING);
        try {
          expect(page.propsSet("data-chosen")).toEqual([]);
          expect(page.propsSet("data-public")).toEqual([PUBLIC]);
          expect(page.propsSet("data-relabeled")).toEqual([PUBLIC]);

          // The choice is relabeled refused and still names the same record.
          await choose("prop-ceiling-reference-relabeled", [secretAtom]);
          await t.settle();
          expect(page.removed("data-relabeled")).toBe(1);
          expect(page.removed("data-public")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "withdraws a binding moved to a refused cell and restores it when moved back",
      async () => {
        const other = await write("prop-ceiling-other-plain", "another value");
        const view = runtime.getCell(signer.did(), "prop-ceiling-moving-view");
        const point = async (target: Cell<string>) => {
          const tx = runtime.edit();
          view.withTx(tx).setRawUntyped({
            type: "vnode",
            name: "cf-input",
            props: { $value: link(target) },
            children: [],
          } as never);
          expect((await tx.commit().settled).ok).toBeDefined();
          await t.settle();
        };
        await point(plain);
        const page = await mount(
          view.asSchema(rendererVDOMSchema),
          HOST_CEILING,
        );
        try {
          expect(page.bindings("value")).toBe(1);
          await point(secret);
          expect(page.removed("value")).toBe(1);
          expect(page.bindings("value")).toBe(1);
          await point(other);
          expect(page.bindings("value")).toBe(2);
          expect(page.removed("value")).toBe(1);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "applies a render boundary's ceiling to its descendants' properties",
      async () => {
        const page = await mount({
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: { maxConfidentiality: [] },
          children: [{
            type: "vnode",
            name: "cf-input",
            props: { title: secret as never, $value: secret as never },
            children: [],
          }],
        });
        try {
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.propsSet("title")).toEqual([]);
          expect(page.bindings("value")).toBe(0);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "follows a bound or displayed cell as its label changes",
      async () => {
        const id = "prop-ceiling-changing";
        const changing = await write(id, "first public value");
        const page = await mount({
          type: "vnode",
          name: "cf-input",
          props: { title: changing as never, $value: changing as never },
          children: [],
        }, HOST_CEILING);
        try {
          expect(page.bindings("value")).toBe(1);
          expect(page.propsSet("title")).toEqual(["first public value"]);

          // Admitted to admitted: the binding already in place stands.
          await write(id, "second public value");
          await t.settle();
          expect(page.bindings("value")).toBe(1);
          expect(page.propsSet("title")).toContain("second public value");

          await write(id, SECRET, [secretAtom]);
          await t.settle();
          expect(page.emitted()).not.toContain(SECRET);
          expect(page.removed("value")).toBe(1);
          expect(page.removed("title")).toBe(1);

          await write(id, "public again");
          await t.settle();
          expect(page.bindings("value")).toBe(2);
          expect(page.propsSet("title")).toContain("public again");
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "follows the membership that admits a Space(X) property, binding and child",
      async () => {
        const teamSpace = "did:key:z6MkPropCeilingTeamSpace";
        const team = await write("prop-ceiling-team", "team value", [
          cfcAtom.space(teamSpace),
        ]);
        // A text child whose path crosses a link to a document labeled for
        // the team.
        const teamRow = await write("prop-ceiling-team-row", {
          name: "team row",
        }, [cfcAtom.space(teamSpace)]);
        await write("prop-ceiling-team-table", { row: link(teamRow) }, [
          cfcAtom.user(signer.did()),
        ]);
        const crossing = runtime.getCell(
          signer.did(),
          "prop-ceiling-team-table",
        )
          .key("row").key("name");
        let granted = false;
        const listeners = new Set<() => void>();
        const membershipProvider: SpaceMembershipProvider = {
          readerRole: (space) =>
            granted && space === teamSpace ? "reader" : null,
          subscribe: (_space, onChange) => {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
          },
        };
        const input = await stored("prop-ceiling-team-cell-props", {
          type: "vnode",
          name: "cf-input",
          props: { placeholder: link(team), $value: link(team) },
          children: [],
        });
        const page = await mount({
          type: "vnode",
          name: "div",
          props: { title: team as never },
          children: [input as never, crossing as never],
        }, {
          renderConfidentialityCeiling: {
            atoms: [cfcAtom.user(signer.did())],
          },
          resolveRenderConfidentiality: createRenderConfidentialityResolver({
            actingPrincipal: signer.did(),
            membershipProvider,
          }),
          membershipProvider,
        });
        try {
          expect(page.emitted()).not.toContain("team value");
          expect(page.emitted()).not.toContain("team row");
          expect(page.bindings("value")).toBe(0);
          expect(page.placeholders()).toBe(1);

          const membershipChanges = async () => {
            for (const onChange of [...listeners]) onChange();
            await t.settle();
          };
          const shownTitles = () =>
            page.propsSet("title").filter((title) => title === "team value");

          granted = true;
          await membershipChanges();
          expect(shownTitles()).toHaveLength(1);
          expect(page.propsSet("placeholder")).toEqual(["team value"]);
          expect(page.bindings("value")).toBe(1);
          expect(page.texts()).toContain("team row");
          const shownRows = page.texts().length;

          // A change that leaves the decision standing emits nothing.
          await membershipChanges();
          await membershipChanges();
          expect(page.texts()).toHaveLength(shownRows);
          expect(shownTitles()).toHaveLength(1);
          expect(page.propsSet("placeholder")).toHaveLength(1);
          expect(page.bindings("value")).toBe(1);

          granted = false;
          await membershipChanges();
          await membershipChanges();
          expect(page.removed("title")).toBe(1);
          expect(page.removed("placeholder")).toBe(1);
          expect(page.removed("value")).toBe(1);
          expect(page.placeholders()).toBe(2);
        } finally {
          page.cancel();
        }
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
