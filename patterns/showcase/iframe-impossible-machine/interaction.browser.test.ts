/** Exercises embedded node controls with React's real browser event system. */

// @deno-types="npm:@types/react@19.2.18"
// deno-lint-ignore no-external-import
import React from "npm:react@19.2.8";
// @deno-types="npm:@types/react-dom@19.2.5/client.d.ts"
// deno-lint-ignore no-external-import
import { createRoot } from "npm:react-dom@19.2.8/client";
// deno-lint-ignore no-external-import
import { flushSync } from "npm:react-dom@19.2.8";
import { expect } from "@std/expect";

import { nodeControlBoundaryProps } from "./interaction.ts";

function NodeControlHarness(
  { onNodeSelection }: Readonly<{ onNodeSelection: () => void }>,
) {
  const [nodePending, setNodePending] = React.useState(false);
  return React.createElement(
    "div",
    {
      onClick: () => {
        onNodeSelection();
        setNodePending(true);
      },
    },
    React.createElement(
      "div",
      nodeControlBoundaryProps(),
      React.createElement(
        "select",
        {
          "aria-label": "Gate operator",
          defaultValue: "xor",
          disabled: nodePending,
        },
        React.createElement("option", { value: "xor" }, "XOR"),
        React.createElement("option", { value: "and" }, "AND"),
      ),
    ),
  );
}

Deno.test("embedded controls do not select their React Flow node", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let nodeSelections = 0;

  try {
    flushSync(() => {
      root.render(
        React.createElement(NodeControlHarness, {
          onNodeSelection: () => nodeSelections++,
        }),
      );
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    select!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(nodeSelections).toBe(0);
    expect(select!.disabled).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
