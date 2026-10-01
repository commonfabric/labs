import { assertEquals } from "@std/assert";
import { CFC_ATOM_TYPE, CFC_RUNTIME_SUBJECT, cfcAtom } from "./cfc.ts";

void (() => {
  cfcAtom.networkProvenance({
    host: "example.com",
    tls: true,
    // @ts-expect-error Transport digests are strings when supplied.
    requestDigest: 1,
  });
});

Deno.test("cfcAtom.resource builds a resource atom (default and explicit subject/scope)", () => {
  assertEquals(cfcAtom.resource("MyClass"), {
    type: CFC_ATOM_TYPE.Resource,
    class: "MyClass",
    subject: CFC_RUNTIME_SUBJECT,
  });

  const scope = cfcAtom.builtin("scope-source");
  assertEquals(cfcAtom.resource("MyClass", "did:web:example", scope), {
    type: CFC_ATOM_TYPE.Resource,
    class: "MyClass",
    subject: "did:web:example",
    scope,
  });
});

Deno.test("cfcAtom.caveat builds a caveat atom (with and without `by`)", () => {
  const source = cfcAtom.builtin("source");

  assertEquals(cfcAtom.caveat("derived-from", source), {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source,
  });

  const by = cfcAtom.injectionSafe();
  assertEquals(cfcAtom.caveat("derived-from", source, by), {
    type: CFC_ATOM_TYPE.Caveat,
    kind: "derived-from",
    source,
    by,
  });
});

Deno.test("cfcAtom.origin builds an origin confidentiality atom", () => {
  assertEquals(cfcAtom.origin("https://example.com/data", 123), {
    type: CFC_ATOM_TYPE.Origin,
    uri: "https://example.com/data",
    fetchedAt: 123,
  });
  assertEquals(
    cfcAtom.origin("https://example.com/data", 123, "sha256:cert"),
    {
      type: CFC_ATOM_TYPE.Origin,
      uri: "https://example.com/data",
      fetchedAt: 123,
      tlsCertHash: "sha256:cert",
    },
  );
});

Deno.test("cfcAtom.builtin builds a builtin atom", () => {
  assertEquals(cfcAtom.builtin("navigateTo"), {
    type: CFC_ATOM_TYPE.Builtin,
    name: "navigateTo",
  });
});

Deno.test("cfcAtom.injectionSafe builds an injection-safe atom", () => {
  assertEquals(cfcAtom.injectionSafe(), {
    type: CFC_ATOM_TYPE.InjectionSafe,
  });
});

Deno.test("cfcAtom.userSurfaceInput builds a user-surface-input atom", () => {
  assertEquals(cfcAtom.userSurfaceInput("did:key:user", "chat", "digest123"), {
    type: CFC_ATOM_TYPE.UserSurfaceInput,
    user: "did:key:user",
    surface: "chat",
    valueDigest: "digest123",
  });
});

Deno.test("cfcAtom.connectorObserved builds Loom connector evidence", () => {
  assertEquals(
    CFC_ATOM_TYPE.ConnectorObserved,
    "https://loom.commonfabric.org/cfc/atom/ConnectorObserved",
  );
  assertEquals(cfcAtom.connectorObserved("gmail", "connection-1"), {
    type: "https://loom.commonfabric.org/cfc/atom/ConnectorObserved",
    connector: "gmail",
    connection: "connection-1",
  });
  assertEquals(
    cfcAtom.connectorObserved("gmail", "connection-1", "google"),
    {
      type: "https://loom.commonfabric.org/cfc/atom/ConnectorObserved",
      connector: "gmail",
      connection: "connection-1",
      provider: "google",
    },
  );
});

Deno.test("cfcAtom.externalIngest builds an external-ingest atom", () => {
  assertEquals(
    cfcAtom.externalIngest(
      "did:key:channel",
      "did:key:presenter",
      "2026-06-26T12:00:00.000Z",
      "sha256:abc",
    ),
    {
      type: CFC_ATOM_TYPE.ExternalIngest,
      channel: "did:key:channel",
      audience: "did:key:presenter",
      receivedAt: "2026-06-26T12:00:00.000Z",
      valueDigest: "sha256:abc",
    },
  );
});

Deno.test("cfcAtom.externalFetchIngest builds fetch provenance without an audience", () => {
  const atom = cfcAtom.externalFetchIngest(
    {
      url:
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/skills/plaid/SKILL.md",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    "2026-09-01T12:00:00.000Z",
    "sha256:payload",
  );

  assertEquals(atom, {
    type: CFC_ATOM_TYPE.ExternalIngest,
    kind: "fetch",
    pinnedSource: {
      url:
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/skills/plaid/SKILL.md",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    receivedAt: "2026-09-01T12:00:00.000Z",
    valueDigest: "sha256:payload",
  });
  assertEquals(Object.hasOwn(atom, "channel"), false);
  assertEquals(Object.hasOwn(atom, "audience"), false);
});

Deno.test("cfcAtom.networkProvenance builds exact transport evidence", () => {
  assertEquals(
    cfcAtom.networkProvenance({ host: "example.com", tls: false }),
    {
      type: CFC_ATOM_TYPE.NetworkProvenance,
      host: "example.com",
      tls: false,
    },
  );
  assertEquals(
    cfcAtom.networkProvenance({
      host: "example.com",
      tls: true,
      tlsCertHash: "sha256:cert",
      requestDigest: "sha256:request",
      codeHash: "sha256:code",
    }),
    {
      type: CFC_ATOM_TYPE.NetworkProvenance,
      host: "example.com",
      tls: true,
      tlsCertHash: "sha256:cert",
      requestDigest: "sha256:request",
      codeHash: "sha256:code",
    },
  );
});

Deno.test("cfcAtom.promptSlotBound builds a prompt-slot-bound atom", () => {
  const source = cfcAtom.userSurfaceInput("did:key:user", "chat", "digest123");
  assertEquals(
    cfcAtom.promptSlotBound(
      source,
      "instruction",
      "kernel",
      "did:web:example",
      "chat",
      "digest123",
    ),
    {
      type: CFC_ATOM_TYPE.PromptSlotBound,
      source,
      role: "instruction",
      kernelName: "kernel",
      subject: "did:web:example",
      surface: "chat",
      valueDigest: "digest123",
    },
  );
});
