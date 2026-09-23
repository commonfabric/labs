/**
 * Referent handles: tokens for what a run observed that is not a cell — a
 * Loom row — held in the run's handle table beside its address handles.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  type HarnessResearchHandleValue,
} from "../src/contracts/research.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
  referentDraft,
  resolveReferentToken,
  swapTokensForRefs,
} from "../src/handle-table.ts";
import { agentObservedHandlesOfTable } from "../src/result-writer.ts";
import { describeHandleTool } from "../src/tools/describe-handle.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

/** A sandbox the engine can be built over; nothing here runs in it. */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
    return path.startsWith("/") ? path : `${cwd}/${path}`;
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const WORK = "https://cfc.test/atom/facet/work";

const ROW = {
  kind: "document" as const,
  source: "loom_search",
  value: { title: "Mail 1", snippet: "donuts on friday" },
  label: { confidentiality: [WORK] },
  labelSource: "query" as const,
};

describe("referent handles", () => {
  describe("mintReferentHandle()", () => {
    it("mints a `cfh:v:` token and records the content, label, and label source", async () => {
      const minted = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );

      expect(minted.token).toMatch(/^cfh:v:[2-9a-z]{5}$/);
      expect(resolveReferentToken(minted.table, minted.token)).toEqual({
        token: minted.token,
        ...ROW,
      });
      expect(minted.table.entries).toEqual([]);
    });

    it("returns the same token for the same row, and another for a different one", async () => {
      const first = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );
      const again = await mintReferentHandle(first.table, ROW);
      const other = await mintReferentHandle(again.table, {
        ...ROW,
        value: { title: "Mail 2" },
      });

      expect(again.token).toBe(first.token);
      expect(again.table.referents?.length).toBe(1);
      expect(other.token).not.toBe(first.token);
      expect(other.table.referents?.length).toBe(2);
    });

    it("uses canonical value identity for bigint and object key order", async () => {
      const first = await mintReferentHandle(
        createHarnessHandleTable("run-canonical-referents"),
        {
          ...ROW,
          value: { count: 2n, nested: { first: 1, second: 2 } },
          label: {},
        },
      );
      const reordered = await mintReferentHandle(first.table, {
        ...ROW,
        value: { nested: { second: 2, first: 1 }, count: 2n },
        label: {},
      });

      expect(reordered.token).toBe(first.token);
      expect(reordered.table.referents).toHaveLength(1);
    });
  });

  describe("mintReferentHandle() under a token collision", () => {
    it("derives another suffix for a different row whose first suffix is taken", async () => {
      // A hasher that ignores all but the attempt counter's presence, so two
      // rows collide on their first suffix.
      const hasher = (bytes: Uint8Array) =>
        Promise.resolve(
          new Uint8Array(32).fill(
            new TextDecoder().decode(bytes).endsWith("\u00001") ? 7 : 3,
          ),
        );
      const first = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
        { hasher },
      );
      const second = await mintReferentHandle(
        first.table,
        { ...ROW, value: { title: "Mail 2" } },
        { hasher },
      );

      expect(second.token).not.toBe(first.token);
      expect(second.token).toMatch(/^cfh:v:[2-9a-z]{5}$/);
    });
  });

  describe("assertValidHarnessHandleTable()", () => {
    it("throws for referents that are not an array of objects", () => {
      const table = createHarnessHandleTable("run-referents");

      expect(() =>
        // deno-lint-ignore no-explicit-any
        assertValidHarnessHandleTable({ ...table, referents: {} as any })
      ).toThrow("referents must be an array");
      expect(() =>
        // deno-lint-ignore no-explicit-any
        assertValidHarnessHandleTable({ ...table, referents: ["row"] as any })
      ).toThrow("referent is not an object");
    });

    it("accepts a table holding referents and throws for a malformed one", async () => {
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );

      expect(() => assertValidHarnessHandleTable(table)).not.toThrow();
      const research = await mintReferentHandle(table, {
        ...ROW,
        kind: "research",
        source: "research",
        labelSource: "research",
      });
      expect(() => assertValidHarnessHandleTable(research.table)).not
        .toThrow();
      for (
        const broken of [
          { ...table.referents![0], token: "cfh:a:22222" },
          { ...table.referents![0], kind: "cell" },
          { ...table.referents![0], label: "public" },
          {
            ...table.referents![0],
            label: { confidentiality: "private" },
          },
          {
            ...table.referents![0],
            label: { integrity: [{ name: "no type" }] },
          },
          { ...table.referents![0], labelSource: "guess" },
          { ...table.referents![0], labelSource: "research" },
          { ...table.referents![0], kind: "research" },
          { ...table.referents![0], source: "" },
        ]
      ) {
        expect(() =>
          assertValidHarnessHandleTable({
            ...table,
            // deno-lint-ignore no-explicit-any
            referents: [broken as any],
          })
        ).toThrow(/invalid handle table/);
      }
      expect(() =>
        assertValidHarnessHandleTable({
          ...table,
          referents: [table.referents![0], table.referents![0]],
        })
      ).toThrow(`duplicate token \`${token}\``);
      expect(() =>
        assertValidHarnessHandleTable({
          ...table,
          referents: [
            table.referents![0],
            { ...table.referents![0], token: "cfh:v:33333" },
          ],
        })
      ).toThrow("duplicate referent identity");
    });
  });

  describe("swapTokensForRefs()", () => {
    it("leaves a referent token the text it is", async () => {
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );

      expect(swapTokensForRefs(table, { about: token })).toEqual({
        about: token,
      });
    });
  });

  describe("describe_handle", () => {
    it("declares the referent metadata it returns", () => {
      const schema = describeHandleTool.descriptor.outputSchema as {
        properties?: Record<string, unknown>;
      };

      expect(schema.properties?.referent).toEqual({
        type: "object",
        properties: {
          kind: { type: "string" },
          source: { type: "string" },
          labelSource: { type: "string" },
        },
        required: ["kind", "source", "labelSource"],
        additionalProperties: false,
      });
    });

    it("reports a referent's source, label atom types, and label source, and never its content", async () => {
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );
      const output = await describeHandleTool.invoke(
        {
          nextOutputId: (toolId: string) =>
            createToolOutputId("run-referents", toolId, 1),
          handleTable: table,
        } as unknown as HarnessToolContext,
        { token },
      );

      expect(output).toMatchObject({
        token,
        known: true,
        hasSchema: false,
        referent: {
          kind: "document",
          source: "loom_search",
          labelSource: "query",
        },
      });
      expect(JSON.stringify(output)).not.toContain("donuts");
      expect(output.labels?.[0].path).toEqual([]);
    });
  });

  describe("referentDraft()", () => {
    it("returns a referent's fields without its token, for either kind", async () => {
      const document = await mintReferentHandle(
        createHarnessHandleTable("run-drafts"),
        ROW,
      );
      const research = await mintReferentHandle(document.table, {
        ...ROW,
        kind: "research",
        source: "research",
        labelSource: "research",
      });
      const [heldDocument, heldResearch] = research.table.referents!;

      expect(referentDraft(heldDocument)).toEqual(ROW);
      expect(referentDraft(heldResearch)).toEqual({
        ...ROW,
        kind: "research",
        source: "research",
        labelSource: "research",
      });
      expect(referentDraft(heldResearch)).not.toHaveProperty("token");
    });
  });

  describe("CfHarnessEngine.mintResearchHandle()", () => {
    const findings: HarnessResearchHandleValue = {
      type: HARNESS_RESEARCH_HANDLE_TYPE,
      researchRunId: "run-engine-mint:research:1",
      kit: {
        purpose: "answer",
        status: "complete",
        task: "Which reader fits?",
        summary: "The ledger reader fits.",
        inputs: [],
        patterns: [],
        rules: [],
        sources: [],
        missing: [],
      },
      confirmedPatterns: [],
      describedHandles: [],
      cfc: {
        version: 1,
        sourceLabel: { confidentiality: [WORK] },
        outputLabel: { confidentiality: [WORK] },
        coverage: "complete",
        missingLabels: [],
      },
    };

    it("mints a research referent under the given label and records it", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-engine-mint",
        model: "gpt-5.4",
      });

      const token = await engine.mintResearchHandle(findings, {
        confidentiality: [WORK],
      });

      expect(token).toMatch(/^cfh:v:/);
      expect(resolveReferentToken(engine.handleTable!, token)).toMatchObject({
        kind: "research",
        source: "research",
        labelSource: "research",
        label: { confidentiality: [WORK] },
      });
    });

    it("refuses a value that is not a research handle's content", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-engine-mint-refused",
        model: "gpt-5.4",
      });

      await expect(
        engine.mintResearchHandle(
          {
            ...findings,
            kit: "not a kit",
          } as unknown as HarnessResearchHandleValue,
          {},
        ),
      ).rejects.toThrow("a research handle holds an admitted kit's projection");
      expect(engine.handleTable?.referents ?? []).toEqual([]);
    });
  });

  describe("agentObservedHandlesOfTable()", () => {
    it("returns general address handles as cells and referents as documents", async () => {
      const address = await mintAddressHandle(
        createHarnessHandleTable("run-referents"),
        "/of:fid1:rszomt4Ti8MwDNpMJLZCjcENRtAH6MFBxgf0wYVNCs8/title",
      );
      const { table, token } = await mintReferentHandle(address.table, ROW);

      expect(agentObservedHandlesOfTable(table)).toEqual([
        { kind: "cell", token: address.token },
        { kind: "document", token, value: ROW.value, label: ROW.label },
      ]);
    });

    it("leaves a research referent out, so no findings document is minted from it", async () => {
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        {
          ...ROW,
          kind: "research",
          source: "research",
          labelSource: "research",
        },
      );

      expect(agentObservedHandlesOfTable(table)).toEqual([]);
      expect(token).toMatch(/^cfh:v:/);
    });
  });
});
