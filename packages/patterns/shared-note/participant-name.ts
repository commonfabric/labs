const MAXIMUM_PRESENCE_NAME_CODE_POINTS = 80;
const MAXIMUM_PRESENCE_NAME_BYTES = 256;

function isPresenceNameCodePoint(codePoint: number): boolean {
  return !(codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff));
}

/** Returns a profile name that satisfies the co-presence wire contract. */
export function normalizePresenceParticipantName(value: string): string {
  const filtered = Array.from(value)
    .filter((character) => isPresenceNameCodePoint(character.codePointAt(0)!))
    .join("")
    .trim();
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  let codePoints = 0;

  for (const character of filtered) {
    const characterBytes = encoder.encode(character).length;
    if (
      codePoints === MAXIMUM_PRESENCE_NAME_CODE_POINTS ||
      bytes + characterBytes > MAXIMUM_PRESENCE_NAME_BYTES
    ) {
      break;
    }
    result += character;
    codePoints++;
    bytes += characterBytes;
  }

  return result;
}
