/**
 * A minimal TrueType font: an empty `.notdef` glyph and a square mapped to
 * "A". The CSP tests load it to see whether the guest's policy admits a font,
 * which needs a font the browser accepts, so it is built here from its tables
 * rather than checked in as a binary nobody can read.
 */

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number): number[] => [
  ...u16(value >>> 16),
  ...u16(value & 0xffff),
];
const zeros = (length: number): number[] => new Array(length).fill(0);

function utf16be(text: string): number[] {
  return [...text].flatMap((character) => u16(character.charCodeAt(0)));
}

function nameTable(): number[] {
  // Family, subfamily, unique ID, full name, PostScript name.
  const strings: [number, string][] = [
    [1, "Probe"],
    [2, "Regular"],
    [3, "Probe"],
    [4, "Probe"],
    [6, "Probe"],
  ];
  const records: number[][] = [];
  const storage: number[][] = [];
  let storageLength = 0;
  for (const [nameId, text] of strings) {
    const encoded = utf16be(text);
    records.push([
      ...u16(3),
      ...u16(1),
      ...u16(0x409),
      ...u16(nameId),
      ...u16(encoded.length),
      ...u16(storageLength),
    ]);
    storage.push(encoded);
    storageLength += encoded.length;
  }
  return [
    ...u16(0),
    ...u16(strings.length),
    ...u16(6 + 12 * strings.length),
    ...records.flat(),
    ...storage.flat(),
  ];
}

function tables(): Record<string, number[]> {
  return {
    "OS/2": [
      ...u16(4), // version
      ...u16(1000), // xAvgCharWidth
      ...u16(400), // usWeightClass
      ...u16(5), // usWidthClass
      ...u16(0), // fsType
      ...[650, 600, 0, 75, 650, 600, 0, 350, 50, 300].flatMap(u16),
      ...u16(0), // sFamilyClass
      ...zeros(10), // panose
      ...zeros(16), // ulUnicodeRange1..4
      ...[..."NONE"].map((character) => character.charCodeAt(0)),
      ...u16(0x40), // fsSelection: REGULAR
      ...u16(0x41), // usFirstCharIndex
      ...u16(0x41), // usLastCharIndex
      ...[800, -200, 0, 800, 200].flatMap(u16),
      ...u32(1), // ulCodePageRange1: Latin 1
      ...u32(0),
      ...[500, 700, 0, 0x20, 0].flatMap(u16),
    ],
    cmap: [
      ...u16(0),
      ...u16(1),
      ...u16(3), // Windows
      ...u16(1), // Unicode BMP
      ...u32(12),
      // Format 4: "A" to glyph 1, and the closing 0xFFFF segment.
      ...[4, 32, 0, 4, 4, 1, 0].flatMap(u16),
      ...[0x41, 0xffff, 0, 0x41, 0xffff, 1 - 0x41, 1, 0, 0].flatMap(u16),
    ],
    glyf: [
      // Glyph 1, a square; glyph 0 is empty.
      ...[1, 100, 0, 900, 700, 3, 0].flatMap(u16),
      1,
      1,
      1,
      1,
      ...[100, 0, 800, 0].flatMap(u16),
      ...[0, 700, 0, -700].flatMap(u16),
    ],
    head: [
      ...u32(0x00010000),
      ...u32(0x00010000),
      ...u32(0), // checkSumAdjustment, filled in once the font is assembled
      ...u32(0x5f0f3cf5),
      ...u16(0x000b),
      ...u16(1000), // unitsPerEm
      ...zeros(16), // created, modified
      ...[0, 0, 1000, 1000].flatMap(u16),
      ...u16(0), // macStyle
      ...u16(8), // lowestRecPPEM
      ...u16(2), // fontDirectionHint
      ...u16(0), // indexToLocFormat: short
      ...u16(0),
    ],
    hhea: [
      ...u32(0x00010000),
      ...[800, -200, 0, 1000, 0, 100, 900, 1, 0, 0].flatMap(u16),
      ...zeros(8),
      ...u16(0),
      ...u16(2), // numberOfHMetrics
    ],
    hmtx: [...[1000, 0, 1000, 100].flatMap(u16)],
    loca: [...[0, 0, 17].flatMap(u16)],
    maxp: [
      ...u32(0x00010000),
      ...[2, 4, 1, 0, 0, 2].flatMap(u16),
      ...zeros(16),
    ],
    name: nameTable(),
    post: [
      ...u32(0x00030000),
      ...u32(0),
      ...u16(-100),
      ...u16(50),
      ...zeros(20),
    ],
  };
}

function padded(bytes: number[]): number[] {
  return [...bytes, ...zeros((4 - (bytes.length % 4)) % 4)];
}

function checksum(bytes: number[]): number {
  const words = padded(bytes);
  let sum = 0;
  for (let i = 0; i < words.length; i += 4) {
    sum = (sum + ((words[i] << 24) | (words[i + 1] << 16) |
      (words[i + 2] << 8) | words[i + 3])) >>> 0;
  }
  return sum;
}

function buildProbeFont(): Uint8Array {
  const entries = Object.entries(tables()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const count = entries.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(count));
  const header = [
    ...u32(0x00010000),
    ...u16(count),
    ...u16(searchRange),
    ...u16(Math.log2(searchRange / 16)),
    ...u16(count * 16 - searchRange),
  ];
  const directory: number[][] = [];
  const body: number[][] = [];
  let offset = header.length + count * 16;
  let headOffset = 0;
  for (const [tag, bytes] of entries) {
    if (tag === "head") headOffset = offset;
    directory.push([
      ...[...tag].map((character) => character.charCodeAt(0)),
      ...u32(checksum(bytes)),
      ...u32(offset),
      ...u32(bytes.length),
    ]);
    const data = padded(bytes);
    body.push(data);
    offset += data.length;
  }
  const font = Uint8Array.from([
    ...header,
    ...directory.flat(),
    ...body.flat(),
  ]);
  font.set(
    u32((0xb1b0afba - checksum([...font])) >>> 0),
    headOffset + 8,
  );
  return font;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/** The probe font's bytes in base64, for a `data:` URL or `atob()`. */
export const PROBE_FONT_BASE64: string = toBase64(buildProbeFont());
