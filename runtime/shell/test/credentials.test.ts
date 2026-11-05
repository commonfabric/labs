import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";

import {
  AUTH_METHOD_KEYFILE,
  clearStoredCredential,
  createKeyFileCredential,
  getStoredCredential,
  saveCredential,
} from "../src/lib/credentials.ts";

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
