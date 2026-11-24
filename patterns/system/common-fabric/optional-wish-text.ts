/** Optional text context defaults only after confirmed no-match discovery. */
import {
  type AsyncResult,
  hasError,
  lift,
  resultOf,
  type WishErrorCode,
} from "commonfabric";

/** Returns empty optional context for no-match and preserves other outcomes. */
export const optionalWishText = lift(({
  response,
  errorCode,
}: { response: AsyncResult<string>; errorCode?: WishErrorCode }) => {
  if (hasError(response) && errorCode === "no-match") return "";
  return resultOf(response);
});
