import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  getTracerProvider,
  initOpenTelemetry,
  otlpExporter,
  provider,
} from "@/lib/otel.ts";

// Every case here needs the module's provider as it is before any
// registration or shutdown, both of which happen at most once per module
// instance, so these cases have a file of their own and none of them
// registers or shuts the provider down.

describe("otel", () => {
  describe("provider", () => {
    it("hands a span that is not an LLM span to the OTLP exporter", async () => {
      const exported: ReadableSpan[] = [];
      using _export = stub(otlpExporter, "export", (spans, done) => {
        for (const span of spans) exported.push(span);
        done({ code: ExportResultCode.SUCCESS });
      });

      provider.getTracer("otel-test").startSpan("glaze").end();
      await provider.forceFlush();

      expect(exported.map((span) => span.name)).toEqual(["glaze"]);
    });
  });

  describe("initOpenTelemetry()", () => {
    it("logs a context manager that fails to enable, and registers no provider", () => {
      using error = stub(console, "error");
      const failure = new Error("no async context");
      const fail = () => {
        throw failure;
      };

      initOpenTelemetry(true, () => ({
        active: fail,
        with: fail,
        bind: fail,
        enable: fail,
        disable: fail,
      }));

      expect(error.calls.map((call) => call.args)).toEqual([
        ["Failed to initialize OpenTelemetry:", failure],
      ]);
      expect(getTracerProvider()).toBeUndefined();
    });
  });
});
