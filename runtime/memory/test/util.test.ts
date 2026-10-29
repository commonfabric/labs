import { assert, assertEquals } from "@std/assert";
import { VerifierIdentity } from "@commonfabric/identity";
import { fromDID } from "../util.ts";
import { alice } from "./principal.ts";

Deno.test("fromDID rejects non-DID strings", async () => {
  const result = await fromDID("not-a-did");

  assert(result.error instanceof SyntaxError);
  assertEquals(
    result.error.message,
    'Invalid DID "not-a-did", must start with "did:"',
  );
});

Deno.test("fromDID rejects DID methods other than did:key", async () => {
  const result = await fromDID("did:web:example.com");

  assert(result.error instanceof SyntaxError);
  assertEquals(
    result.error.message,
    'Invalid DID "did:web:example.com", only "did:key:" are supported right now',
  );
});

Deno.test("fromDID wraps did:key parser errors as syntax errors", async () => {
  const unsupportedDid =
    "did:key:z6DtMrg4Kv51UMAM8vJcCLcRywJfEB4dpHVxPCR6qm6hSV3N";

  const result = await fromDID(unsupportedDid);

  assert(result.error instanceof SyntaxError);
  assertEquals(
    result.error.message,
    `Invalid DID "${unsupportedDid}", RangeError: Unsupported key algorithm expected 0xed, instead of 0xe7`,
  );
});

Deno.test("fromDID parses a valid did:key into a verifier", async () => {
  const did = alice.did();

  const result = await fromDID(did);

  assert(result.ok instanceof VerifierIdentity);
  assertEquals(result.ok.did(), did);
});
