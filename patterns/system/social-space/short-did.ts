/** The longest method-specific part `shortDid()` shows whole. */
const LONGEST_SHOWN_WHOLE = 20;

/** How many trailing characters `shortDid()` keeps of a longer one. */
const KEPT_TAIL = 4;

/**
 * Returns `did` shortened for display, where a member has no profile name to
 * show. A DID is `did`, a method and a method-specific part, split at its
 * first two colons; the part may hold further colons. When that part is
 * longer than 20 characters, the result is `did:<method>:…` followed by the
 * part's last 4 characters, and otherwise it is `did` whole. A string that is
 * not `did:` followed by a non-empty method, a colon and a part is returned
 * unchanged, and `undefined` returns the empty string. Characters are counted
 * by code point.
 */
export const shortDid = (did: string | undefined): string => {
  if (did === undefined) return "";
  const [prefix, method, ...rest] = did.split(":");
  if (prefix !== "did" || !method) return did;
  const part = [...rest.join(":")];
  return part.length > LONGEST_SHOWN_WHOLE
    ? `did:${method}:…${part.slice(-KEPT_TAIL).join("")}`
    : did;
};
