/**
 * Fixed bounds on one routed frame that the SDK applies as well as the
 * frame parser. They are apart from the parser so that the client does not
 * import the parser's codecs.
 */

/** Most `watches` one frame may name; the router's `WATCH_LIMIT`. */
export const ROUTED_WATCH_LIMIT = 1024;
/** Most `holdings` one frame may name; the router's `HOLDINGS_LIMIT`. */
export const ROUTED_HOLDINGS_LIMIT = 8192;
