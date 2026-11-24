/**
 * Builds the zip bytes a GitHub artifact download hands back, so a test that
 * reads an artifact can supply a real archive rather than a stand-in for one.
 * The members are assembled by hand because the reader takes its sizes and
 * offsets from the central directory, and a test needs to be able to write a
 * directory that disagrees with the payload it points at.
 */

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One file in the archive. */
export interface ZipMember {
  name: string;

  /** 0 stores the bytes; 8 deflates them. */
  method: number;

  /** The bytes as they sit on disk, already compressed for method 8. */
  data: Uint8Array;
}

/** The bytes of a string, for a stored member. */
export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** A string as raw-deflate bytes, for a member written with method 8. */
export async function deflate(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate-raw");
  const done = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes(text));
  await writer.close();
  return new Uint8Array(await done);
}

/**
 * Assembles a zip: a local header plus payload per member, then the central
 * directory and the end-of-central-directory record. CRCs are left zero, which
 * the reader checks nothing against. `entryCount` overrides the count the
 * end-of-central-directory record advertises.
 */
export function makeZip(
  members: ZipMember[],
  entryCount = members.length,
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = enc.encode(m.name);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, m.method, true);
    lv.setUint32(18, m.data.length, true);
    lv.setUint32(22, m.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, m.method, true);
    cv.setUint32(20, m.data.length, true);
    cv.setUint32(24, m.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    local.push(lh, m.data);
    central.push(cd);
    offset += lh.length + m.data.length;
  }
  const cdBytes = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entryCount, true);
  ev.setUint16(10, entryCount, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...local, cdBytes, eocd]);
}

/**
 * The shape CI uploads: one JSON report deflated, with a text member beside it
 * that the reader has to pass over.
 */
export async function artifactZip(
  name: string,
  json: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return makeZip([
    { name: "notes.txt", method: 0, data: bytes("ignore me") },
    { name, method: 8, data: await deflate(json) },
  ]);
}
