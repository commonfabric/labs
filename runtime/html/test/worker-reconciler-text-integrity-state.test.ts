/**
 * What an authorship boundary that verifies text integrity says about the text
 * it holds: which text it hides, the state it reports on itself as that text
 * changes, and what a denial says about the label it read. Each text below
 * appears nowhere else, so a search of the emitted text for it is a search for
 * it having been shown.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { addCfcDenialListener, type CfcDenial } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import type {
  SpaceAccessProvider,
  WorkerProps,
  WorkerRenderNode,
  WorkerVNode,
} from "../src/worker/types.ts";
import { type RootLabel, writeLabeledCell } from "./labeled-cell.ts";
import { mountTree } from "./mounted-tree.ts";
import { valueCell } from "./value-cell.ts";

const ENDORSED = "integrity-state endorsed note";
const UNENDORSED = "integrity-state unendorsed note";
const PLACEHOLDER = "Content hidden by integrity policy";

const signer = await Identity.fromPassphrase(
  "worker reconciler text integrity state",
);
const space = signer.did();
const endorsed = { kind: "signed-release", subject: "integrity-state" };
const otherEndorsement = { kind: "signed-release", subject: "elsewhere" };

describe("worker reconciler text integrity state", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let endorsedText: Cell<string>;
  let unendorsedText: Cell<string>;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost"),
    });
    endorsedText = await write("integrity-state-endorsed", ENDORSED, {
      integrity: [endorsed],
    });
    unendorsedText = await write("integrity-state-unendorsed", UNENDORSED);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Writes `value` to the cell named `id`, labeled `label` when given. */
  const write = <T>(id: string, value: T, label?: RootLabel) =>
    writeLabeledCell(runtime, space, id, value, label);

  /** Mounts `tree`, and reads back what it emitted and said. */
  const mount = async (
    tree: WorkerVNode | Cell<unknown>,
    spaceAccess?: SpaceAccessProvider,
  ) => {
    const denials: CfcDenial[] = [];
    const stopListening = addCfcDenialListener((denial) => {
      denials.push(denial);
    });
    const page = await mountTree(tree, { spaceAccess });
    return {
      ...page,
      denials,
      /** The integrity states reported for the element `nodeId`. */
      statesOf: (nodeId: number) =>
        page.ops.flatMap((op) =>
          op.op === "set-prop" && op.nodeId === nodeId &&
            op.key === "textIntegrityState"
            ? [op.value]
            : []
        ),
      /** The node of the first element created with `tagName`. */
      nodeOf: (tagName: string) => {
        const op = page.ops.find((op) =>
          op.op === "create-element" && op.tagName === tagName
        );
        if (op?.op !== "create-element") {
          throw new Error(`no ${tagName} was created`);
        }
        return op.nodeId;
      },
      cancel: () => {
        stopListening();
        page.cancel();
      },
    };
  };

  const authorship = (
    props: WorkerProps,
    children: WorkerRenderNode[],
  ): WorkerVNode => ({
    type: "vnode",
    name: "cf-cfc-authorship",
    props,
    children,
  });
  const verifying = (
    children: WorkerRenderNode[],
    allowLiteralText = true,
  ) =>
    authorship({
      verifyTextIntegrity: true,
      allowLiteralText,
      requiredTextIntegrity: endorsed,
    }, children);
  const chatMessage = (content: Cell<unknown>): WorkerVNode => ({
    type: "vnode",
    name: "cf-chat-message",
    props: { content },
    children: [],
  });

  it(
    "shows a cell holding no text, and hides one holding unendorsed text",
    async () => {
      for (
        const [value, texts] of [
          ["", [""]],
          [null, []],
          [UNENDORSED, [PLACEHOLDER]],
        ] as const
      ) {
        const page = await mount(verifying([
          await write(`integrity-state-holding-${value}`, value),
        ], false));
        expect(page.texts()).toEqual(texts);
        page.cancel();
      }
    },
  );

  it(
    "reports the stored integrity of text it hides",
    async () => {
      const otherwiseEndorsed = await write(
        "integrity-state-other",
        UNENDORSED,
        { integrity: [otherEndorsement] },
      );
      const page = await mount(verifying([otherwiseEndorsed]));
      expect(page.texts()).toEqual([PLACEHOLDER]);
      expect(page.denials.map(({ code, inputs }) => ({
        code,
        labelSource: inputs.labelSource,
        integrity: inputs.integrity,
      }))).toEqual([{
        code: "render-text-integrity",
        labelSource: "stored",
        integrity: [otherEndorsement],
      }]);
      page.cancel();
    },
  );

  it(
    "reports a label it cannot resolve as unreadable",
    async () => {
      const unresolvable = patchableCell(
        await write("integrity-state-unresolvable", UNENDORSED),
      );
      unresolvable.resolveAsCell = () => {
        throw new Error("link cannot be followed");
      };
      const page = await mount(verifying([unresolvable]));
      expect(page.texts()).toEqual([PLACEHOLDER]);
      expect(
        page.denials.map(({ inputs }) => inputs.labelSource),
      ).toEqual(["unreadable"]);
      page.cancel();
    },
  );

  it(
    "reports no state for a non-verifying authorship element inside a verifying one",
    async () => {
      // An authorship element that does not verify reports no state of its
      // own; the verifying boundary around it reports for what it holds.

      for (const innerVerifies of [false, true]) {
        const inner = (text: string) =>
          authorship(
            innerVerifies
              ? {
                verifyTextIntegrity: true,
                allowLiteralText: true,
                requiredTextIntegrity: endorsed,
              }
              : {},
            [text],
          );
        const content = valueCell(runtime, space, inner("one"));
        const page = await mount(verifying([content.cell]));
        const outerNode = page.nodeOf("cf-cfc-authorship");
        const innerNode = outerNode + 1;
        content.set(inner("two"));
        await clock.settle();
        expect(page.texts()).toContain("two");
        expect(page.statesOf(outerNode)).toEqual(["ok"]);
        expect(page.statesOf(innerNode)).toEqual(
          innerVerifies ? ["ok", "ok"] : [],
        );
        page.cancel();
      }
    },
  );

  it(
    "keeps reporting blocked while a prop it holds back stays",
    async () => {
      for (
        const [content, state] of [
          [unendorsedText, "blocked"],
          [endorsedText, "ok"],
        ] as const
      ) {
        const root = valueCell(
          runtime,
          space,
          verifying([chatMessage(content), "one"]),
        );
        const page = await mount(root.cell);
        const node = page.nodeOf("cf-cfc-authorship");
        root.set(verifying([chatMessage(content), "two"]));
        await clock.settle();
        expect(page.texts()).toContain("two");
        expect(page.statesOf(node).at(-1)).toBe(state);
        page.cancel();
      }
    },
  );

  it(
    "reports ok once a reused boundary no longer holds the text it hid",
    async () => {
      // A child keys by a hash of what it holds. The hash refuses a `Map`, so a
      // boundary carrying one keys by its tag alone and is reused when what it
      // holds changes.

      const boundary = (children: string[]) => ({
        ...verifying(children, false),
        hash: new Map(),
      });
      const root = valueCell(runtime, space, {
        type: "vnode",
        name: "div",
        props: {},
        children: [boundary(["literal"])],
      });
      const page = await mount(root.cell);
      const node = page.nodeOf("cf-cfc-authorship");
      expect(page.statesOf(node).at(-1)).toBe("blocked");

      root.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [boundary([])],
      });
      await clock.settle();
      expect(page.nodeOf("cf-cfc-authorship")).toBe(node);
      expect(page.statesOf(node).at(-1)).toBe("ok");
      page.cancel();
    },
  );

  it(
    "leaves hidden text standing when its value is delivered again",
    async () => {
      // A space-access change re-delivers the value a cell child last read.
      // A child still hidden for its integrity stays as it stands; one whose
      // space is now refused is replaced by the access placeholder.

      const changes: (() => void)[] = [];
      const access: { refused?: Error } = {};
      const page = await mount(verifying([unendorsedText]), {
        error: () => access.refused,
        subscribe: (_space, onChange) => {
          changes.push(onChange);
          return () => {};
        },
      });
      expect(page.texts()).toEqual([PLACEHOLDER]);
      expect(changes.length).toBeGreaterThan(0);
      const before = page.ops.length;

      for (const change of changes) change();
      await clock.settle();
      expect(page.ops.length).toBe(before);

      access.refused = new Error("access lost");
      for (const change of changes) change();
      await clock.settle();
      expect(page.ops.slice(before)).toContainEqual(
        expect.objectContaining({ op: "remove-node" }),
      );
      page.cancel();
    },
  );
});
