import { assertEquals } from "@std/assert";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  cfcResultFromRunscSidecar,
  deniedCfcResult,
  DIRECT_RUNSC_CFC_RESULT_READER,
  DOCKER_RUNSC_CFC_RESULT_READER,
  type RunscCfcResultReader,
} from "../src/sandbox/runsc-cfc-result.ts";

const command = { stdout: "out\n", stderr: "err\n", exitCode: 0 };

Deno.test("cfcResultFromRunscSidecar denies an unsupported version", () => {
  const r = cfcResultFromRunscSidecar(
    { version: 2, containerId: "c1", cfcTaint: {} },
    "c1",
    command,
  );
  assertEquals(r.stdout.policy, "denied");
  assertEquals(r.diagnostics?.[0]?.code, "runsc_cfc_sidecar_version");
});

Deno.test("cfcResultFromRunscSidecar denies a result for another container", () => {
  const r = cfcResultFromRunscSidecar(
    { version: 1, containerId: "other", cfcTaint: {} },
    "c1",
    command,
  );
  assertEquals(r.exitCode.policy, "denied");
  assertEquals(
    r.diagnostics?.[0]?.code,
    "runsc_cfc_sidecar_container_mismatch",
  );
  assertEquals(r.diagnostics?.[0]?.details?.actualContainerId, "other");
});

Deno.test("cfcResultFromRunscSidecar denies a result with no taint", () => {
  const r = cfcResultFromRunscSidecar(
    { version: 1, containerId: "c1" },
    "c1",
    command,
  );
  assertEquals(r.diagnostics?.[0]?.code, "runsc_cfc_sidecar_missing_taint");
});

Deno.test("cfcResultFromRunscSidecar observes a public taint and withholds a confidential one", () => {
  const pub = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      sandboxId: "c1",
      waitStatus: 0,
      cfcTaint: { string: "{conf: ⊤, integ: ∅}", xattrJSON: {} },
    },
    "c1",
    command,
  );
  assertEquals(pub.stdout.policy, "observed");
  if (pub.stdout.policy === "observed") {
    assertEquals(pub.stdout.segments[0]?.text, "out\n");
  }
  assertEquals(pub.exitCode.policy, "observed");
  assertEquals(pub.diagnostics?.[0]?.details?.sandboxId, "c1");
  assertEquals(pub.diagnostics?.[0]?.details?.waitStatus, 0);

  const label = {
    confidentiality: [{
      subject: "did:key:alice",
      type: "gvisor.dev/gvisor/cfc/atom",
      typeCode: 1,
    }],
  };
  const secret = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      cfcTaint: {
        string: "{conf: User(did:key:alice), integ: ∅}",
        xattrJSON: label,
      },
    },
    "c1",
    command,
  );
  assertEquals(secret.stdout.policy, "opaque");
  assertEquals(secret.stderr.policy, "opaque");
  assertEquals(secret.exitCode.policy, "opaque");
  assertEquals(secret.stdout.label, label);
  if (secret.stdout.policy === "opaque") {
    assertEquals(secret.stdout.byteLength, 4);
  }
  assertEquals(
    secret.diagnostics?.[0]?.details?.runscTaint,
    "{conf: User(did:key:alice), integ: ∅}",
  );
});

Deno.test("deniedCfcResult denies every channel with the reason", () => {
  const r = deniedCfcResult("code_x", "why", { k: "v" });
  assertEquals(r.stdout.policy, "denied");
  assertEquals(r.stderr.policy, "denied");
  assertEquals(r.exitCode.policy, "denied");
  assertEquals(r.diagnostics?.[0]?.details?.k, "v");
});

Deno.test("cfcResultFromRunscSidecar denies a malformed taint rather than reading it as public", () => {
  for (
    const cfcTaint of [
      {},
      { string: 7 },
      { xattrJSON: "not-an-object" },
      { string: "{conf: ⊤, integ: ∅}", xattrJSON: ["x"] },
    ]
  ) {
    const r = cfcResultFromRunscSidecar(
      { version: 1, containerId: "c1", cfcTaint } as Parameters<
        typeof cfcResultFromRunscSidecar
      >[0],
      "c1",
      command,
    );
    assertEquals(r.stdout.policy, "denied", JSON.stringify(cfcTaint));
    assertEquals(r.diagnostics?.[0]?.code, "runsc_cfc_sidecar_malformed_taint");
  }
});

// ---------------------------------------------------------------------------
// The verdict table.
//
// Every row names the verdict for the direct runsc driver and for the Docker
// driver. They differ in exactly one respect (see `RunscCfcResultReader`):
// beside an `xattrJSON` object the Docker driver accepts any non-blank
// `string`, as main did, where the direct driver requires runsc's own
// spelling of the empty label.
// ---------------------------------------------------------------------------

type Verdict = "observed" | "opaque" | "denied";

const EMPTY = "{conf: ⊤, integ: ∅}";
const ALICE = "{conf: User(did:key:alice), integ: ∅}";
const aliceAtom = { subject: "did:key:alice" };

