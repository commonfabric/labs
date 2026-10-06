/**
 * Which network addresses are on the open internet: parsing an address
 * written as text, and judging it by the address a connection to it reaches.
 */

/**
 * A host name as it is compared: lowercase, without the brackets around an
 * IPv6 address or a trailing dot.
 */
export const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/**
 * The bytes of `text`, an IPv4 address in dotted decimal (four bytes) or an
 * IPv6 address without brackets (sixteen); `undefined` for anything else,
 * including an IPv4 part with a leading zero, which resolvers differ on.
 */
export const parseIpAddress = (text: string): Uint8Array | undefined =>
  parseIpv4Address(text) ?? parseIpv6Address(text);

/**
 * Whether `address`, four or sixteen bytes, is a unicast address on the open
 * internet: not this device, a private or shared network, a link-local,
 * multicast, documentation or reserved address. An IPv4-mapped IPv6 address,
 * or one in the well-known NAT64 prefix, is judged by the IPv4 address it
 * reaches.
 */
export const isPublicAddress = (address: Uint8Array): boolean =>
  address.length === 4
    ? isGloballyRoutableIpv4(address)
    : address.length === 16 && isGloballyRoutableIpv6(address);

/**
 * Whether the first `bitLength` bits of `address` are those of `prefix`, whose
 * missing bytes are taken as zero.
 */
const hasPrefix = (
  address: Uint8Array,
  prefix: ArrayLike<number>,
  bitLength: number,
): boolean => {
  const fullBytes = Math.floor(bitLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== (prefix[index] ?? 0)) {
      return false;
    }
  }
  const remainingBits = bitLength % 8;
  if (remainingBits === 0) {
    return true;
  }
  const mask = 0xff << (8 - remainingBits) & 0xff;
  return (address[fullBytes]! & mask) === ((prefix[fullBytes] ?? 0) & mask);
};

const parseIpv4Address = (value: string): Uint8Array | undefined => {
  const parts = value.split(".");
  return parts.length === 4 &&
      parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && +part <= 255)
    ? Uint8Array.from(parts, Number)
    : undefined;
};

const isGloballyRoutableIpv4 = (address: Uint8Array): boolean => {
  const [a, b, c, d] = address;
  if (a === 0) return false; // Current network.
  if (a === 10) return false; // RFC 1918 private.
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT.
  if (a === 127) return false; // Loopback.
  if (a === 169 && b === 254) return false; // Link-local.
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918 private.
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments.
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1.
  if (a === 192 && b === 88 && c === 99) return false; // Deprecated 6to4 relay anycast.
  if (a === 192 && b === 168) return false; // RFC 1918 private.
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmarking.
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2.
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3.
  if (a >= 224) return false; // Multicast, reserved, broadcast.
  return !(a === 255 && b === 255 && c === 255 && d === 255);
};

const parseIpv6Address = (value: string): Uint8Array | undefined => {
  const normalized = value.toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  const doubleColon = normalized.match(/::/g) ?? [];
  if (doubleColon.length > 1) {
    return undefined;
  }

  let input = normalized;
  const embeddedIpv4Match = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(input);
  if (embeddedIpv4Match !== null) {
    const ipv4 = parseIpv4Address(embeddedIpv4Match[2]!);
    if (ipv4 === undefined) {
      return undefined;
    }
    const ipv4Hextets = [
      ((ipv4[0]! << 8) | ipv4[1]!).toString(16),
      ((ipv4[2]! << 8) | ipv4[3]!).toString(16),
    ];
    input = `${input.slice(0, embeddedIpv4Match.index + 1)}${
      ipv4Hextets.join(":")
    }`;
  }

  const hasCompression = input.includes("::");
  const [headText, tailText = ""] = input.split("::", 2);
  const head = headText === "" ? [] : headText.split(":");
  const tail = tailText === "" ? [] : tailText.split(":");
  if (
    head.some((part) => part === "") ||
    tail.some((part) => part === "")
  ) {
    return undefined;
  }
  const explicitParts = [...head, ...tail];
  if (hasCompression) {
    if (explicitParts.length >= 8) {
      return undefined;
    }
  } else if (explicitParts.length !== 8) {
    return undefined;
  }
  const missingParts = hasCompression ? 8 - explicitParts.length : 0;
  const parts = [...head, ...Array(missingParts).fill("0"), ...tail];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return undefined;
    }
    const value = Number.parseInt(part, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
};

const isGloballyRoutableIpv6 = (bytes: Uint8Array): boolean => {
  if (
    hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96) ||
    hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 96)
  ) {
    return isGloballyRoutableIpv4(bytes.slice(12)); // IPv4-mapped, NAT64.
  }
  if (!hasPrefix(bytes, [0x20], 3)) {
    // Not global unicast: loopback, unspecified, unique local, link-local,
    // multicast and the rest.
    return false;
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) {
    return false; // Documentation.
  }
  if (hasPrefix(bytes, [0x20, 0x02], 16)) {
    return false; // Deprecated 6to4.
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) {
    return false; // Teredo.
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02], 48)) {
    return false; // Benchmarking.
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)) {
    return false; // ORCHID.
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)) {
    return false; // ORCHIDv2.
  }
  if (hasPrefix(bytes, [0x3f, 0xff], 20)) {
    return false; // Documentation.
  }
  return true;
};
