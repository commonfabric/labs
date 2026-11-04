export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen != bLen) return false;
  for (let i = 0; i < aLen; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
};
