export const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function startsWithStatementWord(
  source: string,
  start: number,
  end: number,
  word: string,
): boolean {
  if (!source.startsWith(word, start)) {
    return false;
  }

  const next = source.charCodeAt(start + word.length);
  return start + word.length >= end || !isIdentifierPartCode(next);
}

export function readIdentifierEnd(
  source: string,
  start: number,
  end = source.length,
): number | undefined {
  if (start >= end || !isIdentifierStartCode(source.charCodeAt(start))) {
    return undefined;
  }

  let cursor = start + 1;
  while (cursor < end && isIdentifierPartCode(source.charCodeAt(cursor))) {
    cursor++;
  }
  return cursor;
}

export function isSimpleIdentifierText(source: string): boolean {
  return readIdentifierEnd(source, 0, source.length) === source.length;
}

export function isIdentifierStartCode(charCode: number): boolean {
  return (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122) ||
    charCode === 95 ||
    charCode === 36;
}

export function isIdentifierPartCode(charCode: number): boolean {
  return isIdentifierStartCode(charCode) ||
    (charCode >= 48 && charCode <= 57);
}
