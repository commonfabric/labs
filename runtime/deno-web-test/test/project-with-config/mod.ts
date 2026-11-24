export const createEd25519Key = (): Promise<CryptoKey> => {
  const dummyKey = new Uint8Array(32);

  return globalThis.crypto.subtle.importKey(
    "raw",
    dummyKey,
    "ed25519",
    false,
    ["verify"],
  );
};