interface VerdictRow {
  name: string;
  cfcTaint: unknown;
  direct: Verdict;
  docker: Verdict;
}

const same = (
  name: string,
  cfcTaint: unknown,
  verdict: Verdict,
): VerdictRow => ({ name, cfcTaint, direct: verdict, docker: verdict });

const VERDICT_TABLE: VerdictRow[] = [
  // What runsc writes.
  same(
    "what runsc writes for a public result",
    { string: EMPTY, xattrJSON: {} },
    "observed",
  ),
  same("what runsc writes for a confidential result", {
    string: ALICE,
    xattrJSON: { confidentiality: [aliceAtom] },
  }, "opaque"),
  same("an integrity claim alone", {
    string: "{conf: ⊤, integ: {did:key:bob}}",
    xattrJSON: { integrity: [{ subject: "did:key:bob" }] },
  }, "opaque"),
  same("empty arrays written out", {
    string: EMPTY,
    xattrJSON: { confidentiality: [], integrity: [] },
  }, "observed"),
  same("the xattr form alone, empty", { xattrJSON: {} }, "observed"),

  // No representation at all, or one of the wrong type: denied.
  same("an empty taint", {}, "denied"),
  same("a null xattrJSON", { string: EMPTY, xattrJSON: null }, "denied"),
  same("an array xattrJSON", { string: "x", xattrJSON: [] }, "denied"),
  same("a string xattrJSON", { xattrJSON: "not-an-object" }, "denied"),
  same("a number string", { string: 5, xattrJSON: {} }, "denied"),
  same("a number string alone", { string: 7 }, "denied"),

  // The string form alone is never public, whatever it spells.
  same("the empty spelling with no xattrJSON", { string: EMPTY }, "opaque"),
  same("an empty string alone", { string: "" }, "opaque"),
  same("a whitespace string alone", { string: "  \n" }, "opaque"),
  same("a bare-braces string alone", { string: "{}" }, "opaque"),
  same("a tainted string alone", { string: ALICE }, "opaque"),

  // Both forms present: a blank string is never public.
  same(
    "an empty string beside an empty xattr",
    { string: "", xattrJSON: {} },
    "opaque",
  ),
  same(
    "a whitespace string beside an empty xattr",
    { string: " \t\n", xattrJSON: {} },
    "opaque",
  ),

  // Both forms present and they disagree. The one place the drivers differ.
  {
    name: "a tainted string beside an empty xattr",
    cfcTaint: { string: ALICE, xattrJSON: {} },
    direct: "opaque",
    docker: "observed",
  },
  {
    name: "an unfamiliar spelling beside an empty xattr",
    cfcTaint: { string: "{conf: public, integ: empty}", xattrJSON: {} },
    direct: "opaque",
    docker: "observed",
  },
  {
    name: "the empty spelling, padded, beside an empty xattr",
    cfcTaint: { string: ` ${EMPTY}\n`, xattrJSON: {} },
    direct: "opaque",
    docker: "observed",
  },
  same("the empty spelling beside a tainted xattr", {
    string: EMPTY,
    xattrJSON: { confidentiality: [aliceAtom] },
  }, "opaque"),
  same("the empty spelling beside an integrity-tainted xattr", {
    string: EMPTY,
    xattrJSON: { integrity: [aliceAtom] },
  }, "opaque"),

  // `confidentiality` / `integrity` present and not an array: unreadable.
  same("an object confidentiality", {
    string: EMPTY,
    xattrJSON: { confidentiality: {} },
  }, "denied"),
  same("an object confidentiality holding an empty array", {
    string: EMPTY,
    xattrJSON: { confidentiality: { a: [] } },
  }, "denied"),
  same("a primitive confidentiality", {
    string: EMPTY,
    xattrJSON: { confidentiality: "secret" },
  }, "denied"),
  same("a null confidentiality", {
    string: EMPTY,
    xattrJSON: { confidentiality: null },
  }, "denied"),
  same("an object integrity", {
    string: EMPTY,
    xattrJSON: { integrity: {} },
  }, "denied"),
  same("a primitive integrity", {
    string: EMPTY,
    xattrJSON: { confidentiality: [], integrity: 0 },
  }, "denied"),

  // Keys runsc does not write: not evidence of an empty label.
  same("unfamiliar keys with empty values", {
    string: EMPTY,
    xattrJSON: { conf: [], labels: {} },
  }, "opaque"),
  same("one unfamiliar key holding an empty array", {
    string: EMPTY,
    xattrJSON: { conf: [] },
  }, "opaque"),
  same("an unfamiliar key beside empty known ones", {
    string: EMPTY,
    xattrJSON: { confidentiality: [], integrity: [], extra: { inner: [] } },
  }, "opaque"),
  same("an unfamiliar key holding a primitive", {
    string: EMPTY,
    xattrJSON: { extra: "secret" },
  }, "opaque"),
  same("an unfamiliar key holding a nested object with content", {
    string: EMPTY,
    xattrJSON: { extra: { inner: [{ subject: "x" }] } },
  }, "opaque"),
];

