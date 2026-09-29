import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/utils/logger";

import {
  addCfcDenialListener,
  CFC_DENIAL_CODES,
  type CfcDenial,
  isCfcDenialCode,
  reportCfcDenial,
  resetCfcDenialAnnouncements,
} from "../../src/cfc/denial-report.ts";

/**
 * Everything `body` writes to the console. The `cfc` logger is shared, so its
 * level is restored either way; `debug` is what a developer turns on to see a
 * decision's inputs.
 */
const said = (body: () => void, options: { debug?: boolean } = {}): string => {
  const logger = getLogger("cfc");
  const level = logger.level;
  const stderrRoute = Deno.env.get("LOG_TO_STDERR");
  Deno.env.set("LOG_TO_STDERR", "0");
  const console = globalThis.console;
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => JSON.stringify(arg) ?? "").join(" "));
  };
  globalThis.console = {
    ...console,
    warn: capture,
    error: capture,
    info: capture,
    log: capture,
    debug: capture,
  } as Console;
  logger.level = options.debug ? "debug" : "info";
  try {
    body();
  } finally {
    globalThis.console = console;
    if (stderrRoute === undefined) Deno.env.delete("LOG_TO_STDERR");
    else Deno.env.set("LOG_TO_STDERR", stderrRoute);
    logger.level = level;
  }
  return lines.join("\n");
};

/** How many times `needle` appears in `haystack`. */
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const SUMMARY = "a policy check refused the commit";

describe("denial-report", () => {
  afterEach(() => resetCfcDenialAnnouncements());

  describe("reportCfcDenial()", () => {
    it("writes the summary without being asked", () => {
      expect(
        said(() => reportCfcDenial("write-policy-gate", SUMMARY, () => ({}))),
      )
        .toContain(SUMMARY);
    });

    it("keeps the inputs out of what it writes by default", () => {
      const written = said(() =>
        reportCfcDenial("write-policy-gate", SUMMARY, () => ({
          confidentiality: [{ type: "Space", id: "acme-buyout" }],
        }))
      );
      expect(written).not.toContain("acme-buyout");
    });

    it("writes the inputs once the `cfc` logger is raised to debug", () => {
      const written = said(
        () =>
          reportCfcDenial("write-policy-gate", SUMMARY, () => ({
            confidentiality: [{ type: "Space", id: "acme-buyout" }],
          })),
        { debug: true },
      );
      expect(written).toContain("acme-buyout");
    });

    it("does not build the inputs at a level that will not print them", () => {
      let built = 0;
      said(() => {
        reportCfcDenial("write-policy-gate", SUMMARY, () => {
          built += 1;
          return {};
        });
      });
      expect(built).toBe(0);
    });

    it("announces one code once however many denials carry it", () => {
      const written = said(() => {
        for (let attempt = 0; attempt < 3; attempt++) {
          reportCfcDenial("write-policy-gate", SUMMARY, () => ({}));
        }
      });
      expect(occurrences(written, SUMMARY)).toBe(1);
    });

    it("announces a second code beside the first", () => {
      const written = said(() => {
        reportCfcDenial("write-policy-gate", SUMMARY, () => ({}));
        reportCfcDenial(
          "write-unprepared",
          "reached commit unprepared",
          () => ({}),
        );
      });
      expect(written).toContain(SUMMARY);
      expect(written).toContain("reached commit unprepared");
    });

    it("writes every denial to debug, announced or not", () => {
      const written = said(() => {
        reportCfcDenial("write-policy-gate", SUMMARY, () => ({}));
        reportCfcDenial("write-policy-gate", SUMMARY, () => ({}));
      }, { debug: true });
      expect(occurrences(written, SUMMARY)).toBe(3);
    });
  });

  describe("addCfcDenialListener()", () => {
    it("tells the listener of every denial, repeats included, with its inputs", () => {
      const told: CfcDenial[] = [];
      const stop = addCfcDenialListener((denial) => told.push(denial));
      try {
        said(() => {
          reportCfcDenial("write-policy-gate", SUMMARY, () => ({ n: 1 }));
          reportCfcDenial("write-policy-gate", SUMMARY, () => ({ n: 2 }));
        });
      } finally {
        stop();
      }
      expect(told).toEqual([
        { code: "write-policy-gate", summary: SUMMARY, inputs: { n: 1 } },
        { code: "write-policy-gate", summary: SUMMARY, inputs: { n: 2 } },
      ]);
    });

    it("builds the inputs once for a listener and the debug log together", () => {
      let built = 0;
      const stop = addCfcDenialListener(() => {});
      try {
        said(() => {
          reportCfcDenial("write-policy-gate", SUMMARY, () => {
            built += 1;
            return {};
          });
        }, { debug: true });
      } finally {
        stop();
      }
      expect(built).toBe(1);
    });

    it("tells the listener of nothing once the returned function is called", () => {
      const told: CfcDenial[] = [];
      addCfcDenialListener((denial) => told.push(denial))();
      said(() => reportCfcDenial("write-policy-gate", SUMMARY, () => ({})));
      expect(told).toEqual([]);
    });
  });

  describe("isCfcDenialCode()", () => {
    it("returns `true` for every denial code", () => {
      expect(CFC_DENIAL_CODES.every(isCfcDenialCode)).toBe(true);
    });

    it("returns `false` for any other key", () => {
      expect(isCfcDenialCode("cfc")).toBe(false);
    });
  });

  describe("resetCfcDenialAnnouncements()", () => {
    it("lets the next denial of a code announce again", () => {
      expect(
        said(() => reportCfcDenial("write-policy-gate", SUMMARY, () => ({}))),
      )
        .toContain(SUMMARY);
      resetCfcDenialAnnouncements();
      expect(
        said(() => reportCfcDenial("write-policy-gate", SUMMARY, () => ({}))),
      )
        .toContain(SUMMARY);
    });
  });
});
