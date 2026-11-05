import { assert, assertEquals, assertRejects } from "@std/assert";
import { normalizeWriterIdentityFile } from "../src/utils/writer-identity-file.ts";
import { transformFiles } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// The claim-minting + provenance-stamping source used across the cases: the
// `typeof saver` type-query mints an `__ctWriterIdentityOf` marker carrying
// this module's writer-identity file spelling.
const CLAIM_SOURCE = `/// <cts-enable />
import { toSchema, WriteAuthorizedBy, handler } from "commonfabric";
const saver = handler({}, {}, () => {});
const s = toSchema<WriteAuthorizedBy<{ title: string }, typeof saver>>();
export { s };
`;

// Production schemas (including profile-home) normally carry writer claims on
// properties behind an interface and user alias. This path is emitted by the
// schema-generator's CommonFabricFormatter, not the direct root special case.
const NESTED_CLAIM_SOURCE = `/// <cts-enable />
import { toSchema, WriteAuthorizedBy, handler } from "commonfabric";
const saver = handler({}, {}, () => {});
type ProtectedTitle = WriteAuthorizedBy<string, typeof saver>;
interface Output { title: ProtectedTitle; }
const s = toSchema<Output>();
export { s };
`;

function markerFile(output: string): string {
  const at = output.indexOf("__ctWriterIdentityOf");
  assert(at >= 0, "expected a writer-identity marker in the output");
  const match = output.slice(at).match(/file:\s*"([^"]+)"/);
  assert(match, "expected a file spelling inside the marker");
  return match[1]!;
}

function bindingSourceFile(output: string): string {
  const match = output.match(/sourceFile:\s*"([^"]+)"/);
  assert(match, "expected binding provenance with a sourceFile");
  return match[1]!;
}

Deno.test("writer-identity file spelling is verbatim without a canonicalizer", () => {
  // Direct compiles (HTTP resolver, piece manifests) hand authored paths
  // straight through; nothing may be guessed away from them. The historical
  // first-segment strip turned this name into "/patterns/system/x.tsx",
  // shearing claims from provenance across compile stacks (labs#4772).
  assertEquals(
    normalizeWriterIdentityFile("/api/patterns/system/x.tsx"),
    "/api/patterns/system/x.tsx",
  );
  assertEquals(
    normalizeWriterIdentityFile("api/patterns/system/x.tsx"),
    "api/patterns/system/x.tsx",
  );
  assertEquals(normalizeWriterIdentityFile("/main.ts"), "/main.ts");
});

Deno.test("canonicalizer runs on the separator-normalized name", () => {
  const seen: string[] = [];
  const result = normalizeWriterIdentityFile(
    "\\load-1\\api\\x.tsx",
    (name) => {
      seen.push(name);
      return name.replace(/^\/load-1/, "");
    },
  );
  assertEquals(seen, ["/load-1/api/x.tsx"]);
  assertEquals(result, "/api/x.tsx");
});

Deno.test("claim spelling: direct absolute compile records the authored path", async () => {
  const fileName = "/api/patterns/system/profile-embed/profile-embed.tsx";
  const output = await transformFiles({ [fileName]: CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
  });
  assertEquals(markerFile(output[fileName]!), fileName);
  // The pre-fix mis-spelling must not appear anywhere in the emitted module.
  assertEquals(
    output[fileName]!.includes(
      '"/patterns/system/profile-embed/profile-embed.tsx"',
    ),
    false,
  );
});

Deno.test("nested claim spelling keeps a direct compile's authored path", async () => {
  const fileName = "/api/patterns/system/profile-home/profile-home.tsx";
  const output = await transformFiles({ [fileName]: NESTED_CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
  });
  assertEquals(markerFile(output[fileName]!), fileName);
});

