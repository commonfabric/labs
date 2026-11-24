import { computed, pattern } from "commonfabric";

interface Preference {
  ingredient: string;
  preference: "liked" | "disliked";
}

// FIXTURE: computed-filter-map-chain
// Verifies: .filter() and .map() inside computed() are NOT transformed
// Context: Inside computed(), Reactive auto-unwraps to plain array, so
//   .filter() and .map() are standard Array methods — they must remain
//   untransformed. This is a negative test for the reactive method detection.
export default pattern<{ preferences: Preference[] }>((state) => {
  const liked = computed(() => {
    return state.preferences
      .filter((p) => p.preference === "liked")
      .map((p) => p.ingredient);
  });

  return { liked };
});
