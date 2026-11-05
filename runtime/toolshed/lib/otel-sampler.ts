import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

/**
 * Builds a {@link Sampler} from `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`.
 *
 * The OTel JS SDK does *not* auto-read these env vars under Deno (verified: a
 * `BasicTracerProvider` with no explicit sampler always-samples regardless of
 * `OTEL_TRACES_SAMPLER`), so toolshed builds the sampler here and passes it to
 * the provider explicitly (see `lib/otel.ts`).
 *
 * Supported names mirror the OTel spec. Unknown names fall back to `always_on`
 * (the documented default) so a typo never silently disables tracing.
 * `arg` is the sampling ratio for the `*ratio` variants; an empty, non-numeric,
 * or out-of-range value falls back to `1` (sample everything) so a malformed
 * `OTEL_TRACES_SAMPLER_ARG` never silently drops all traces.
 */
export function samplerFromEnv(name: string, arg: string): Sampler {
  // Strict parse: only a clean ratio in [0,1] is honored. (Number.parseFloat is
  // too lenient -- it reads "0x10" as 0, which would drop every trace.)
  const trimmed = arg.trim();
  const parsed = trimmed === "" ? NaN : Number(trimmed);
  const ratio = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : 1;
  switch (name) {
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return new TraceIdRatioBasedSampler(ratio);
    case "parentbased_always_on":
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(ratio),
      });
    case "always_on":
    default:
      return new AlwaysOnSampler();
  }
}
