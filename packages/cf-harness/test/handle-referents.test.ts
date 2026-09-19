/**
 * Referent handles: tokens for what a run observed that is not a cell — a
 * Loom row — held in the run's handle table beside its address handles.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
  resolveReferentToken,
  swapTokensForRefs,
} from "../src/handle-table.ts";
import { agentObservedHandlesOfTable } from "../src/result-writer.ts";
import { describeHandleTool } from "../src/tools/describe-handle.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

const WORK = "https://cfc.test/atom/facet/work";

const ROW = {
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
        kind: "document",
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
  });

  describe("assertValidHarnessHandleTable()", () => {
    it("accepts a table holding referents and throws for a malformed one", async () => {
      const { table, token } = await mintReferentHandle(
        createHarnessHandleTable("run-referents"),
        ROW,
      );

      expect(() => assertValidHarnessHandleTable(table)).not.toThrow();
      for (
        const broken of [
          { ...table.referents![0], token: "cfh:a:22222" },
          { ...table.referents![0], kind: "cell" },
          { ...table.referents![0], label: "public" },
          { ...table.referents![0], labelSource: "guess" },
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
  });
});