Deno.test("claim spelling: engine-prefixed compile canonicalizes to the same authored path", async () => {
  // The engine compiles under a per-load `/<id>` prefix and passes its
  // unmapping (storedFilenameFor) as the canonicalizer. The recorded spelling
  // must equal the direct compile's — load-independent and shear-free.
  const fileName =
    "/load-abc123/api/patterns/system/profile-embed/profile-embed.tsx";
  const output = await transformFiles({ [fileName]: CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
    canonicalWriterIdentityFile: (name) =>
      name.startsWith("/load-abc123/")
        ? name.slice("/load-abc123".length)
        : name,
  });
  assertEquals(
    markerFile(output[fileName]!),
    "/api/patterns/system/profile-embed/profile-embed.tsx",
  );
});

Deno.test("claim minting: born stamped with the module's identity when the compiler knows it", async () => {
  // Mint-time identity binding (labs#4772 follow-up): with moduleIdentities
  // supplied (the engine computes them from pristine sources before the TS
  // compile), the emitted claim carries its own module's content-addressed
  // identity — the capturable unstamped state is never minted.
  const fileName = "/api/patterns/system/profile-embed/profile-embed.tsx";
  const output = await transformFiles({ [fileName]: CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
    moduleIdentities: new Map([[fileName, "profile-embed-module-identity"]]),
  });
  const at = output[fileName]!.indexOf("__ctWriterIdentityOf");
  assert(at >= 0, "expected a writer-identity marker");
  const marker = output[fileName]!.slice(at, at + 400);
  const match = marker.match(/moduleIdentity:\s*"([^"]+)"/);
  assert(match, "expected a mint-time moduleIdentity stamp in the marker");
  assertEquals(match[1], "profile-embed-module-identity");
});

Deno.test("nested claims share canonical spelling and stamp with binding provenance", async () => {
  const fileName =
    "/load-abc123/api/patterns/system/profile-home/profile-home.tsx";
  const authoredName = "/api/patterns/system/profile-home/profile-home.tsx";
  const moduleIdentity = "profile-home-module-identity";
  const output = await transformFiles({ [fileName]: NESTED_CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
    canonicalWriterIdentityFile: (name) =>
      name.startsWith("/load-abc123/")
        ? name.slice("/load-abc123".length)
        : name,
    moduleIdentities: new Map([[fileName, moduleIdentity]]),
  });
  const emitted = output[fileName]!;
  const at = emitted.indexOf("__ctWriterIdentityOf");
  assert(at >= 0, "expected a nested writer-identity marker");
  assertEquals(markerFile(emitted), authoredName);
  assertEquals(bindingSourceFile(emitted), authoredName);
  assert(
    emitted.slice(at, at + 500).includes(`moduleIdentity: "${moduleIdentity}"`),
    "expected the nested claim to carry its defining module identity",
  );
});

Deno.test("claim minting: stays unstamped when no module identities are supplied", async () => {
  // Direct compiles without an identity map (older callers, unit harnesses)
  // keep minting unstamped claims; the runner's reconcile-adoption remains
  // their healing path.
  const fileName = "/api/patterns/system/profile-embed/profile-embed.tsx";
  const output = await transformFiles({ [fileName]: CLAIM_SOURCE }, {
    types: COMMONFABRIC_TYPES,
  });
  const at = output[fileName]!.indexOf("__ctWriterIdentityOf");
  assert(at >= 0, "expected a writer-identity marker");
  assertEquals(
    output[fileName]!.slice(at, at + 400).includes("moduleIdentity"),
    false,
  );
});

Deno.test("claim minting: rejects an incomplete supplied identity map", async () => {
  const fileName = "/api/patterns/system/profile-embed/profile-embed.tsx";
  await assertRejects(
    () =>
      transformFiles({ [fileName]: CLAIM_SOURCE }, {
        types: COMMONFABRIC_TYPES,
        moduleIdentities: new Map([["/other.tsx", "other-identity"]]),
      }),
    Error,
    `no module identity for defining source '${fileName}'`,
  );
});
