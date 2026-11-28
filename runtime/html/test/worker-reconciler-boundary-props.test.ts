/**
 * What a render boundary and an authorship boundary make of the props an
 * author gives them: the spellings a policy prop goes by, the forms its value
 * may take, and a value it cannot use. Each text below appears nowhere else,
 * so a search of the emitted text for it is a search for it having been
 * shown.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type {
  WorkerProps,
  WorkerRenderNode,
  WorkerVNode,
} from "../src/worker/types.ts";
import { type RootLabel, writeLabeledCell } from "./labeled-cell.ts";
import { mountTree } from "./mounted-tree.ts";
import { unfollowable, withSlots } from "./patched-slots.ts";

const SECRET = "boundary-props secret diagnosis";
const LITERAL = "boundary-props literal summary";
const UNENDORSED = "boundary-props unendorsed note";
const POLICY_PLACEHOLDER = "Content hidden by policy";
const INTEGRITY_PLACEHOLDER = "Content hidden by integrity policy";

const signer = await Identity.fromPassphrase(
  "worker reconciler boundary props",
);
const healthAtom = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "BoundaryPropsHealthRecord",
  subject: signer.did(),
};
const otherAtom = { ...healthAtom, class: "BoundaryPropsOtherRecord" };
const endorsed = { kind: "signed-release", subject: "boundary-props" };

describe("worker reconciler boundary policy props", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let secret: Cell<string>;
  let unendorsedText: Cell<string>;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost"),
    });
    secret = await write("boundary-props-secret", SECRET, {
      confidentiality: [healthAtom],
    });
    unendorsedText = await write("boundary-props-unendorsed", UNENDORSED);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Writes `value` to the cell named `id`, labeled `label` when given. */
  const write = <T>(id: string, value: T, label?: RootLabel) =>
    writeLabeledCell(runtime, signer.did(), id, value, label);

  /** Mounts `tree`, settles, unmounts it, and returns what it emitted. */
  const mounted = async (tree: WorkerVNode) => {
    const page = await mountTree(tree);
    page.cancel();
    return page;
  };
  /** Mounts `tree`, settles, and returns the text it showed. */
  const shownText = async (tree: WorkerVNode) => (await mounted(tree)).texts();

  const renderBoundary = (
    props: WorkerProps | Cell<unknown>,
    children: WorkerRenderNode[],
  ): WorkerVNode => ({
    type: "vnode",
    name: "cf-cfc-render-boundary",
    props: props as WorkerVNode["props"],
    children,
  });

  const authorship = (
    props: WorkerProps | Cell<unknown>,
    children: WorkerRenderNode[],
  ): WorkerVNode => ({
    type: "vnode",
    name: "cf-cfc-authorship",
    props: props as WorkerVNode["props"],
    children,
  });

  it(
    "bounds by a single atom given for maxConfidentiality as by a list of it",
    async () => {
      expect(
        await shownText(
          renderBoundary({ maxConfidentiality: healthAtom }, [secret]),
        ),
      ).toEqual([SECRET]);
      expect(
        await shownText(
          renderBoundary({ maxConfidentiality: otherAtom }, [secret]),
        ),
      ).toEqual([POLICY_PLACEHOLDER]);
    },
  );

  for (
    const [form, bound] of [
      ["a cell", () => unendorsedText],
      ["undefined", () => undefined],
    ] as const
  ) {
    it(
      `defers to data-cfc-max-confidentiality when maxConfidentiality is ${form}`,
      async () => {
        // A bound the boundary cannot read when it renders is no bound, and
        // the data attribute spelling decides instead.

        const value = bound();
        expect(
          await shownText(renderBoundary({
            maxConfidentiality: value,
            "data-cfc-max-confidentiality": [],
          }, [secret])),
        ).toEqual([POLICY_PLACEHOLDER]);
        expect(
          await shownText(renderBoundary({
            maxConfidentiality: value,
            "data-cfc-max-confidentiality": [healthAtom],
          }, [secret])),
        ).toEqual([SECRET]);
      },
    );
  }

  it(
    "decides on the stored switch when resolving a props cell's slot fails",
    async () => {
      // Props arriving as a cell are each read through the link stored in
      // the slot, when there is one. When following the slot fails, the
      // boundary decides on the value the slot stores.

      const unresolvable = async (id: string, verify: boolean) => {
        const props = withSlots(
          await write(id, {
            verifyTextIntegrity: verify,
            requiredTextIntegrity: endorsed,
          }),
          (_name, original) => unfollowable(original()),
        );
        return props;
      };
      expect(
        await shownText(
          authorship(
            await unresolvable("boundary-props-verify", true),
            [unendorsedText],
          ),
        ),
      ).toEqual([INTEGRITY_PLACEHOLDER]);
      expect(
        await shownText(
          authorship(
            await unresolvable("boundary-props-no-verify", false),
            [unendorsedText],
          ),
        ),
      ).toEqual([UNENDORSED]);
    },
  );

  it(
    "holds back nothing for a $value it cannot follow, and still gates its cell children",
    async () => {
      // The value a render boundary protects arrives through its props
      // cell's `$value` slot. When that slot cannot be followed, the
      // boundary holds nothing back on the value's account, and neither is
      // the slot bound to the element; a cell among its children is still
      // decided on its own label.

      const boundaryProps = async (id: string, followable: boolean) => {
        const props = await write(id, {
          maxConfidentiality: [],
          $value: secret.getAsLink({ includeSchema: true }),
        });
        return followable ? props : withSlots(props, (name, original) => {
          if (name === "$value") throw new Error("slot cannot be read");
          return original();
        });
      };
      const children = [LITERAL, secret];
      const followed = await mounted(
        renderBoundary(
          await boundaryProps("boundary-props-followed", true),
          children,
        ),
      );
      expect(followed.texts()).toEqual([POLICY_PLACEHOLDER]);

      const unfollowed = await mounted(
        renderBoundary(
          await boundaryProps("boundary-props-unfollowed", false),
          children,
        ),
      );
      expect(unfollowed.texts()).toEqual([LITERAL, POLICY_PLACEHOLDER]);
      expect(unfollowed.ops.some((op) => op.op === "set-binding")).toBe(false);
    },
  );
});
