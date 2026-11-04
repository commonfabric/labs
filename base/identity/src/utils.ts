export function random(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}

export function bufferSourceToArrayBuffer(
  source: BufferSource,
): ArrayBuffer | SharedArrayBuffer {
  return ArrayBuffer.isView(source) ? source.buffer : source;
}

// Bind a handler to an `EventTarget`'s event once.
export function once(
  target: EventTarget,
  eventName: string,
  callback: (e: Event) => void,
) {
  const wrap = (e: Event) => {
    callback(e);
    target.removeEventListener(eventName, wrap);
  };
  target.addEventListener(eventName, wrap);
}

const HASH_ALG = "SHA-256";
// Hash input via SHA-256.
export async function hash(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(HASH_ALG, input as BufferSource),
  );
}
