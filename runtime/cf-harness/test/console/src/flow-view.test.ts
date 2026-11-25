import { expect } from "@std/expect";
import {
  ConsoleFlowView,
  labelRegime,
} from "../../../console/src/flow-view.ts";
import type {
  ConsoleFlow,
  ConsoleFlowCell,
  ConsoleFlowNode,
} from "../../../console/flow.ts";
import { handlerOn, templateText } from "./lit-template.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The view, rendered on demand rather than into a DOM. */
class TestConsoleFlowView extends ConsoleFlowView {
  view() {
    return this.render();
  }

  /** The element the view renders into. */
  root(): HTMLElement | DocumentFragment {
    return this.createRenderRoot();
  }

  /** The rendered text, spaces folded. */
  text(): string {
    return templateText(this.view()).replace(/\s+/g, " ");
  }

  /** The details of every `flow-selected` event the view dispatches. */
  selections(): unknown[] {
    const seen: unknown[] = [];
    this.addEventListener("flow-selected", (event) => {
      seen.push(event instanceof CustomEvent ? event.detail : undefined);
    });
    return seen;
  }
}

const cell = (id: string, as?: string): ConsoleFlowCell => ({
  id,
  confidentiality: [],
  as,
});

const node = (overrides: Partial<ConsoleFlowNode> = {}): ConsoleFlowNode => ({
  id: "node-1",
  runId: "run-a",
  step: 1,
  kind: "call",
  label: "run_pattern",
  status: "ok",
  reads: [],
  produces: [],
  entersScope: [],
  children: [],
  depth: 0,
  ...overrides,
});

const flowOf = (
  nodes: readonly ConsoleFlowNode[],
  overrides: Partial<ConsoleFlow> = {},
): ConsoleFlow => ({
  turns: [{ step: 0, text: "build a counter", nodes }],
  failures: 0,
  denials: 0,
  unwiredPatterns: 0,
  ...overrides,
});

const showing = (
  flow: ConsoleFlow | undefined,
  focus: { step?: number; runId?: string } = {},
): TestConsoleFlowView => {
  const view = new TestConsoleFlowView();
  view.flow = flow;
  view.focusStep = focus.step;
  view.focusRunId = focus.runId;
  return view;
};

