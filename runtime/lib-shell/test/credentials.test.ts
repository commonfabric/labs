import { assertEquals, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSPHRASE,
  clearStoredCredential,
  createKeyFileCredential,
  createPasskeyCredential,
  createPassphraseCredential,
  getPublicKeyCredentialDescriptor,
  getStoredCredential,
  saveCredential,
} from "@commonfabric/lib-shell/credentials";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function withMockLocalStorage(fn: () => void | Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });

  return Promise.resolve(fn()).finally(() => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}

Deno.test("keyfile credentials persist the imported DID and auth method", () =>
  withMockLocalStorage(() => {
    const did = "did:key:z6MkTest";
    const credential = createKeyFileCredential(did);

    saveCredential(credential);

    assertEquals(getStoredCredential(), {
      id: did,
      method: AUTH_METHOD_KEYFILE,
    });

    clearStoredCredential();
    assertEquals(getStoredCredential(), null);
  }));

Deno.test("malformed stored credentials are ignored", () =>
  withMockLocalStorage(() => {
    localStorage.setItem("storedCredential", "{not-json");
    assertEquals(getStoredCredential(), null);

    localStorage.setItem(
      "storedCredential",
      JSON.stringify({ id: "abc", method: "unknown" }),
    );
    assertEquals(getStoredCredential(), null);
  }));

Deno.test("malformed passkey credential IDs are ignored", () =>
  withMockLocalStorage(() => {
    assertEquals(
      getPublicKeyCredentialDescriptor(createPasskeyCredential("not base64!")),
      undefined,
    );
  }));

Deno.test("passkey credential IDs decode from base64url into descriptor bytes", () => {
  // "-_8" is unpadded base64url for the bytes 0xfb 0xff, spelled "+/8=" in
  // base64.
  expect(
    getPublicKeyCredentialDescriptor(createPasskeyCredential("-_8")),
  ).toEqual({ id: new Uint8Array([0xfb, 0xff]), type: "public-key" });
});

Deno.test("non-passkey credentials have no public key descriptor", () => {
  expect(getPublicKeyCredentialDescriptor(null)).toBeUndefined();
  expect(
    getPublicKeyCredentialDescriptor(createKeyFileCredential("did:key:z6Mk")),
  ).toBeUndefined();
});

Deno.test("passphrase credentials carry a fresh random ID each", () => {
  const first = createPassphraseCredential();
  const second = createPassphraseCredential();

  expect(first.method).toBe(AUTH_METHOD_PASSPHRASE);
  expect(first.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(second.id).not.toBe(first.id);
});

Deno.test("PKCS8 keyfile import primitives round-trip into stored keyfile credential", () =>
  withMockLocalStorage(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const imported = await Identity.fromPkcs8(identity.toPkcs8());

    assertEquals(imported.did(), identity.did());

    saveCredential(createKeyFileCredential(imported.did()));

    const stored = getStoredCredential();
    assertExists(stored);
    assertEquals(stored.method, AUTH_METHOD_KEYFILE);
    assertEquals(stored.id, imported.did());
  }));
