import { isObjectOrArray } from "@commonfabric/utils/types";
export const AUTH_METHOD_PASSKEY = "passkey" as const;
export const AUTH_METHOD_PASSPHRASE = "passphrase" as const;
export const AUTH_METHOD_KEYFILE = "keyfile" as const;

export type AuthMethod =
  | typeof AUTH_METHOD_PASSKEY
  | typeof AUTH_METHOD_PASSPHRASE
  | typeof AUTH_METHOD_KEYFILE;

export interface StoredCredential {
  id: string;
  method: AuthMethod;
}

function isAuthMethod(method: unknown): method is AuthMethod {
  return method === AUTH_METHOD_PASSKEY ||
    method === AUTH_METHOD_PASSPHRASE ||
    method === AUTH_METHOD_KEYFILE;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  return isObjectOrArray(value) &&
    typeof value.id === "string" &&
    isAuthMethod(value.method);
}

export function getStoredCredential(): StoredCredential | null {
  const stored = localStorage.getItem("storedCredential");
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return isStoredCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCredential(credential: StoredCredential): void {
  localStorage.setItem("storedCredential", JSON.stringify(credential));
}

export function clearStoredCredential(): void {
  localStorage.removeItem("storedCredential");
}

export function createPasskeyCredential(id: string): StoredCredential {
  return {
    id,
    method: AUTH_METHOD_PASSKEY,
  };
}

export function createPassphraseCredential(): StoredCredential {
  return {
    id: crypto.randomUUID(),
    method: AUTH_METHOD_PASSPHRASE,
  };
}

export function createKeyFileCredential(did: string): StoredCredential {
  return {
    id: did,
    method: AUTH_METHOD_KEYFILE,
  };
}

function base64urlToBase64(base64url: string): string {
  // Replace base64url specific chars with base64 chars
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if necessary
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }

  return base64;
}

export function getPublicKeyCredentialDescriptor(
  storedCredential: StoredCredential | null,
): PublicKeyCredentialDescriptor | undefined {
  if (storedCredential?.method === "passkey") {
    try {
      // Convert base64url to base64 before decoding
      const base64 = base64urlToBase64(storedCredential.id);
      return {
        id: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        type: "public-key" as PublicKeyCredentialType,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
