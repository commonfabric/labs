/**
 * Carried label-view work as the number of labeled message fields grows.
 * Fixtures stay outside timing. Cloning and merging retain every field;
 * child rebasing selects one message from the same view. The uncached
 * repeated-read baselines hold width fixed while varying how often a child view
 * is requested directly from the core helper.
 */

import {
  type CfcLabelView,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "../src/cfc/label-view-core.ts";

const classes = [
  undefined,
  "value",
  "shape",
  "enumerate",
  "followRef",
] as const;

const makeView = (messages: number): CfcLabelView => ({
  version: 1,
  entries: Array.from({ length: messages * 6 }, (_, index) => ({
    path: [
      "messages",
      String(Math.floor(index / 6)),
      `field~/${index % 6}`,
    ],
    label: {
      confidentiality: [{ anyOf: ["reader-a", "reader-b"] }, "reader-c"],
      integrity: ["source"],
    },
    ...(classes[index % classes.length] === undefined
      ? {}
      : { observes: classes[index % classes.length] }),
  })),
});

for (const messages of [1, 8, 50, 200]) {
  const view = makeView(messages);
  const entries = view.entries.length;
  for (
    const [name, operation] of [
      ["clone", () => cloneCfcLabelView(view)],
      ["merge", () => mergeCfcLabelViews([view, view])],
      ["rebase root", () => rebaseCfcLabelView(view, ["messages"])],
      ["rebase child", () => rebaseCfcLabelView(view, ["messages", "0"])],
    ] as const
  ) {
    Deno.bench({
      name: `${name}: ${entries} entries`,
      group: "cfc label view width",
      fn: () => {
        operation();
      },
    });
  }
}

const repeatedView = makeView(50);
for (const reads of [1, 6, 50]) {
  Deno.bench({
    name: `uncached ${reads} child reads: 300 entries`,
    group: "cfc label view frequency (uncached baseline)",
    fn: () => {
      for (let read = 0; read < reads; read++) {
        rebaseCfcLabelView(repeatedView, ["messages", "0"]);
      }
    },
  });
}
