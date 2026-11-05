/** Decoded text plus the matching encoder for later saves. */
export interface DecodedLanguageSource {
  readonly text: string;

  /** Whether the decoded source began with a UTF-8 byte-order mark. */
  readonly hasUtf8Bom: boolean;

  encode(text: string): Uint8Array;
}

/** Conversion between file bytes and the string retained by the view model. */
export interface LanguageDecoder {
  readonly id: "utf-8" | "raw-bytes";
  decode(bytes: Uint8Array): DecodedLanguageSource;
  encode(text: string): Uint8Array;
}

/** Detect NUL bytes and invalid UTF-8 across arbitrary input chunks. */
export class Utf8BinaryProbe {
  #binary = false;
  #decoder = new TextDecoder("utf-8", { fatal: true });

  write(bytes: Uint8Array): boolean {
    if (this.#binary) return true;
    if (bytes.includes(0)) return (this.#binary = true);
    try {
      this.#decoder.decode(bytes, { stream: true });
    } catch {
      this.#binary = true;
    }
    return this.#binary;
  }

  finish(): boolean {
    if (this.#binary) return true;
    try {
      this.#decoder.decode();
    } catch {
      this.#binary = true;
    }
    return this.#binary;
  }
}

/** Strict UTF-8 for textual languages. Invalid byte sequences are rejected. */
export const utf8Decoder: LanguageDecoder = {
  id: "utf-8",
  decode(bytes) {
    const hadBom = bytes.length >= 3 && bytes[0] === 0xef &&
      bytes[1] === 0xbb && bytes[2] === 0xbf;
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      hasUtf8Bom: hadBom,
      encode: hadBom ? encodeUtf8WithBom : encodeUtf8,
    };
  },
  encode: encodeUtf8,
};

/**
 * A byte-preserving string representation. Each UTF-16 code unit stores one
 * byte with the same numeric value.
 */
export const rawBytesDecoder: LanguageDecoder = {
  id: "raw-bytes",
  decode(bytes) {
    const chunks: string[] = [];
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(
        // deno-lint-ignore cf-spread/no-spread-arguments -- one chunk, at most chunkSize bytes, per call
        String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
      );
    }
    return {
      text: chunks.join(""),
      hasUtf8Bom: false,
      encode: encodeRawBytes,
    };
  },
  encode: encodeRawBytes,
};

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function encodeUtf8WithBom(text: string): Uint8Array {
  const encoded = encodeUtf8(text);
  const bytes = new Uint8Array(encoded.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(encoded, 3);
  return bytes;
}

function encodeRawBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    if (value > 0xff) {
      throw new TypeError(
        `Raw-byte source contains a non-byte code unit at offset ${index}.`,
      );
    }
    bytes[index] = value;
  }
  return bytes;
}
