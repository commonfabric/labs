import { assertEquals, assertFalse } from "@std/assert";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";

//
// Epic B1: mint helpers for the exchange-rule atom families (spec §15).
// Every helper is exercised with optionals absent AND present: minted atoms
// compare by structural equality over canonical JSON, so an absent optional
// must be truly absent (never an explicit-undefined key), and a supplied one
// must land verbatim.
//

Deno.test("cfcAtom mints confidentiality principals and Expires", () => {
  assertEquals(cfcAtom.user("did:key:alice"), {
    type: CFC_ATOM_TYPE.User,
    subject: "did:key:alice",
  });
  assertEquals(cfcAtom.space("space:x"), {
    type: CFC_ATOM_TYPE.Space,
    id: "space:x",
  });
  assertEquals(cfcAtom.expires(1234), {
    type: CFC_ATOM_TYPE.Expires,
    timestamp: 1234,
  });
});

Deno.test("cfcAtom mints hash-bound policy references (spec §4.4.2)", () => {
  assertEquals(cfcAtom.policyRef("share-flow", "did:key:alice", "h1"), {
    type: CFC_ATOM_TYPE.Policy,
    name: "share-flow",
    subject: "did:key:alice",
    hash: "h1",
  });
  assertEquals(cfcAtom.contextRef("primary", "did:key:alice", "h2"), {
    type: CFC_ATOM_TYPE.Context,
    name: "primary",
    subject: "did:key:alice",
    hash: "h2",
  });
});

Deno.test("cfcAtom mints exact module-policy references (spec §4.4.2)", () => {
  assertEquals(
    cfcAtom.modulePolicyRef(
      "sha256:module",
      "releaseRules",
      "sha256:manifest",
      "did:key:alice",
    ),
    {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: "sha256:module",
      symbol: "releaseRules",
      policyDigest: "sha256:manifest",
      subject: "did:key:alice",
    },
  );
});

Deno.test("cfcAtom mints HasRole facts", () => {
  assertEquals(cfcAtom.hasRole("did:key:alice", "space:x", "reader"), {
    type: CFC_ATOM_TYPE.HasRole,
    principal: "did:key:alice",
    space: "space:x",
    role: "reader",
  });
});

Deno.test("cfcAtom.boundaryContext omits absent optionals", () => {
  assertEquals(cfcAtom.boundaryContext("sinkClass"), {
    type: CFC_ATOM_TYPE.BoundaryContext,
    key: "sinkClass",
  });
  assertEquals(cfcAtom.boundaryContext("sink", "fetchData"), {
    type: CFC_ATOM_TYPE.BoundaryContext,
    key: "sink",
    value: "fetchData",
  });
  assertEquals(
    cfcAtom.boundaryContext("intent", undefined, { "/": "intent-doc" }),
    {
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "intent",
      ref: { "/": "intent-doc" },
    },
  );
});

Deno.test("cfcAtom.caveatScreened prunes undefined optionals, keeps supplied ones", () => {
  const source = { "/": "src-doc" };
  const detector = cfcAtom.builtin("detector-v1");
  const minimal = cfcAtom.caveatScreened({
    kind: "prompt-injection-risk-unscreened",
    source,
    stage: "ingress",
    detector,
    verdict: "pass",
    valueRef: undefined,
    profileHash: undefined,
    screenedAt: undefined,
  });
  assertEquals(minimal, {
    type: CFC_ATOM_TYPE.CaveatScreened,
    kind: "prompt-injection-risk-unscreened",
    source,
    stage: "ingress",
    detector,
    verdict: "pass",
  });
  assertFalse(Object.hasOwn(minimal, "valueRef"));

  const full = cfcAtom.caveatScreened({
    kind: "prompt-injection-risk-unscreened",
    source,
    stage: "value",
    detector,
    verdict: "pass",
    valueRef: { "/": "value-ref" },
    profileHash: "sha256:profile",
    screenedAt: 99,
  });
  assertEquals(full.valueRef, { "/": "value-ref" });
  assertEquals(full.profileHash, "sha256:profile");
  assertEquals(full.screenedAt, 99);
});

Deno.test("cfcAtom.disclosureRendered / disclosureAcknowledged mint render-bound evidence", () => {
  const source = { "/": "src-doc" };
  const renderRef = { seq: 7, rootRef: { "/": "root" } };
  const rendered = cfcAtom.disclosureRendered({
    kind: "warning",
    source,
    sink: "display",
    renderRef,
    snapshotDigest: "sha256:snap",
  });
  assertEquals(rendered.type, CFC_ATOM_TYPE.DisclosureRendered);
  assertFalse(Object.hasOwn(rendered, "user"));
  const renderedFor = cfcAtom.disclosureRendered({
    kind: "warning",
    source,
    sink: "display",
    renderRef,
    snapshotDigest: "sha256:snap",
    user: "did:key:alice",
  });
  assertEquals(renderedFor.user, "did:key:alice");

  const acknowledged = cfcAtom.disclosureAcknowledged({
    user: "did:key:alice",
    kind: "warning",
    source,
    renderRef,
    snapshotDigest: "sha256:snap",
  });
  assertEquals(acknowledged.type, CFC_ATOM_TYPE.DisclosureAcknowledged);
  assertFalse(Object.hasOwn(acknowledged, "sink"));
  assertEquals(
    cfcAtom.disclosureAcknowledged({
      user: "did:key:alice",
      kind: "warning",
      source,
      renderRef,
      snapshotDigest: "sha256:snap",
      sink: "display",
    }).sink,
    "display",
  );
});

Deno.test("cfcAtom.disclaimerAttached mints sink-emission evidence", () => {
  const source = { "/": "src-doc" };
  const attached = cfcAtom.disclaimerAttached({
    sink: "sendMail",
    kind: "external-content",
    source,
    disclaimerDigest: "sha256:disclaimer",
  });
  assertEquals(attached.type, CFC_ATOM_TYPE.DisclaimerAttached);
  assertFalse(Object.hasOwn(attached, "formatter"));
  assertEquals(
    cfcAtom.disclaimerAttached({
      sink: "sendMail",
      kind: "external-content",
      source,
      disclaimerDigest: "sha256:disclaimer",
      formatter: cfcAtom.builtin("formatter-v1"),
    }).formatter,
    cfcAtom.builtin("formatter-v1"),
  );
});

Deno.test("cfcAtom.caveatAssessment mints scoped assessor judgments", () => {
  const source = { "/": "src-doc" };
  const assessor = cfcAtom.builtin("assessor-v1");
  const minimal = cfcAtom.caveatAssessment({
    kind: "warning",
    source,
    assessor,
    evidenceDigest: "sha256:evidence",
    result: "supported",
  });
  assertEquals(minimal.type, CFC_ATOM_TYPE.CaveatAssessment);
  for (const absent of ["sink", "intentId", "purpose", "assessedAt"]) {
    assertFalse(Object.hasOwn(minimal, absent));
  }
  const full = cfcAtom.caveatAssessment({
    kind: "warning",
    source,
    assessor,
    evidenceDigest: "sha256:evidence",
    result: "rejected",
    sink: "sendMail",
    intentId: { "/": "intent" },
    purpose: "routing",
    assessedAt: 42,
  });
  assertEquals(full.sink, "sendMail");
  assertEquals(full.intentId, { "/": "intent" });
  assertEquals(full.purpose, "routing");
  assertEquals(full.assessedAt, 42);
});
