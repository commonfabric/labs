/** Retitling and retargeting write only the fields they name. */
import {
  action,
  assert,
  currentPrincipal,
  NAME,
  pattern,
  principalOf,
  TESTS,
  Writable,
} from "commonfabric";
import Loom from "./main.tsx";
import type { Panel, PublishedDocument } from "./schemas.tsx";

export default pattern(() => {
  const loom = Loom({});
  const me = new Writable("");
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  const target = new Writable({ title: "Target" });
  const otherTarget = new Writable({ title: "Other target" });
  const content = new Writable<PublishedDocument>({
    source: { kind: "page-excerpt", title: "Source", body: "Body" },
    notes: "",
  });
  const documentPanel = new Writable<Panel>();
  const outside = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/outside",
  });
  const addTarget = action(() => loom.addPiece.send({ piece: target }));
  const addDocument = action(() => {
    documentPanel.set({ kind: "document", content });
    loom.addPanel.send({ panel: documentPanel });
  });
  const retitleLoom = action(() => loom.retitleLoom.send({ title: "Renamed" }));
  const retitle = action(() =>
    loom.retitlePanel.send({
      panel: loom.panels[0],
      titleOverride: "Shown title",
    })
  );
  const toUrl = action(() =>
    loom.retargetPanel.send({
      panel: loom.panels[0],
      target: { kind: "url", url: "https://example.com/new" },
    })
  );
  const toPiece = action(() =>
    loom.retargetPanel.send({
      panel: loom.panels[0],
      target: { kind: "piece", piece: otherTarget },
    })
  );
  const clearTitle = action(() =>
    loom.retitlePanel.send({ panel: loom.panels[0], titleOverride: "" })
  );
  const retitleOutside = action(() =>
    loom.retitlePanel.send({ panel: outside, titleOverride: "Outside" })
  );
  const retargetOutside = action(() =>
    loom.retargetPanel.send({
      panel: outside,
      target: { kind: "url", url: "https://example.com/elsewhere" },
    })
  );
  const retargetDocument = action(() =>
    loom.retargetPanel.send({
      panel: documentPanel,
      target: { kind: "url", url: "https://example.com/elsewhere" },
    })
  );
  const retargetToInvalidUrl = action(() =>
    loom.retargetPanel.send({
      panel: loom.panels[0],
      target: { kind: "url", url: "javascript:alert(1)" },
    })
  );
  return {
    allowRuntimeErrors: true,
    expectRuntimeErrors: 4,
    allowConsoleErrors: true,
    [TESTS]: [
      { action: recordMe },
      { action: addTarget },
      { action: addDocument },
      { assertion: assert(() => loom.panels.length === 2 && me.get() !== "") },
      { action: retitleLoom },
      {
        assertion: assert(() =>
          loom.title === "Renamed" && loom[NAME] === "Renamed"
        ),
      },
      // A retitle writes the title alone: the target and the adder, with the
      // label the root stamped on it, stay as `admitPanel` wrote them.
      { action: retitle },
      {
        assertion: assert(() => {
          const panel = loom.panels[0].get();
          return panel.kind === "piece" && panel.piece.equals(target) &&
            panel.titleOverride === "Shown title" &&
            panel.addedBy === me.get() &&
            principalOf(loom.panels[0].key("addedBy"), "authored-by") ===
              me.get();
        }),
      },
      // A retarget changes the kind and the target, and nothing else; the
      // occurrence stays where it is, and the target it leaves is untouched.
      { action: toUrl },
      {
        assertion: assert(() => {
          const panel = loom.panels[0].get();
          return panel.kind === "url" &&
            panel.url === "https://example.com/new" &&
            panel.titleOverride === "Shown title" &&
            panel.addedBy === me.get() &&
            principalOf(loom.panels[0].key("addedBy"), "authored-by") ===
              me.get() &&
            loom.pieceRegistry.length === 0 &&
            target.get().title === "Target";
        }),
      },
      { action: toPiece },
      {
        assertion: assert(() => {
          const panel = loom.panels[0].get();
          return panel.kind === "piece" && panel.piece.equals(otherTarget) &&
            panel.titleOverride === "Shown title" &&
            panel.addedBy === me.get() &&
            loom.pieceRegistry.length === 1 &&
            loom.pieceRegistry[0].equals(otherTarget);
        }),
      },
      { action: clearTitle },
      { assertion: assert(() => !loom.panels[0].get().titleOverride) },
      // A panel outside the Loom, a document's content, and a URL a panel may
      // not hold are each refused, and change nothing.
      { action: retitleOutside },
      { action: retargetOutside },
      { action: retargetDocument },
      { action: retargetToInvalidUrl },
      {
        assertion: assert(() =>
          outside.get().titleOverride === undefined &&
          outside.get().kind === "url" &&
          documentPanel.get().kind === "document" &&
          loom.panels[0].get().kind === "piece" &&
          loom.panels.length === 2
        ),
      },
    ],
  };
});
