/** Registers and exports the suggestion-card component. */

import { CFSuggestions } from "./cf-suggestions.ts";

if (!customElements.get("cf-suggestions")) {
  customElements.define("cf-suggestions", CFSuggestions);
}

export { CFSuggestions };
export type {
  CFSuggestions as CFSuggestionsElement,
  SuggestionCard,
  SuggestionEventDetail,
} from "./cf-suggestions.ts";
