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

import { assert, assertEquals } from "@std/assert";
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

Deno.test("MEMORY_PUBLIC_URL is an HTTP or HTTPS origin, or nothing", () => {
  const parse = (value: string | undefined) =>
    EnvSchema.safeParse(
      value === undefined ? {} : { MEMORY_PUBLIC_URL: value },
    );

  // Unset or empty: clients open Memory on the API host.
  assertEquals(parse(undefined).data?.MEMORY_PUBLIC_URL, undefined);
  assertEquals(parse("").data?.MEMORY_PUBLIC_URL, undefined);
  // Published as the bare origin, however it is spelled.
  assertEquals(
    parse("https://router.example/").data?.MEMORY_PUBLIC_URL,
    "https://router.example",
  );
  // Anything else fails the parse, which refuses startup, and the reason
  // calls the value a memory URL.
  for (
    const [value, reason] of [
      ["router.example", "Invalid memory URL"],
      ["wss://router.example", "Unsupported memory URL protocol"],
      ["https://router.example/api", "Memory URL must not include a path"],
      [
        "https://user@router.example",
        "Memory URL must not include credentials",
      ],
    ]
  ) {
    const result = parse(value);
    assert(!result.success, value);
    const issue = result.error.issues.find((issue) =>
      issue.path[0] === "MEMORY_PUBLIC_URL"
    );
    assertEquals(
      issue?.message,
      `MEMORY_PUBLIC_URL must be an HTTP or HTTPS origin: ${reason}`,
    );
  }
});

Deno.test("MEMORY_PUBLIC_URL warns about plain http off loopback", () => {
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    const parse = (value: string) =>
      EnvSchema.safeParse({ MEMORY_PUBLIC_URL: value }).data
        ?.MEMORY_PUBLIC_URL;
    // An https page cannot open a ws:// socket, so this one is published
    // with a warning.
    assertEquals(
      parse("http://router.example:9000"),
      "http://router.example:9000",
    );
    assertEquals(warned.length, 1);
    assert(String(warned[0][0]).includes("http://router.example:9000"));
    // Loopback and https are what a local run and a deployment use.
    parse("http://localhost:9000");
    parse("http://127.0.0.1:9000");
    parse("https://router.example");
    assertEquals(warned.length, 1);
  } finally {
    console.warn = warn;
  }
});

Deno.test("API_INTERNAL_URL is `self`, an HTTP or HTTPS origin, or nothing, beside API_URL", () => {
  const parse = (
    value: string | undefined,
    rest: Record<string, string> = {},
  ) =>
    EnvSchema.safeParse({
      API_URL: "https://toolshed.example",
      ...rest,
      ...(value === undefined ? {} : { API_INTERNAL_URL: value }),
    });

  // Unset or empty: the runtimes' requests go to API_URL, as before.
  assertEquals(parse(undefined).data?.API_INTERNAL_URL, undefined);
  assertEquals(parse("  ").data?.API_INTERNAL_URL, undefined);
  // An origin is kept as the bare origin, however it is spelled, and API_URL
  // stays what it was: the public origin is not moved by naming an internal
  // one.
  const set = parse("HTTP://localhost:8080/").data;
  assertEquals(set?.API_INTERNAL_URL, "http://localhost:8080");
  assertEquals(set?.API_URL, "https://toolshed.example");
  assertEquals(
    parse("http://[::1]:8080").data?.API_INTERNAL_URL,
    "http://[::1]:8080",
  );
  // `self` is this process's own listener, HOST and PORT, so one shared
  // .env names each instance of a multi-instance host to itself. A wildcard
  // or loopback bind is reached on its family's loopback literal, since
  // `localhost` may resolve to the other family; a bound address is itself.
  assertEquals(
    parse("self", { PORT: "8007" }).data?.API_INTERNAL_URL,
    "http://127.0.0.1:8007",
  );
  assertEquals(
    parse("self", { PORT: "8007", HOST: "localhost" }).data?.API_INTERNAL_URL,
    "http://127.0.0.1:8007",
  );
  assertEquals(
    parse("self", { PORT: "8007", HOST: "::" }).data?.API_INTERNAL_URL,
    "http://[::1]:8007",
  );
  assertEquals(
    parse("self", { PORT: "8007", HOST: "10.0.0.5" }).data?.API_INTERNAL_URL,
    "http://10.0.0.5:8007",
  );
  assertEquals(
    parse("self", { PORT: "8007", HOST: "fd00::5" }).data?.API_INTERNAL_URL,
    "http://[fd00::5]:8007",
  );
  // Anything else fails the parse, which refuses startup.
  for (
    const [value, reason] of [
      ["not a url", "Invalid API_INTERNAL_URL"],
      // Scheme-less, which URL parsing reads as the scheme `localhost:`.
      ["localhost:8080", "Unsupported API_INTERNAL_URL protocol"],
      ["ws://localhost:8080", "Unsupported API_INTERNAL_URL protocol"],
      [
        "http://localhost:8080/api",
        "API_INTERNAL_URL must not include a path",
      ],
      [
        "http://localhost:8080/?x=1",
        "API_INTERNAL_URL must not include a query",
      ],
      [
        "http://user@localhost:8080",
        "API_INTERNAL_URL must not include credentials",
      ],
      ["Self", "Invalid API_INTERNAL_URL"],
    ]
  ) {
    const result = parse(value);
    assert(!result.success, value);
    const issue = result.error.issues.find((issue) =>
      issue.path[0] === "API_INTERNAL_URL"
    );
    assertEquals(
      issue?.message,
      `API_INTERNAL_URL must be "self" or an HTTP or HTTPS origin: ${reason}`,
    );
  }
});
