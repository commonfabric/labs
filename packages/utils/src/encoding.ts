const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes a string into a Uint8Array using UTF-8 encoding.
 * @param input - The string to encode
 * @returns The encoded Uint8Array
 */
export const encode = (input: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(input);

/**
 * Decodes a Uint8Array into a string using UTF-8 decoding.
 * @param input - The Uint8Array to decode
 * @returns The decoded string
 */
export const decode = (input: Uint8Array): string => decoder.decode(input);

/**
 * Decodes a data file's bytes as the text a source package stores.
 *
 * A source package holds text, so the bytes are decoded as UTF-8 strictly: a
 * file that is not valid UTF-8 is reported by `name` rather than stored with
 * replacement characters in place of the bytes that were read. `ignoreBOM`
 * keeps a leading byte order mark in the result instead of consuming it, since
 * a data file is stored byte for byte and dropping the mark would deploy
 * something other than the authored file. Every reader of a data file decodes
 * it here, so that each one stores and hashes the same text.
 */
export function decodeDataFile(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch {
    throw new Error(`Data file \`${name}\` is not valid UTF-8 text.`);
  }
}
