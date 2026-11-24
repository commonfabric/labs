import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternSourceInfo } from "@commonfabric/runtime-client";

import type { SourceViewNode } from "../src/lib/scheduler-source.ts";
import { XSchedulerSource } from "../src/views/SchedulerSourceView.ts";
import { templateListeners, templateMarkup } from "./lit-template-markup.ts";

/** Source of `/main.tsx`, whose second line holds two actions. */
const MAIN = "const a = 1;\nconst b = lift(f)(a) + derive(g);\nconst c = 3;";

/** Source of `/util.ts`, which holds no actions. */
const UTIL = "export const util = 1;";

/** Action at line 2, column 11 of `/main.tsx`. */
const LIFT = "action:abc123/main.tsx:2:11";

/** Action at line 2, column 25 of `/main.tsx`. */
const DERIVE = "action:abc123/main.tsx:2:25";

/** A pattern holding `files`, keyed by name. */
function pattern(
  identity: string,
  files: Record<string, string>,
): PatternSourceInfo {
  return {
    identity,
    files: Object.entries(files).map(([name, contents]) => ({
      name,
      contents,
    })),
  };
}

/** A node of `type` with the given statistics, in pattern `patternIdentity`. */
function node(
  id: string,
  type: string,
  stats?: { totalTime: number; runCount: number },
  patternIdentity?: string,
): SourceViewNode {
  return { id, type, label: id, stats, patternIdentity };
}

/**
 * A view of one pattern holding `/main.tsx` and `/util.ts`, with an effect and
 * a computation on the second line of `/main.tsx`.
 */
function sourceView(): XSchedulerSource {
  const view = new XSchedulerSource();
  view.patternSources = [
    pattern("cf:module/aaaaaaaaaaaaaaaa", {
      "/main.tsx": MAIN,
      "/util.ts": UTIL,
    }),
  ];
  view.nodes = new Map([
    [LIFT, node(LIFT, "effect", { totalTime: 2, runCount: 3 })],
    [DERIVE, node(DERIVE, "computation", { totalTime: 6, runCount: 1 })],
  ]);
  return view;
}

/** Returns the markup the view renders. */
function markup(view: XSchedulerSource): string {
  return templateMarkup(view.render());
}

/** Returns the markup of the row the view renders for line `line`. */
function row(view: XSchedulerSource, line: number): string {
  const rendered = markup(view);
  const start = rendered.lastIndexOf(
    "<tr",
    rendered.indexOf(`data-line="${line}"`),
  );
  expect(start).toBeGreaterThan(-1);
  return rendered.slice(start, rendered.indexOf("</tr>", start));
}

/** Returns the name of the file whose tab the view renders active. */
function activeTab(view: XSchedulerSource): string | undefined {
  return /file-tab active"[^]*?(\/[\w.]+)\s*<\/button>/.exec(markup(view))?.[1];
}

/**
 * Returns the tags of the elements the view binds a listener for `name` on,
 * holding `tagPart`.
 */
function listeners(view: XSchedulerSource, name: string, tagPart: string) {
  return templateListeners(view.render(), name, view).filter((listener) =>
    listener.tag.includes(tagPart)
  );
}

/**
 * Fires `event` at the listener the view binds on the `nth` element whose tag
 * holds `tagPart`.
 */
function fire(
  view: XSchedulerSource,
  tagPart: string,
  nth = 0,
  event: Event = new Event("click"),
): void {
  const matches = listeners(view, event.type, tagPart);
  expect(matches.length).toBeGreaterThan(nth);
  matches[nth].dispatch(event);
}

/** Returns the `detail` of every `name` event the view dispatches. */
function captureEvents(view: XSchedulerSource, name: string): unknown[] {
  const details: unknown[] = [];
  view.addEventListener(name, (event) => {
    if (event instanceof CustomEvent) details.push(event.detail);
  });
  return details;
}

/**
 * Connects `view` the way a page does, except that updates do nothing, since
 * there is no DOM to render into, and that its rows are stand-ins, or absent
 * unless `hasRows`. Returns the selectors the view looks rows up by, and the
 * options of each scroll it asks of a row, in order.
 */
