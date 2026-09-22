import { assertEquals } from "@std/assert";

import {
  cfcResultFromRunscSidecar,
  deniedCfcResult,
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

Deno.test("cfcResultFromRunscSidecar reads nested and string-only taints", () => {
  // A nested xattr with only empty leaves is still public.
  const nestedEmpty = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      cfcTaint: {
        xattrJSON: { confidentiality: [], integrity: [], extra: { inner: [] } },
      },
    },
    "c1",
    command,
  );
  assertEquals(nestedEmpty.stdout.policy, "observed");

  // An integrity claim alone is a non-public taint and is carried on the label.
  const integ = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      cfcTaint: { xattrJSON: { integrity: [{ subject: "did:key:bob" }] } },
    },
    "c1",
    command,
  );
  assertEquals(integ.stdout.policy, "opaque");
  assertEquals(integ.stdout.label, { integrity: [{ subject: "did:key:bob" }] });

  // With no xattr form, the string form decides: empty means public.
  const stringPublic = cfcResultFromRunscSidecar(
    { version: 1, containerId: "c1", cfcTaint: { string: "{}" } },
    "c1",
    command,
  );
  assertEquals(stringPublic.stdout.policy, "observed");
  const stringTainted = cfcResultFromRunscSidecar(
    {
      version: 1,
      containerId: "c1",
      cfcTaint: { string: "{conf: User(did:key:alice)}" },
    },
    "c1",
    command,
  );
  assertEquals(stringTainted.stdout.policy, "opaque");
});
