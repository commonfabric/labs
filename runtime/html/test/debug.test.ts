/**
 * What `formatTree()` does with a `FabricSpecialObject`. Such a value keeps
 * its state in private fields and has zero enumerable own properties, so
 * `JSON.stringify()` renders one as `{}` -- silently, since it does not throw
 * on one and the `catch` around it never fires. Both arms are named instead.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

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

    it("renders primitives at the given indent", () => {
      expect(formatTree(null, 1)).toBe("  (null)");
      expect(formatTree(undefined)).toBe("(null)");
      expect(formatTree("hi", 1)).toBe('  "hi"');
      expect(formatTree(3)).toBe("3");
      expect(formatTree(false)).toBe("false");
      expect(formatTree(5n)).toBe("5");
    });

    it("renders each entry of an array on its own line at the same indent", () => {
      expect(formatTree(["a", 1], 1)).toBe('  "a"\n  1');
    });

    it("follows `$UI` to the node it names", () => {
      expect(formatTree({ $UI: { name: "span" } })).toBe("<span />");
    });

    it("renders an object that is not a node compactly", () => {
      expect(formatTree({ a: 1 }, 1)).toBe("  {a:1}");
      expect(formatTree({ $UI: null, b: 2 })).toBe("{$UI:null,b:2}");
    });

    it("renders a node without props or children as a self-closing tag", () => {
      expect(formatTree({ name: "br", props: {}, children: [] })).toBe(
        "<br />",
      );
    });

    it("renders a cell-handle prop as `<cell>`, and other props compactly", () => {
      const runtime = { [$conn]: () => ({}) } as unknown as RuntimeClient;
      const cell = new CellHandle(runtime, {
        id: "of:prop",
        space: "did:key:debug",
        scope: "space",
        path: [],
      });

      expect(formatTree({ name: "input", props: { value: cell, n: 1 } }))
        .toBe("<input value=<cell> n=1 />");
    });

    it("nests children one level deeper than their parent", () => {
      expect(
        formatTree({
          name: "ul",
          props: { id: "list" },
          children: [{ name: "li", children: ["one"] }],
        }),
      ).toBe(
        '<ul id="list">\n  <li>\n    "one"\n  </li>\n</ul>',
      );
    });

    it("renders a single child that is not an array", () => {
      expect(formatTree({ name: "p", children: "text" })).toBe(
        '<p>\n  "text"\n</p>',
      );
    });
  });
});

describe("vdom debug helpers", () => {
  const ref = (id: `of:${string}`): CellRef => ({
    id,
    space: "did:key:debug",
    scope: "space",
    path: [],
  });
  const tree: VNode = {
    type: "vnode",
    name: "div",
    props: {},
    children: [],
  };

  /**
   * Renders the cell `id` into a fresh mock document's container, over a
   * connection whose mount reports no root and which responds to every read of
   * the view's cell with `answer`. `RuntimeClient` is a class with private
   * state no plain object satisfies, and a mock document's element stands in
   * for the page's, as in the renderer's tests.
   */
  const rendered = (
    id: `of:${string}`,
    answer: unknown = { value: tree },
  ) => {
    const lifetime = new AbortController();
    const connection = {
      signal: lifetime.signal,
      onDispose: (teardown: () => void) => {
        lifetime.signal.addEventListener("abort", teardown, { once: true });
        return () => lifetime.signal.removeEventListener("abort", teardown);
      },
      attachVDom: () => ({
        mount: () => Promise.resolve({ rootId: null }),
        unmount: () => Promise.resolve(),
        sendEvent: () => {},
        ackBatch: () => {},
        onBatch: () => {},
        offBatch: () => {},
        detach: () => {},
      }),
      request: () => Promise.resolve(answer),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      peersOf: () => [],
    };
    const runtime = { [$conn]: () => connection } as unknown as RuntimeClient;
    const mock = new MockDoc(
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    const container = mock.document.getElementById("root")!;
    const element = container as unknown as HTMLElement;
    const cancel = render(
      element,
      new CellHandle<VNode>(runtime, ref(id)),
      { document: mock.document },
    );
    return { element, cancel };
  };

  /** Runs `body` with `console[method]` stubbed, and returns the stub's calls. */
  const capture = async (
    method: "log" | "warn" | "table",
    body: () => unknown,
  ): Promise<unknown[][]> => {
    const spy = stub(console, method);
    try {
      await body();
      return spy.calls.map((call) => call.args);
    } finally {
      spy.restore();
    }
  };

  it("`tree()` hands back the tree an admitted read holds", async () => {
    const { element, cancel } = rendered("of:admitted-view");
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
      // A devtools read of a view the worker refuses rejects with the refusal:
      // a refused tree is not an empty one.

      const { element, cancel } = rendered("of:refused-view", {
        refused: { refusedBy: "display-ceiling" },
      });
      try {
        await expect(createVDomDebugHelpers()[helper](element)).rejects
          .toThrow(CellReadRefusedError);
      } finally {
        cancel();
      }
    });
  }

  describe("with no active render", () => {
    it("reports that there is nothing to list or count", async () => {
      const helpers = createVDomDebugHelpers();

      expect(helpers.registry.size).toBe(0);
      expect(await capture("log", () => helpers.renders())).toEqual([[
        "No active renders.",
      ]]);
      expect(await capture("log", () => helpers.stats())).toEqual([[
        "No active renders.",
      ]]);
    });

    it("warns and returns nothing from each lookup", async () => {
      const helpers = createVDomDebugHelpers();
      const results: unknown[] = [];

      const warnings = await capture("warn", async () => {
        results.push(await helpers.tree());
        results.push(await helpers.dump());
        results.push(helpers.nodeForId(1));
      });

      expect(results).toEqual([undefined, undefined, undefined]);
      expect(warnings).toEqual([
        ["No active render found."],
        ["No active render found."],
        ["No active render found."],
      ]);
    });
  });

  describe("with active renders", () => {
    it("lists each render with its index, container and cell", async () => {
      const first = rendered("of:first-view");
      const second = rendered("of:second-view");
      try {
        const helpers = createVDomDebugHelpers();

        expect([...helpers.registry.keys()]).toEqual([
          first.element,
          second.element,
        ]);
        expect(await capture("table", () => helpers.renders())).toEqual([[[
          { index: 0, container: first.element, cellId: "of:first-view" },
          { index: 1, container: second.element, cellId: "of:second-view" },
        ]]]);
      } finally {
        first.cancel();
        second.cancel();
      }
    });

    it("counts each render's nodes and listeners", async () => {
      const first = rendered("of:counted-view");
      const second = rendered("of:empty-view");
      try {
        const helpers = createVDomDebugHelpers();
        helpers.registry.get(first.element)!.renderer.getApplicator()
          .applyBatch({
            batchId: 1,
            rootId: 1,
            ops: [
              { op: "create-element", nodeId: 1, tagName: "button" },
              { op: "set-event", nodeId: 1, eventType: "click", handlerId: 1 },
              { op: "set-event", nodeId: 1, eventType: "focus", handlerId: 2 },
            ],
          });

        const [[rows]] = await capture("table", () => helpers.stats());

        expect(rows).toEqual([
          {
            index: 0,
            container: first.element,
            nodeCount: 2,
            listenerCount: 1,
            totalListeners: 2,
            rootNodeId: 1,
          },
          {
            index: 1,
            container: second.element,
            nodeCount: 1,
            listenerCount: 0,
            totalListeners: 0,
            rootNodeId: null,
          },
        ]);
      } finally {
        first.cancel();
        second.cancel();
      }
    });

    it("finds the node an id names in the render an index or element picks", () => {
      const first = rendered("of:first-lookup");
      const second = rendered("of:second-lookup");
      try {
        const helpers = createVDomDebugHelpers();
        const applicator = helpers.registry.get(second.element)!.renderer
          .getApplicator();
        applicator.applyBatch({
          batchId: 1,
          ops: [{ op: "create-element", nodeId: 7, tagName: "span" }],
        });
        const node = applicator.getNode(7);

        expect(node).toBeDefined();
        expect(helpers.nodeForId(7, 1)).toBe(node);
        expect(helpers.nodeForId(7, second.element)).toBe(node);
        expect(helpers.nodeForId(7)).toBeUndefined();
        expect(helpers.nodeForId(7, 0)).toBeUndefined();
      } finally {
        first.cancel();
        second.cancel();
      }
    });

    it("warns for an index past the last render", async () => {
      const { cancel } = rendered("of:only-view");
      try {
        const helpers = createVDomDebugHelpers();
        let result: unknown = "unset";

        const warnings = await capture("warn", async () => {
          result = await helpers.tree(1);
        });

        expect(result).toBeUndefined();
        expect(warnings).toEqual([["No active render found."]]);
      } finally {
        cancel();
      }
    });

    it("`dump()` prints the formatted tree of the first render", async () => {
      const { cancel } = rendered("of:dumped-view", {
        value: { type: "vnode", name: "p", props: {}, children: ["hi"] },
      });
      try {
        expect(await capture("log", () => createVDomDebugHelpers().dump()))
          .toEqual([['<p>\n  "hi"\n</p>']]);
      } finally {
        cancel();
      }
    });

    it("`dump()` warns when the view holds no tree", async () => {
      const { cancel } = rendered("of:empty-tree", { value: undefined });
      try {
        const helpers = createVDomDebugHelpers();
        const logged = await capture("log", async () => {
          expect(await capture("warn", () => helpers.dump())).toEqual([[
            "Tree is empty.",
          ]]);
        });

        expect(logged).toEqual([]);
      } finally {
        cancel();
      }
    });
  });
});