function connectWithRows(view: XSchedulerSource, hasRows = true) {
  const queries: string[] = [];
  const scrolls: ScrollIntoViewOptions[] = [];
  Object.defineProperty(view, "performUpdate", { value: () => {} });
  Object.defineProperty(view, "renderRoot", {
    value: {
      querySelector: (selectors: string) => {
        queries.push(selectors);
        return hasRows
          ? {
            scrollIntoView: (options: ScrollIntoViewOptions) =>
              scrolls.push(options),
          }
          : null;
      },
    },
  });
  view.connectedCallback();
  return { queries, scrolls };
}

describe("XSchedulerSource", () => {
  describe("instance members", () => {
    describe("render()", () => {
      it("returns a prompt to load sources when there are none", () => {
        const view = new XSchedulerSource();

        const rendered = markup(view);

        expect(rendered).toContain("No pattern sources available");
        expect(rendered).not.toContain("source-table");
      });

      it("returns a notice for a pattern with no files", () => {
        const view = new XSchedulerSource();
        view.patternSources = [pattern("cf:module/empty", {})];

        expect(markup(view)).toContain("Pattern has no source files.");
      });

      it("returns the pattern identity as a label and a tab per file, with the first active", () => {
        const view = sourceView();
        const rendered = markup(view);

        expect(rendered).toContain("cf:module/aa\n");
        expect(rendered).not.toContain("cf:module/aaa");
        expect(rendered).not.toContain("<select");
        expect(activeTab(view)).toBe("/main.tsx");
        expect(rendered).toMatch(/file-tab "[^]*?\/util\.ts\s*<\/button>/);
      });

      it("returns the file name as a label for a pattern with one file", () => {
        const view = new XSchedulerSource();
        view.patternSources = [pattern("cf:module/one", { "/util.ts": UTIL })];

        const rendered = markup(view);

        expect(rendered).toContain("<label>/util.ts</label>");
        expect(rendered).not.toContain("file-tab");
      });

      it("returns a row per line, numbered and holding the line's code", () => {
        const rendered = markup(sourceView());

        expect(rendered).toContain(
          '<td class="line-gutter" @click=>1</td>' +
            '<td class="line-markers" @click=></td>' +
            '<td class="line-code" @click=>const a = 1;</td>',
        );
        expect(rendered).toContain(">3</td>");
        expect(rendered).not.toContain('data-line="4"');
      });

      it("returns a line with actions marked and heated, and a line without plain", () => {
        const view = sourceView();

        const actionRow = row(view, 2);
        const plainRow = row(view, 1);

        expect(actionRow).toContain(
          'class="source-line has-action " data-line="2" ' +
            'style="background-color: rgba(99, 140, 255, 0.43)"',
        );
        expect(actionRow).toContain(
          '<span class="marker-dot effect " title="col 11: effect 2.0ms">',
        );
        expect(actionRow).toContain(
          '<span class="marker-dot computation " ' +
            'title="col 25: computation 6.0ms">',
        );
        expect(actionRow).toMatch(
          /8\.0ms \(4x\)\s*<span class="entry-count">\[2\]/,
        );
        expect(plainRow).toContain(
          'class="source-line  " data-line="1" ' +
            'style="background-color: transparent"',
        );
        expect(plainRow).not.toContain("marker-dot");
      });

      it("returns a line of one action that has never run without a count", () => {
        const view = sourceView();
        view.nodes = new Map([[LIFT, node(LIFT, "effect")]]);

        const stats = row(view, 2).split('class="line-stats"')[1];

        expect(stats).not.toContain("x)");
        expect(stats).not.toContain("entry-count");
      });

      it("returns the selected node's line and marker highlighted", () => {
        const view = sourceView();
        view.selectedNodeId = DERIVE;

        expect(row(view, 2)).toContain(
          'class="source-line has-action selected"',
        );
        expect(row(view, 2)).toContain(
          'class="marker-dot computation selected-entry"',
        );
        expect(row(view, 2)).toContain('class="marker-dot effect "');
        expect(row(view, 1)).not.toContain("selected");
      });

      it("returns the breakpoint indicator active on a line with a breakpoint", () => {
        const view = sourceView();

        expect(row(view, 2)).toContain('class="bp-indicator "');

        view.breakpoints = new Set([DERIVE]);

        expect(row(view, 2)).toContain('class="bp-indicator active"');
        expect(row(view, 1)).toContain('class="bp-indicator "');
      });

      it("returns the time and runs since the baseline, or `idle` where there are none", () => {
        const view = sourceView();
        view.patternSources = [pattern("cf:module/one", { "/main.tsx": MAIN })];
        const later = "action:abc123/main.tsx:3:1";
        view.nodes = new Map([
          ...view.nodes,
          [later, node(later, "effect", { totalTime: 5, runCount: 2 })],
        ]);
        view.baselineStats = new Map([
          [LIFT, { totalTime: 1, runCount: 1 }],
          [DERIVE, { totalTime: 1, runCount: 0 }],
          [later, { totalTime: 5, runCount: 2 }],
        ]);

        const busy = row(view, 2);
        const idle = row(view, 3);

        expect(busy).toMatch(
          /<span class="delta-time">\+6\.0ms<\/span>\s*\(3x\)\s*<span class="entry-count">\[2\]/,
        );
        // Heat follows the time since the baseline: the line that has
        // gained none is as cool as a line can be, for all its total time.
        expect(busy).toContain("rgba(99, 140, 255, 0.43)");
        expect(idle).toContain("rgba(59, 130, 246, 0.08)");
        expect(idle).toContain('<span style="color:#475569">idle</span>');
        expect(idle).not.toContain("delta-time");
      });

      it("returns the time since the baseline without a count for a line of one action", () => {
        const view = sourceView();
        view.nodes = new Map([[LIFT, view.nodes.get(LIFT)!]]);
        view.baselineStats = new Map([[LIFT, { totalTime: 1, runCount: 1 }]]);

        const stats = row(view, 2).split('class="line-stats"')[1];

        expect(stats).toMatch(/\+1\.0ms<\/span>\s*\(2x\)/);
        expect(stats).not.toContain("entry-count");
      });

      it("returns no annotations for the nodes of another pattern", () => {
        const view = sourceView();
        view.nodes = new Map([
          [LIFT, node(LIFT, "effect", undefined, "cf:module/elsewhere")],
        ]);

        expect(row(view, 2)).not.toContain("has-action");
      });
    });

    describe("pattern and file selection", () => {
      it("shows the chosen pattern's first file once a pattern is chosen", () => {
        const view = sourceView();
        view.patternSources = [
          ...view.patternSources,
          pattern("cf:module/bbbbbbbbbbbbbbbb", {
            "/other.tsx": "other();",
            "/more.ts": "more();",
          }),
        ];
        fire(view, 'class="file-tab', 1);

        expect(markup(view)).toMatch(/\?selected="true">\s*cf:module\/aa/);
        expect(markup(view)).toMatch(/\?selected="false">\s*cf:module\/bb/);

        const select = Object.assign(new EventTarget(), { selectedIndex: 1 });
        select.addEventListener("change", (event) => {
          fire(view, "<select", 0, event);
        });
        select.dispatchEvent(new Event("change"));
        const rendered = markup(view);

        expect(rendered).toMatch(/\?selected="true">\s*cf:module\/bb/);
        expect(activeTab(view)).toBe("/other.tsx");
        expect(rendered).toContain("other();");
        expect(rendered).not.toContain("const a = 1;");
      });

      it("shows the clicked file tab active and its file", () => {
        const view = sourceView();

        fire(view, 'class="file-tab', 1);
        const rendered = markup(view);

        expect(activeTab(view)).toBe("/util.ts");
        expect(rendered).toContain(UTIL);
        expect(rendered).not.toContain("const a = 1;");
      });
    });

    describe("line clicks", () => {
      it("dispatches `node-selected` with the line's first action, then the next on each click", () => {
        const view = sourceView();
        const details = captureEvents(view, "node-selected");

        fire(view, 'class="line-code"');
        view.selectedNodeId = LIFT;
        fire(view, 'class="line-stats"');
        view.selectedNodeId = DERIVE;
        fire(view, 'class="line-markers"');

        expect(details).toEqual([
          { nodeId: LIFT, allNodeIds: [LIFT, DERIVE] },
          { nodeId: DERIVE, allNodeIds: [LIFT, DERIVE] },
          { nodeId: LIFT, allNodeIds: [LIFT, DERIVE] },
        ]);
      });

      it("binds clicks on the line with actions and on no other", () => {
        // Three lines render, and each of the five cells of a row binds a
        // click only where the line has actions.

        const view = sourceView();

        expect(markup(view).split("<tr").length - 1).toBe(3);
        for (const cell of ["bp", "gutter", "markers", "code", "stats"]) {
          expect(listeners(view, "click", `class="line-${cell}"`).length)
            .toBe(1);
        }
      });

      it("dispatches `breakpoint-toggle` enabling every action, or disabling them once all are set", () => {
        const view = sourceView();
        const details = captureEvents(view, "breakpoint-toggle");

        view.breakpoints = new Set([LIFT]);
        fire(view, 'class="line-bp"');
        view.breakpoints = new Set([LIFT, DERIVE]);
        fire(view, 'class="line-gutter"');

        expect(details).toEqual([
          { actionIds: [LIFT, DERIVE], enabled: true },
          { actionIds: [LIFT, DERIVE], enabled: false },
        ]);
      });
    });

    describe("updated()", () => {
      it("shows the selected node's pattern and file once the selection changes", () => {
        const view = new XSchedulerSource();
        const utilAction = "action:abc123/util.ts:1:14";
        view.patternSources = [
          pattern("cf:module/first", { "/main.tsx": MAIN }),
          pattern("cf:module/second", { "/main.tsx": MAIN, "/util.ts": UTIL }),
        ];
        view.nodes = new Map([
          [
            utilAction,
            node(utilAction, "effect", undefined, "cf:module/second"),
          ],
        ]);
        view.selectedNodeId = utilAction;

        view.updated(new Map([["selectedNodeId", null]]));
        const rendered = markup(view);

        expect(activeTab(view)).toBe("/util.ts");
        expect(rendered).toContain('class="source-line has-action selected"');
      });

      it("scrolls the selected node's line to the middle of the view once the view has rendered", async () => {
        const view = sourceView();
        const { queries, scrolls } = connectWithRows(view);
        view.selectedNodeId = DERIVE;

        view.updated(new Map([["selectedNodeId", null]]));
        await view.updateComplete;

        expect(queries).toEqual(['.source-line[data-line="2"]']);
        expect(scrolls).toEqual([{ block: "center", behavior: "smooth" }]);
        view.disconnectedCallback();
      });

      it("scrolls nowhere when the selected node's line has not rendered", async () => {
        const view = sourceView();
        const { queries, scrolls } = connectWithRows(view, false);
        view.selectedNodeId = DERIVE;

        view.updated(new Map([["selectedNodeId", null]]));
        await view.updateComplete;

        expect(queries).toEqual(['.source-line[data-line="2"]']);
        expect(scrolls).toEqual([]);
        view.disconnectedCallback();
      });

      it("scrolls nowhere for a selected node that names no source location", async () => {
        const view = sourceView();
        const { queries } = connectWithRows(view);
        view.selectedNodeId = "action:abc123";

        view.updated(new Map([["selectedNodeId", null]]));
        await view.updateComplete;

        expect(queries).toEqual([]);
        view.disconnectedCallback();
      });

      it("shows the selected node's file once sources arrive, and not on another change", () => {
        const view = sourceView();
        const utilAction = "action:abc123/util.ts:1:14";
        view.selectedNodeId = utilAction;

        view.updated(new Map([["breakpoints", new Set()]]));

        expect(activeTab(view)).toBe("/main.tsx");

        view.updated(new Map([["patternSources", []]]));

        expect(activeTab(view)).toBe("/util.ts");
      });

      it("keeps the file shown when the selection is cleared", () => {
        const view = sourceView();
        fire(view, 'class="file-tab', 1);
        view.selectedNodeId = null;

        view.updated(new Map([["selectedNodeId", LIFT]]));

        expect(activeTab(view)).toBe("/util.ts");
      });

      it("keeps the file shown when the selected node names no source location", () => {
        const view = sourceView();
        fire(view, 'class="file-tab', 1);
        view.selectedNodeId = "action:abc123";

        view.updated(new Map([["selectedNodeId", null]]));

        expect(activeTab(view)).toBe("/util.ts");
      });
    });
  });
});
