/**
 * Parsing tests for toolshed's `EnvSchema`: strict-boolean flags and
 * defaulted variables, pinned against the misparse their types invite.
 *
 * The EXPERIMENTAL_* → ExperimentalOptions mapping (including its tri-state
 * unset/true/false fidelity) now lives in the runner's canonical
 * `experimentalOptionsFromEnv` / `EXPERIMENTAL_ENV_VARS` (CT-1814), shared by
 * toolshed and the CLI; its coverage lives in
 * `packages/runner/test/runtime-presets.test.ts`.
 */

import { assertEquals } from "@std/assert";
import { EnvSchema } from "@/env.ts";

Deno.test("OTEL_ENABLED parses strictly: only 'true'/'1' enable telemetry", () => {
  // Regression guard for the z.coerce.boolean() footgun: Boolean("false") ===
  // true, which would silently enable telemetry (and, with the all-span
  // exporter, ship every HTTP request span) when an operator set
  // OTEL_ENABLED=false to disable it.

  const otel = (v: string | undefined) =>
    EnvSchema.parse(v === undefined ? {} : { OTEL_ENABLED: v }).OTEL_ENABLED;

  assertEquals(otel("true"), true);
  assertEquals(otel("1"), true);

  // The cases the old z.coerce.boolean() got wrong:
  assertEquals(otel("false"), false);
  assertEquals(otel("0"), false);
  assertEquals(otel("no"), false);

  // Unset must default to off.
  assertEquals(otel(undefined), false);
});

Deno.test("DISABLE_LOG_REQ_RES / PLAID_SYNC_ALL_TRANSACTIONS parse strictly", () => {
  // The sibling boolean flags use the strict boolFlag() parse rather than
  // z.coerce.boolean(), which reads "false" as true. Guard them so they
  // can't silently regress.

  const flag = (key: string, v: string | undefined) =>
    (EnvSchema.parse(v === undefined ? {} : { [key]: v }) as Record<
      string,
      unknown
    >)[key];

  for (const key of ["DISABLE_LOG_REQ_RES", "PLAID_SYNC_ALL_TRANSACTIONS"]) {
    assertEquals(flag(key, "true"), true);
    assertEquals(flag(key, "1"), true);
    assertEquals(flag(key, "false"), false); // previously coerced to true
    assertEquals(flag(key, "0"), false);
    assertEquals(flag(key, undefined), false);
  }
});

Deno.test("MEMORY_ACL_MODE defaults to enforce and accepts rollout overrides", () => {
  const aclMode = (value: string | undefined) =>
    EnvSchema.parse(
      value === undefined ? {} : { MEMORY_ACL_MODE: value },
    ).MEMORY_ACL_MODE;

  assertEquals(aclMode(undefined), "enforce");
  assertEquals(aclMode("off"), "off");
  assertEquals(aclMode("observe"), "observe");
  assertEquals(aclMode("enforce"), "enforce");
});

Deno.test("INGEST_SELF_SERVE_ENABLED is off unless explicitly enabled", () => {
  // The self-serve ingest control plane must be OFF unless a deployment opts
  // in. Minting issues a durable, operator-backed append capability, and on a
  // deployment where named-space keys derive from a public passphrase anyone
  // who knows a space NAME can mint legitimately — which repairing the
  // derivation later does not retract. A default-on flag here would be a
  // production takeover primitive, so the default is the security property.

  const flag = (v: string | undefined) =>
    EnvSchema.parse(v === undefined ? {} : { INGEST_SELF_SERVE_ENABLED: v })
      .INGEST_SELF_SERVE_ENABLED;

  assertEquals(flag(undefined), false);
  assertEquals(flag("false"), false);
  assertEquals(flag("0"), false);
  // The z.coerce.boolean() footgun would have made this `true`.
  assertEquals(flag("no"), false);

  assertEquals(flag("true"), true);
  assertEquals(flag("1"), true);
});
