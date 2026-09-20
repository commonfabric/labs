// FIXTURE: The host test seeds reader cells and waits for the actual agent queue.
import { assert, pattern, TESTS } from "commonfabric";
import BookRecommendations from "../../book-recommendations/main.tsx";

export default pattern(() => {
  const reader = BookRecommendations({});
  return {
    [TESTS]: [{
      assertion: assert(() => reader.recommendation.pending === true),
    }],
  };
});
