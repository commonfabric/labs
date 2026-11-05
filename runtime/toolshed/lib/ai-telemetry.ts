import type { Attributes, AttributeValue, Tracer } from "@opentelemetry/api";
import { OpenTelemetry } from "@ai-sdk/otel";

/**
 * Flattens one runtime-context value into span attributes under `key`, matching
 * how @ai-sdk/otel builds its own `ai.settings.context.*` attributes: null and
 * undefined are dropped, arrays and primitives are used as-is, and objects are
 * walked with their path joined by dots.
 */
function addContextAttribute(
  attributes: Attributes,
  key: string,
  value: unknown,
): void {
  if (value == null) return;
  if (Array.isArray(value) || typeof value !== "object") {
    attributes[key] = value as AttributeValue;
    return;
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    addContextAttribute(attributes, `${key}.${nestedKey}`, nestedValue);
  }
}

/**
 * Converts one metadata value to the attribute value used to record it on a
 * span, or undefined when the value cannot be recorded. Strings, numbers, and
 * booleans are recorded as they are; objects (including null and arrays) are
 * serialized to JSON; undefined and any other type are dropped.
 *
 * A request may carry metadata whose values are not strings, and OpenTelemetry
 * attributes cannot hold an arbitrary object, so the two are reconciled here
 * once. Everywhere metadata is put on a span goes through this function, so the
 * spans of a trace record the same value the same way.
 */
export function metadataAttributeValue(
  value: unknown,
): AttributeValue | undefined {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return undefined;
}

/**
 * Splits per-request metadata into the two values a generation call needs to
 * get that metadata onto its spans: the runtime context to pass, and the list
 * telemetry consults to decide which of its properties may be recorded.
 *
 * Telemetry withholds runtime context unless a property is named in the list,
 * so every property carried is named. Each value is reduced to a span attribute
 * by {@link metadataAttributeValue}, and a property whose value has no attribute
 * form is left out of both.
 */
export function runtimeContextFromMetadata(
  metadata: Record<string, unknown> | undefined,
): {
  runtimeContext: Record<string, AttributeValue> | undefined;
  includeRuntimeContext: Record<string, boolean> | undefined;
} {
  if (metadata == null) {
    return { runtimeContext: undefined, includeRuntimeContext: undefined };
  }
  const runtimeContext: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const attribute = metadataAttributeValue(value);
    if (attribute !== undefined) runtimeContext[key] = attribute;
  }
  return {
    runtimeContext,
    includeRuntimeContext: Object.fromEntries(
      Object.keys(runtimeContext).map((key) => [key, true]),
    ),
  };
}

/**
 * Builds the AI SDK telemetry integration that turns generation calls into
 * OpenTelemetry spans.
 *
 * The `ai` package emits no spans by itself: span collection lives in
 * @ai-sdk/otel and only runs once the integration is registered through
 * `registerTelemetry`.
 *
 * `runtimeContext: true` adds the supplemental `ai.settings.context.*`
 * attributes, which is where per-request metadata lands. The OpenInference
 * span processor maps those attributes onto its own `metadata.*` attributes.
 *
 * The supplemental attributes cover the operation and step spans. `enrichSpan`
 * puts the same attributes on the model-call span, which OpenInference labels
 * as the LLM span, so per-request metadata is available on every span of the
 * trace. `enrichSpan` receives the runtime context already filtered by the
 * call's `includeRuntimeContext`.
 *
 * This module has no side effects so it can be exercised against an in-memory
 * exporter; `lib/otel.ts` registers the result against the live provider.
 */
export function createAiSdkTelemetry(tracer: Tracer): OpenTelemetry {
  return new OpenTelemetry({
    tracer,
    runtimeContext: true,
    enrichSpan: ({ spanType, runtimeContext }) => {
      if (spanType !== "languageModel" || runtimeContext == null) {
        return undefined;
      }
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(runtimeContext)) {
        addContextAttribute(attributes, `ai.settings.context.${key}`, value);
      }
      return attributes;
    },
  });
}
