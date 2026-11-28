/**
 * What the worker reconciler does with a cell it cannot fully read: one whose
 * link cannot be followed, whose metadata or raw value cannot be read, or a
 * props cell one of whose slots cannot be followed. Each case is set beside
 * the same render with nothing failing, so what the failure changes is what
 * the assertions name.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import type {
  WorkerProps,
  WorkerRenderNode,
  WorkerVNode,
} from "../src/worker/types.ts";
import { type RootLabel, writeLabeledCell } from "./labeled-cell.ts";
import { mountTree } from "./mounted-tree.ts";
import { unfollowable, withSlots } from "./patched-slots.ts";
import { valueCell } from "./value-cell.ts";

const ENDORSED = "unresolvable endorsed note";
const UNENDORSED = "unresolvable unendorsed note";
const PLACEHOLDER = "Content hidden by integrity policy";

const signer = await Identity.fromPassphrase(
  "worker reconciler unresolvable cells",
);
const endorsed = { kind: "signed-release", subject: "unresolvable" };

describe("worker reconciler cells it cannot fully read", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let unendorsedText: Cell<string>;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost"),
    });
    unendorsedText = await write("unresolvable-unendorsed", UNENDORSED);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Writes `value` to the cell named `id`, labeled `label` when given. */
  const write = <T>(id: string, value: T, label?: RootLabel) =>
    writeLabeledCell(runtime, signer.did(), id, value, label);

  /** Mounts `tree`, settles, unmounts it, and returns what it emitted. */
  const mounted = async (tree: WorkerVNode | Cell<unknown>) => {
    const page = await mountTree(tree);
    page.cancel();
    return page;
  };

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  const element = (
    name: string,
    props: WorkerProps | Cell<unknown>,
    children: WorkerRenderNode[] = [],
  ): WorkerVNode => ({
    type: "vnode",
    name,
    props: props as WorkerVNode["props"],
    children,
  });

  /** `cell`, whose slot `key` can be read but not followed. */
  const withUnresolvableSlot = (cell: Cell<unknown>, key: string) =>
    withSlots(
      cell,
      (name, original) => name === key ? unfollowable(original()) : original(),
    );

  /** `cell`, whose slot `key` cannot be read at all. */
  const withUnreadableSlot = (cell: Cell<unknown>, key: string) =>
    withSlots(cell, (name, original) => {
      if (name === key) throw new Error("slot cannot be read");
      return original();
    });

  const verifying = (
    children: WorkerRenderNode[],
    allowLiteralText = true,
  ) =>
    element("cf-cfc-authorship", {
      verifyTextIntegrity: true,
      allowLiteralText,
      requiredTextIntegrity: endorsed,
    }, children);

  it(
    "marks a pattern's output as a piece only while its identity can be read",
    async () => {
      const output = await write("unresolvable-output", {
        $UI: element("span", {}, ["piece"]),
      });
      for (const readable of [true, false]) {
        const child = patchableCell(output);
        const result = patchableCell(output);
        result.getMetaRaw = (field) => {
          if (!readable) throw new Error("metadata cannot be read");
          return field === "patternIdentity"
            ? { identity: "unresolvable-pattern", symbol: "default" }
            : undefined;
        };
        child.resolveAsCell = () => result;
        const page = await mounted(
          valueCell(runtime, signer.did(), {
            type: "vnode",
            name: "div",
            props: {},
            children: [child],
          }).cell,
        );
        expect(page.texts()).toEqual(["piece"]);
        expect(page.ops.some((op) => op.op === "set-piece-boundary")).toBe(
          readable,
        );
      }
    },
  );

  it(
    "binds a cell whose link cannot be followed, carrying no label for it",
    async () => {
      const labeled = await write("unresolvable-bound", ENDORSED, {
        integrity: [endorsed],
      });
      const unfollowable = patchableCell(
        await write("unresolvable-unfollowable", ENDORSED),
      );
      unfollowable.resolveAsCell = () => {
        throw new Error("link cannot be followed");
      };
      const [labeledRef] = (await mounted(
        element("div", { $value: labeled }),
      )).bindings();
      expect(labeledRef.cfcLabelView).toBeDefined();
      const [unfollowedRef] = (await mounted(
        element("div", { $value: unfollowable }),
      )).bindings();
      expect(unfollowedRef.id).toBe(
        unfollowable.getAsNormalizedFullLink().id,
      );
      expect(unfollowedRef.cfcLabelView).toBeUndefined();
    },
  );

  it(
    "reads an authorship switch cell through its schema when its raw read fails",
    async () => {
      // An authorship switch given as a cell is read raw, and read through its
      // schema when the raw read fails. When neither can be read the boundary
      // does not verify, as when the switch is absent.

      const switchCell = async (id: string, readable: boolean) => {
        const cell = patchableCell(await write(id, true));
        cell.getRawUntyped = () => {
          throw new Error("raw value cannot be read");
        };
        if (!readable) {
          cell.get = () => {
            throw new Error("value cannot be read");
          };
        }
        return cell;
      };
      const boundary = (verify: Cell<unknown>) =>
        element("cf-cfc-authorship", {
          verifyTextIntegrity: verify,
          requiredTextIntegrity: endorsed,
          allowLiteralText: true,
        }, [unendorsedText]);
      expect(
        (await mounted(
          boundary(await switchCell("unresolvable-switch", true)),
        )).texts(),
      ).toEqual([PLACEHOLDER]);
      expect(
        (await mounted(
          boundary(await switchCell("unresolvable-switch-unread", false)),
        )).texts(),
      ).toEqual([UNENDORSED]);
    },
  );

  it(
    "sets no handler for an event prop whose target cannot be followed",
    async () => {
      const target = runtime.getCell<unknown>(
        signer.did(),
        "unresolvable-event-target",
        { asCell: ["stream"] },
      );
      const props = await write("unresolvable-event-props", {
        onClick: link(target),
        title: "clickable",
      });
      const followed = await mounted(element("button", props));
      expect(followed.ops.some((op) => op.op === "set-event")).toBe(true);
      const unfollowed = await mounted(
        element("button", withUnresolvableSlot(props, "onClick")),
      );
      expect(unfollowed.ops.some((op) => op.op === "set-event")).toBe(false);
      expect(unfollowed.propsSet("title")).toEqual(["clickable"]);
    },
  );

  it(
    "decides text in a props slot it cannot resolve on the slot",
    async () => {
      // A chat message's content arriving through a props cell is decided on
      // the cell it resolves to. When the slot cannot be resolved, it is
      // decided on the slot itself, and when the slot cannot be read either,
      // as literal text.

      const message = async (
        id: string,
        label: RootLabel | undefined,
        patch: (props: Cell<unknown>) => Cell<unknown>,
        allowLiteralText = true,
      ) =>
        (await mounted(verifying([
          element(
            "cf-chat-message",
            patch(await write(id, { content: UNENDORSED }, label)),
          ),
        ], allowLiteralText))).propsSet("content");

      const unresolvable = (props: Cell<unknown>) =>
        withUnresolvableSlot(props, "content");
      expect(await message("unresolvable-content", undefined, unresolvable))
        .toEqual([PLACEHOLDER]);
      expect(
        await message(
          "unresolvable-content-endorsed",
          { integrity: [endorsed] },
          unresolvable,
        ),
      ).toEqual([UNENDORSED]);

      const unreadable = (props: Cell<unknown>) =>
        withUnreadableSlot(props, "content");
      expect(await message("unreadable-content", undefined, unreadable))
        .toEqual([UNENDORSED]);
      expect(
        await message(
          "unreadable-content-literal",
          undefined,
          unreadable,
          false,
        ),
      ).toEqual([PLACEHOLDER]);
    },
  );

  it(
    "binds the cell a props slot links to when the props cannot be read raw",
    async () => {
      // A binding in a props cell names the cell its slot links to. The link is
      // read from the props cell's raw value, and from the slot's own when that
      // fails.

      const target = await write("unresolvable-binding-target", ENDORSED);
      const props = (id: string) =>
        write(id, { $value: link(target) }).then(patchableCell);

      const unreadableProps = await props("unresolvable-binding-props");
      unreadableProps.getRawUntyped = () => {
        throw new Error("props cannot be read raw");
      };
      const [viaSlot] = (await mounted(element("div", unreadableProps)))
        .bindings();
      expect(viaSlot.id).toBe(target.getAsNormalizedFullLink().id);

      const unreadable = withSlots(
        await write("unresolvable-binding-unread", {
          $value: link(target),
        }),
        (_name, original) => {
          const slot = patchableCell(original());
          slot.asSchema = () => {
            const typed = patchableCell(slot);
            typed.getRawUntyped = () => {
              throw new Error("slot cannot be read raw");
            };
            return typed;
          };
          return slot;
        },
      );
      unreadable.getRawUntyped = () => {
        throw new Error("props cannot be read raw");
      };
      const [resolved] = (await mounted(element("div", unreadable)))
        .bindings();
      expect(resolved.id).toBe(target.getAsNormalizedFullLink().id);
    },
  );
});
