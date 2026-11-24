// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.
//
// A real ceremony needs an authenticator and a user gesture, so these cases
// hand `PassKey` a host whose credential store answers as an authenticator
// would, and record what it was asked.

import { expect } from "@std/expect";

import { Identity } from "../src/identity.ts";
import { PassKey, type PassKeyHost } from "../src/pass-key.ts";

/** What the stand-in authenticator hands back: a credential, or nothing. */
type Answer = { id: string; prf?: AuthenticationExtensionsPRFOutputs } | null;

/**
 * A host for relying party `example.test` whose credential store answers
 * every request with `answer`, and the options each request carried.
 */
function hostAnswering(answer: Answer) {
  const created: CredentialCreationOptions[] = [];
  const got: CredentialRequestOptions[] = [];
  const credential = answer === null ? null : {
    id: answer.id,
    type: "public-key",
    getClientExtensionResults: () => ({ prf: answer.prf }),
  };
  const host: PassKeyHost = {
    rpId: "example.test",
    credentials: {
      create: (options) => {
        created.push(options ?? {});
        return Promise.resolve(credential);
      },
      get: (options) => {
        got.push(options ?? {});
        return Promise.resolve(credential);
      },
    },
  };
  return { host, created, got };
}

const SEED = new Uint8Array(32).map((_, i) => i);

Deno.test("PassKey.create() asks for a discoverable key with PRF for the host's relying party", async () => {
  const { host, created } = hostAnswering({
    id: "cred-1",
    prf: { enabled: true },
  });

  const passKey = await PassKey.create("ada", "Ada", host);

  expect(passKey.id()).toBe("cred-1");
  const publicKey = created[0]?.publicKey;
  expect(publicKey?.rp).toEqual({ id: "example.test", name: "Common Fabric" });
  expect(publicKey?.user.name).toBe("ada");
  expect(publicKey?.user.displayName).toBe("Ada");
  expect(publicKey?.authenticatorSelection?.residentKey).toBe("required");
  expect(publicKey?.extensions?.prf?.eval?.first).toEqual(
    new TextEncoder().encode("PRF_SALT"),
  );
});

Deno.test("PassKey.create() throws when no credential is made, or one is made without PRF", async () => {
  await expect(PassKey.create("ada", "Ada", hostAnswering(null).host))
    .rejects.toThrow("Could not create passkey");
  await expect(
    PassKey.create("ada", "Ada", hostAnswering({ id: "cred-1" }).host),
  ).rejects.toThrow("prf extension not supported");
  await expect(
    PassKey.create(
      "ada",
      "Ada",
      hostAnswering({ id: "cred-1", prf: { enabled: false } }).host,
    ),
  ).rejects.toThrow("prf extension not supported");
});

Deno.test("PassKey.createRootKey() throws for a passkey that was just created", async () => {
  // Creation reports PRF as enabled but carries no PRF output.
  const { host } = hostAnswering({ id: "cred-1", prf: { enabled: true } });
  const passKey = await PassKey.create("ada", "Ada", host);

  await expect(passKey.createRootKey()).rejects.toThrow("No PRF found");
});

Deno.test("PassKey.get() asks the host's relying party for a credential with PRF, as the options say", async () => {
  const { host, got } = hostAnswering({
    id: "cred-2",
    prf: { results: { first: SEED.buffer } },
  });
  const allowCredentials: PublicKeyCredentialDescriptor[] = [
    { type: "public-key", id: new Uint8Array([1, 2, 3]) },
  ];

  const passKey = await PassKey.get(
    {
      mediation: "conditional",
      userVerification: "required",
      allowCredentials,
    },
    host,
  );
  const defaulted = await PassKey.get(undefined, host);

  expect([passKey.id(), defaulted.id()]).toEqual(["cred-2", "cred-2"]);
  expect(got[0]?.mediation).toBe("conditional");
  expect(got[0]?.publicKey?.rpId).toBe("example.test");
  expect(got[0]?.publicKey?.userVerification).toBe("required");
  expect(got[0]?.publicKey?.allowCredentials).toEqual(allowCredentials);
  expect(got[1]?.mediation).toBeUndefined();
  expect(got[1]?.publicKey?.userVerification).toBe("preferred");
  expect(got[1]?.publicKey?.allowCredentials).toEqual([]);
});

Deno.test("PassKey.get() throws when no credential is found, or one is found without PRF output", async () => {
  await expect(PassKey.get({}, hostAnswering(null).host)).rejects.toThrow(
    "Could not create credentials",
  );
  await expect(
    PassKey.get({}, hostAnswering({ id: "cred-2", prf: {} }).host),
  ).rejects.toThrow("prf extension not supported");
});

Deno.test("PassKey.createRootKey() returns the identity whose seed is the PRF output", async () => {
  const expected = (await Identity.fromRaw(SEED)).did();
  // The output as an `ArrayBuffer`, and as a view into a larger buffer.
  const padded = new Uint8Array(40);
  padded.set(SEED, 4);
  for (const first of [SEED.buffer, padded.subarray(4, 36)]) {
    const { host } = hostAnswering({
      id: "cred-2",
      prf: { results: { first } },
    });
    const passKey = await PassKey.get({}, host);

    expect((await passKey.createRootKey()).did()).toBe(expected);
  }
});
