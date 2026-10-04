/**
 * What `formatTree()` does with a `FabricSpecialObject`. Such a value keeps
 * its state in private fields and has zero enumerable own properties, so
 * `JSON.stringify()` renders one as `{}` -- silently, since it does not throw
 * on one and the `catch` around it never fires. Both arms are named instead.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  $conn,
  CellHandle,
  CellReadRefusedError,
  type CellRef,
  type RuntimeClient,
  type VNode,
} from "@commonfabric/runtime-client";

import { createVDomDebugHelpers, formatTree } from "../src/debug.ts";
import { MockDoc } from "../src/mock-doc.ts";
import { render } from "../src/render.ts";

describe("debug", () => {
  describe("formatTree", () => {
    it("names a `FabricBytes` standing where a node would", () => {
      expect(formatTree(new FabricBytes(new Uint8Array([1, 2, 3]))))
        .toBe("/Bytes(buf[010203])");
    });

    it("names a `FabricError`, the `FabricInstance` arm", () => {
      // A debug renderer names an instance rather than refusing it: the value
      // it was handed is the very thing being debugged. The error is built
      // without a stack, since a real one names this file and a line in it.
      const error = new FabricError({
        type: "Error",
        message: "boom",
        stack: undefined,
        cause: undefined,
      });
      expect(formatTree(error))
        .toBe('/Error(type:"Error",name:null,message:"boom")');
    });

    it("indents a named special object like any other node", () => {
      expect(formatTree(new FabricBytes(new Uint8Array([1])), 2))
        .toBe("    /Bytes(buf[01])");
    });

    it("names a special object held as a render prop", () => {
      const node = {
        name: "div",
        props: { when: new FabricEpochNsec(1_000n) },
      };

      expect(formatTree(node)).toContain("when=/EpochNsec(1000n)");
    });
  });
});

describe("vdom debug helpers", () => {
  // A devtools read of a view the worker refuses rejects with the refusal: a
  // refused tree is not an empty one.
  const ref: CellRef = {
    id: "of:refused-view",
    space: "did:key:debug",
    scope: "space",
    path: [],
  };
  const refusal = { refusedBy: "display-ceiling" } as const;

  /**
   * Renders `view` over a connection already disposed, so the renderer mounts
   * nothing and the helpers read the view's cell themselves. `RuntimeClient`
   * is a class with private state no plain object satisfies, and a mock
   * document's element stands in for the page's, as in the renderer's tests.
   */
  const rendered = (view: (runtime: RuntimeClient) => CellHandle<VNode>) => {
    const connection = {
      signal: AbortSignal.abort(),
      onDispose: () => () => {},
      attachVDom: (teardown: () => void) => {
        teardown();
        return { onBatch: () => {}, detach: () => {} };
      },
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    };
    const runtime = { [$conn]: () => connection } as unknown as RuntimeClient;
    const mock = new MockDoc(
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    const container = mock.document.getElementById("root")!;
    const element = container as unknown as HTMLElement;
    const cancel = render(element, view(runtime), { document: mock.document });
    return { element, cancel };
  };

  it("`tree()` hands back the tree an admitted read holds", async () => {
    const tree: VNode = {
      type: "vnode",
      name: "div",
      props: {},
      children: [],
    };
    const { element, cancel } = rendered((runtime) =>
      new CellHandle<VNode>(runtime, ref, { value: tree })
    );
    try {
      await expect(createVDomDebugHelpers().tree(element)).resolves.toEqual(
        tree,
      );
    } finally {
      cancel();
    }
  });

  for (const helper of ["tree", "dump"] as const) {
    it(`\`${helper}()\` rejects a view the worker refuses`, async () => {
      const { element, cancel } = rendered((runtime) =>
        new CellHandle<VNode>(runtime, ref, { refused: refusal })
      );
      try {
        await expect(createVDomDebugHelpers()[helper](element)).rejects
          .toThrow(CellReadRefusedError);
      } finally {
        cancel();
      }
    });
  }
});
