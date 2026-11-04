import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { reportProgressTool } from "../src/tools/report-progress.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { withheldToolIds } from "../src/contracts/tool-descriptor.ts";

describe("report_progress", () => {
  it("withholds the tool until the host provides its return channel", () => {
    const backing = {
      fabricSessionAvailable: false,
      patternIndexAvailable: false,
      skillsShSearchAvailable: false,
      skillsShAcquisitionAvailable: false,
      skillRegistryAvailable: false,
      docsCorpusAvailable: false,
    };
    expect(withheldToolIds(backing).has("report_progress")).toBe(true);
    expect(
      withheldToolIds({ ...backing, progressAvailable: true }).has(
        "report_progress",
      ),
    ).toBe(false);
  });

  it("rejects empty and oversized messages without publishing", async () => {
    const messages: string[] = [];
    const context = {
      nextOutputId: () => "progress-test",
      reportProgress: (message: string) => {
        messages.push(message);
        return Promise.resolve();
      },
    } as unknown as HarnessToolContext;
    for (const message of ["", "   ", "x".repeat(2001)]) {
      expect((await reportProgressTool.invoke(context, { message })).status)
        .toBe("error");
    }
    expect(messages).toEqual([]);
    expect(
      (await reportProgressTool.invoke(context, {
        message: "Checked the sources",
      })).status,
    ).toBe("ok");
    expect(messages).toEqual(["Checked the sources"]);
  });

  it("counts Unicode code points at the message limit", async () => {
    const messages: string[] = [];
    const context = {
      nextOutputId: () => "unicode-progress",
      reportProgress: (message: string) => {
        messages.push(message);
        return Promise.resolve();
      },
    } as unknown as HarnessToolContext;
    expect(
      (await reportProgressTool.invoke(context, { message: "😀".repeat(2000) }))
        .status,
    ).toBe("ok");
    expect(
      (await reportProgressTool.invoke(context, { message: "😀".repeat(2001) }))
        .status,
    ).toBe("error");
    expect(messages).toEqual(["😀".repeat(2000)]);
  });

  it("reports a recoverable publication failure to the model", async () => {
    const context = {
      nextOutputId: () => "failed-progress",
      reportProgress: () => Promise.resolve(false),
    } as unknown as HarnessToolContext;
    expect(
      (await reportProgressTool.invoke(context, { message: "Working" })).status,
    ).toBe("error");
  });

  it("refuses a direct invocation without host opt-in", async () => {
    const context = {
      nextOutputId: () => "progress-test",
    } as unknown as HarnessToolContext;
    expect(
      (await reportProgressTool.invoke(context, { message: "Working" })).status,
    ).toBe("error");
  });
});