describe("console/src/flow-view", () => {
  describe("labelRegime", () => {
    it("counts the cells that carry a label when every one was read whole", () => {
      expect(labelRegime({
        status: "read",
        cellsRead: 3,
        cellsLabelled: 2,
        cellsPartial: 0,
      })).toBe("cell labels read · 2 of 3 carry one");
    });

    it("states a partial reading where a cell was read only in part", () => {
      // The count is a floor under a partial reading — another label may sit
      // at a path nothing was read at — so the line may not lead with it as a
      // total.
      expect(labelRegime({
        status: "read",
        cellsRead: 3,
        cellsLabelled: 2,
        cellsPartial: 1,
      })).toBe(
        "cell labels read in part · 2 of 3 carry one, 1 only partly read",
      );
    });

    it("says nobody asked where the run recorded no snapshot", () => {
      expect(labelRegime({
        status: "absent",
        cellsRead: 0,
        cellsLabelled: 0,
        cellsPartial: 0,
      })).toBe("cell labels not read");
    });

    it("names why the space could not be read", () => {
      expect(labelRegime({
        status: "unavailable",
        detail: "no space database on this host",
        cellsRead: 0,
        cellsLabelled: 0,
        cellsPartial: 0,
      })).toBe("cell labels unavailable · no space database on this host");
    });
  });

  describe("ConsoleFlowView", () => {
    it("registers itself as console-flow-view", () => {
      expect(customElements.get("console-flow-view")).toBe(ConsoleFlowView);
    });

    it("renders into its own element, where the page's stylesheet reaches it", () => {
      const view = new TestConsoleFlowView();

      expect(view.root()).toBe(view);
    });

    it("says the map is still arriving before one is read", () => {
      expect(showing(undefined).text()).toBe('<p class="empty">Reading…</p>');
    });

    it("says a run with no turns did nothing to map", () => {
      expect(showing({ ...flowOf([]), turns: [] }).text()).toContain(
        "This run did nothing to map.",
      );
    });

    it("draws each turn's question and its nodes", () => {
      const text = showing(flowOf([node({ label: "write_file" })])).text();

      expect(text).toContain("build a counter");
      expect(text).toContain("write_file");
      expect(text).not.toContain("Reading…");
    });

    it("stands in for a turn that carried no text", () => {
      const flow: ConsoleFlow = {
        ...flowOf([]),
        turns: [{ step: 0, nodes: [] }],
      };

      expect(showing(flow).text()).toContain("(no text)");
    });

    describe("summary", () => {
      it("states the CFC regime, naming first-party where no posture was set", () => {
        const text = showing(flowOf([], {
          cfc: { enforcementMode: "enforce-explicit", flowLabels: "persist" },
        })).text();

        expect(text).toContain(
          "first-party · labels persist · enforce-explicit",
        );
      });

      it("names the posture the run ran under", () => {
        const text = showing(flowOf([], {
          cfc: {
            enforcementMode: "observe",
            flowLabels: "off",
            posture: "third-party",
          },
        })).text();

        expect(text).toContain("third-party · labels off · observe");
        expect(text).not.toContain("first-party");
      });

      it("states what the space said about the run's cell labels", () => {
        const text = showing(flowOf([], {
          cellLabels: {
            status: "absent",
            cellsRead: 0,
            cellsLabelled: 0,
            cellsPartial: 0,
          },
        })).text();

        expect(text).toContain("cell labels not read");
      });

      it("counts failures, denials and unwired patterns where there are any", () => {
        const text = showing(flowOf([], {
          failures: 2,
          denials: 3,
          unwiredPatterns: 4,
        })).text();

        expect(text).toContain("2 failed");
        expect(text).toContain("3 denied");
        expect(text).toContain("4 unwired");
      });

      it("draws no regime, labels or counts where the run has none", () => {
        const text = showing(flowOf([])).text();

        expect(text).not.toContain("labels");
        expect(text).not.toContain("failed");
        expect(text).not.toContain("denied");
        expect(text).not.toContain("unwired");
      });
    });

    describe("nodes", () => {
      it("marks the node of the focused step in the focused run", () => {
        expect(
          showing(flowOf([node({ step: 4 })]), { step: 4, runId: "run-a" })
            .text(),
        ).toContain("flow-node ok here");
      });

      it("marks the focused step when no run is focused", () => {
        expect(showing(flowOf([node({ step: 4 })]), { step: 4 }).text())
          .toContain("flow-node ok here");
      });

      it("leaves a node of the same step in another run unmarked", () => {
        // A child's steps number from zero, so a step alone does not say
        // which node the timeline is on.
        const text = showing(
          flowOf([node({ step: 4, runId: "run-a.subagent.1" })]),
          { step: 4, runId: "run-a" },
        ).text();

        expect(text).not.toContain("here");
      });

      it("leaves a node of another step unmarked", () => {
        expect(showing(flowOf([node({ step: 3 })]), { step: 4 }).text())
          .not.toContain("here");
      });

      it("badges a node CFC denied, with what the refusal said", () => {
        const text = showing(flowOf([node({
          policyDenied: true,
          policyDetail: "withheld at release",
          policyDecision: "allowed",
        })])).text();

        expect(text).toContain("title=withheld at release> cfc denied");
        expect(text).not.toContain("cfc allowed");
      });

      it("states the decision CFC made about a node it did not deny", () => {
        const text = showing(flowOf([node({ policyDecision: "allowed" })]))
          .text();

        expect(text).toContain("cfc allowed");
        expect(text).not.toContain("cfc denied");
      });

      it("says nothing about CFC for a node it made no decision about", () => {
        expect(showing(flowOf([node()])).text()).not.toContain("cfc");
      });

      it("warns of a numeric run long enough to be a channel", () => {
        expect(showing(flowOf([node({ longestNumericRun: 32 })])).text())
          .toContain("a long run of numbers crossed as value");
      });

      it("does not warn of a numeric run shorter than a channel", () => {
        expect(showing(flowOf([node({ longestNumericRun: 31 })])).text())
          .not.toContain("a long run of numbers");
      });

      it("lists the cells a node read, made and brought into scope", () => {
        const text = showing(flowOf([node({
          reads: [cell("cell-in", "source"), cell("cell-plain")],
          produces: [cell("cell-out")],
          entersScope: [cell("cell-handed")],
        })])).text();

        expect(text).toContain("reads");
        expect(text).toContain('<span class="flow-as">source</span>');
        expect(text.match(/flow-as/g)).toHaveLength(1);
        expect(text).toContain("makes");
        expect(text).toContain("in scope");
      });

      it("draws no cell list for a node that touched no cell", () => {
        expect(showing(flowOf([node()])).text()).not.toContain("flow-cells");
      });

      it("draws a node's text and the child run beneath it", () => {
        const text = showing(flowOf([node({
          text: "delegated the styling",
          children: [node({
            id: "node-2",
            runId: "run-a.subagent.1",
            label: "write_file",
          })],
        })])).text();

        expect(text).toContain("delegated the styling");
        expect(text).toContain("flow-children");
        expect(text).toContain("write_file");
      });

      it("draws neither text nor children for a node with none", () => {
        const text = showing(flowOf([node()])).text();

        expect(text).not.toContain("flow-text");
        expect(text).not.toContain("flow-children");
      });
    });

    describe("selection", () => {
      it("reports the run and step of a node clicked", () => {
        const view = showing(flowOf([node({ step: 6 })]));
        const seen = view.selections();

        handlerOn(view.view(), "@click", "run_pattern")();

        expect(seen).toEqual([{ runId: "run-a", step: 6 }]);
      });

      it("reports only the step of a turn clicked", () => {
        const view = showing(flowOf([node({ step: 6 })]));
        const seen = view.selections();

        handlerOn(view.view(), "@click", "asked")();

        expect(seen).toEqual([{ step: 0 }]);
      });
    });
  });
});
