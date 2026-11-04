import { assertEquals, assertInstanceOf } from "@std/assert";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { samplerFromEnv } from "@/lib/otel-sampler.ts";

Deno.test("samplerFromEnv maps OTEL_TRACES_SAMPLER to the right sampler", () => {
  assertInstanceOf(samplerFromEnv("always_on", "1.0"), AlwaysOnSampler);
  assertInstanceOf(samplerFromEnv("always_off", "1.0"), AlwaysOffSampler);
  assertInstanceOf(
    samplerFromEnv("traceidratio", "0.25"),
    TraceIdRatioBasedSampler,
  );
  assertInstanceOf(
    samplerFromEnv("parentbased_traceidratio", "0.1"),
    ParentBasedSampler,
  );
  assertInstanceOf(
    samplerFromEnv("parentbased_always_off", "1.0"),
    ParentBasedSampler,
  );

  // A typo / unknown value falls back to always_on so tracing isn't silently
  // disabled, and a non-numeric ratio falls back to 1 rather than throwing.
  assertInstanceOf(samplerFromEnv("totally-bogus", "1.0"), AlwaysOnSampler);
  assertInstanceOf(
    samplerFromEnv("traceidratio", "not-a-number"),
    TraceIdRatioBasedSampler,
  );
});

Deno.test("traceidratio reflects the configured ratio", () => {
  assertEquals(
    samplerFromEnv("traceidratio", "0.25").toString(),
    "TraceIdRatioBased{0.25}",
  );

  // Empty / non-numeric / out-of-range args fall back to 1 (sample everything),
  // never to 0 -- a malformed OTEL_TRACES_SAMPLER_ARG must not silently drop all
  // traces. (Number.parseFloat("0x10") would read as 0.)
  for (const bad of ["", "not-a-number", "0x10", "2", "-0.5"]) {
    assertEquals(
      samplerFromEnv("traceidratio", bad).toString(),
      "TraceIdRatioBased{1}",
      `arg ${JSON.stringify(bad)} should fall back to ratio 1`,
    );
  }
});
