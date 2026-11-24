// path-codec.ts — reversible filesystem component encoding for user data

export interface EncodeFuseComponentOptions {
  reserveJsonSuffix?: boolean;
}

const EMPTY_COMPONENT = "%_empty";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hex = (byte: number): string =>
  byte.toString(16).toUpperCase().padStart(
    2,
    "0",
  );

const isHex = (value: string): boolean => /^[0-9A-Fa-f]$/.test(value);

function encodeUtf8(value: string): string {
  return [...encoder.encode(value)].map((byte) => `%${hex(byte)}`).join("");
}

function mustEscape(raw: string, char: string, index: number): boolean {
  if (char === "/" || char === "\0" || char === "%" || char === ":") {
    return true;
  }
  if (index === 0 && char === ".") return true;
  if ((raw === "." || raw === "..") && char === ".") return true;
  return false;
}

export function encodeFuseComponent(
  raw: string,
  options: EncodeFuseComponentOptions = {},
): string {
  if (raw === "") return EMPTY_COMPONENT;
  let encoded = "";
  let index = 0;
  for (const char of raw) {
    encoded += mustEscape(raw, char, index) ? encodeUtf8(char) : char;
    index += char.length;
  }
  if (options.reserveJsonSuffix && encoded.endsWith(".json")) {
    encoded = `${encoded.slice(0, -5)}%2Ejson`;
  }
  return encoded;
}

export function encodeFusePathSegments(
  segments: readonly string[],
  options?: EncodeFuseComponentOptions,
): string[] {
  return segments.map((segment) => encodeFuseComponent(segment, options));
}

export function decodeFuseComponent(component: string): string {
  if (component === EMPTY_COMPONENT) return "";

  let output = "";
  let pendingBytes: number[] = [];
  const flush = () => {
    if (pendingBytes.length === 0) return;
    output += decoder.decode(new Uint8Array(pendingBytes));
    pendingBytes = [];
  };

  for (let index = 0; index < component.length;) {
    if (
      component[index] === "%" &&
      index + 2 < component.length &&
      isHex(component[index + 1]) &&
      isHex(component[index + 2])
    ) {
      pendingBytes.push(
        Number.parseInt(component.slice(index + 1, index + 3), 16),
      );
      index += 3;
      continue;
    }
    flush();
    output += component[index];
    index++;
  }
  flush();
  return output;
}

export function decodeFusePathSegments(
  segments: readonly string[],
): string[] {
  return segments.map(decodeFuseComponent);
}
