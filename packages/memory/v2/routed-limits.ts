/**
 * The fixed bound on one routed frame that the SDK applies as well as the
 * frame parser. It is apart from the parser so that the client does not
 * import the parser's codecs.
 */

/** Most `holdings` one frame may name; the router's `HOLDINGS_LIMIT`. */
export const ROUTED_HOLDINGS_LIMIT = 8192;
