import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

describe("Impossible Machine document shell", () => {
  it("keeps React Flow measurement and overlay layers explicitly sized", async () => {
    const html = await Deno.readTextFile(
      new URL("./guest.html", import.meta.url),
    );

    expect(html).toMatch(
      /\.workspace\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
    expect(html).toMatch(
      /\.flow-shell\s*{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
    expect(html).toMatch(
      /\.react-flow__node-actuator\s*{[^}]*width:\s*218px;/s,
    );
    expect(html).toMatch(
      /\.react-flow__edgelabel-renderer,[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
    expect(html).toMatch(
      /\.react-flow__viewport-portal[^}]*width:\s*100%;[^}]*height:\s*100%;/s,
    );
  });

  it("mounts the tested control and selection lifecycle in each node", async () => {
    const source = await Deno.readTextFile(
      new URL("./guest.tsx", import.meta.url),
    );
    const canvasSource = await Deno.readTextFile(
      new URL("./machine-canvas/guest.ts", import.meta.url),
    );

    expect(source).toContain(
      "<div {...model.nodeControlBoundaryProps()}>{children}</div>",
    );
    expect(source).toContain("await model.updateLatestValue(");
    expect(source).toContain("tracker.request(");
    expect(source).toContain(
      "authoritativeSelection={outputValue.selectedNodeId}",
    );
    expect(canvasSource).toContain("selectionDraftRef.current?.confirmed");
    expect(source).toContain("const actionRunner = React.useRef(");
    expect(source).toContain("const runNodeAction = actionRunner.runNode");
    expect(source).toContain("const located = model.findAppendOnlyItem(");
    expect(source).not.toContain("nodesCell.key(index).resolve()");
    expect(canvasSource).toContain("nodesDraggable: true");
    expect(canvasSource).toContain("nodesConnectable: true");
    expect(canvasSource).toContain("elementsSelectable: true");
    expect(canvasSource).not.toContain("nodesDraggable: !pending");
  });
});