const verdictOf = (
  cfcTaint: unknown,
  reader?: RunscCfcResultReader,
): Verdict => {
  const r = cfcResultFromRunscSidecar(
    { version: 1, containerId: "c1", cfcTaint },
    "c1",
    command,
    ...(reader !== undefined ? [reader] as const : []),
  );
  // The three channels always carry one verdict between them.
  assertEquals(r.stderr.policy, r.stdout.policy);
  assertEquals(r.exitCode.policy, r.stdout.policy);
  return r.stdout.policy;
};

Deno.test("cfcResultFromRunscSidecar verdict table, direct runsc driver", () => {
  for (const row of VERDICT_TABLE) {
    assertEquals(
      verdictOf(row.cfcTaint, DIRECT_RUNSC_CFC_RESULT_READER),
      row.direct,
      `${row.name}: ${JSON.stringify(row.cfcTaint)}`,
    );
    // The direct driver calls the parser with no reader; that is the same
    // reading, not a third one.
    assertEquals(verdictOf(row.cfcTaint), row.direct, row.name);
  }
});

Deno.test("cfcResultFromRunscSidecar verdict table, Docker driver", () => {
  for (const row of VERDICT_TABLE) {
    assertEquals(
      verdictOf(row.cfcTaint, DOCKER_RUNSC_CFC_RESULT_READER),
      row.docker,
      `${row.name}: ${JSON.stringify(row.cfcTaint)}`,
    );
  }
});

// main's predicate, copied verbatim from `docker-runsc.ts` as it stood before
// the parser moved (blob d972ceeff on origin/main). It is the oracle for "never more
// permissive than main", so it must stay main's code and not track the
// parser's.
const mainHasNonEmptyXattrValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isObjectNotArray(value)) {
    return Object.values(value).some(mainHasNonEmptyXattrValue);
  }
  return value !== undefined && value !== null;
};
const mainIsPublicRunscTaint = (
  taint: { string?: unknown; xattrJSON?: unknown },
): boolean => {
  if (isObjectNotArray(taint.xattrJSON)) {
    return !Object.values(taint.xattrJSON).some(mainHasNonEmptyXattrValue);
  }
  const stringValue = typeof taint.string === "string"
    ? taint.string.trim()
    : "";
  return stringValue.length === 0 || stringValue === "{}";
};

Deno.test("cfcResultFromRunscSidecar observes nothing main withheld, on either driver", () => {
  let observedRows = 0;
  let mainPublicRows = 0;
  for (const row of VERDICT_TABLE) {
    const mainPublic = mainIsPublicRunscTaint(
      row.cfcTaint as { string?: unknown; xattrJSON?: unknown },
    );
    if (mainPublic) mainPublicRows++;
    for (
      const reader of [
        DIRECT_RUNSC_CFC_RESULT_READER,
        DOCKER_RUNSC_CFC_RESULT_READER,
      ]
    ) {
      if (verdictOf(row.cfcTaint, reader) === "observed") {
        observedRows++;
        assertEquals(
          mainPublic,
          true,
          `${row.name}: observed where main withheld`,
        );
      }
    }
  }
  // The property is only worth something if the table holds both kinds of
  // row: shapes main withheld (which could be wrongly observed) and shapes
  // that are observed at all.
  assertEquals(observedRows > 0, true);
  assertEquals(mainPublicRows < VERDICT_TABLE.length, true);
  // The row the move got wrong: main withheld it, the moved parser showed it.
  assertEquals(mainIsPublicRunscTaint({ string: EMPTY }), false);
});

Deno.test("cfcResultFromRunscSidecar names the container id the way the driver does", () => {
  const mismatch = (reader?: RunscCfcResultReader) =>
    cfcResultFromRunscSidecar(
      { version: 1, containerId: "other", cfcTaint: {} },
      "c1",
      command,
      ...(reader !== undefined ? [reader] as const : []),
    ).diagnostics?.[0]?.message;
  // main's wording, which the Docker driver keeps.
  assertEquals(
    mismatch(DOCKER_RUNSC_CFC_RESULT_READER),
    "runsc CFC result sidecar did not match the Docker container ID",
  );
  assertEquals(
    mismatch(DIRECT_RUNSC_CFC_RESULT_READER),
    "runsc CFC result sidecar did not match the container ID",
  );
  assertEquals(
    mismatch(),
    "runsc CFC result sidecar did not match the container ID",
  );
});

Deno.test("cfcResultFromRunscSidecar carries the readable part of a withheld label", () => {
  const r = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      cfcTaint: {
        string: "{conf: ⊤, integ: {did:key:bob}}",
        xattrJSON: { integrity: [{ subject: "did:key:bob" }] },
      },
    },
    "c1",
    command,
  );
  assertEquals(r.stdout.policy, "opaque");
  assertEquals(r.stdout.label, { integrity: [{ subject: "did:key:bob" }] });
});
