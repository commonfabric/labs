/**
 * Tests the space overview: it asks for an analysis as soon as it starts, its
 * autostart sending the dialog one user message requesting an overview, and a
 * finished overview shows its headline, themes, connections, and suggestions,
 * with the Connections section only when there is a connection to show.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import SpaceOverview, {
  OverviewView,
  type SpaceOverviewResult,
} from "./space-overview.tsx";

// The model fails the analysis the autostart asks for.
export const llmMocks = [
  {
    when: { lastMessageContains: "Analyze this space" },
    error: "The model is unavailable.",
  },
];

const CONNECTED: SpaceOverviewResult = {
  headline: "A space about gardening and cooking.",
  themes: [{
    name: "Kitchen garden",
    description: "Growing herbs for recipes.",
    relatedPieces: ["📝 Basil"],
  }],
  connections: [{
    description: "The basil note feeds the pesto recipe.",
    pieceNames: ["📝 Basil", "📝 Pesto"],
  }],
  suggestions: ["Plan the autumn planting."],
};

const UNCONNECTED: SpaceOverviewResult = {
  headline: "A space of unrelated travel notes.",
  themes: [{
    name: "Travel",
    description: "Notes from past trips.",
    relatedPieces: ["📝 Lisbon"],
  }],
  connections: [],
  suggestions: ["Group the notes by country."],
};

/** The messages the overview's message beads show. */
const shownMessages = (root: unknown) =>
  (propValue(findElement(root, "cf-message-beads"), "$messages") ??
    []) as { role?: string; content?: { text?: string }[] }[];

export default pattern(() => {
  const overview = SpaceOverview({});
  const connected = OverviewView({ overview: CONNECTED });
  const unconnected = OverviewView({ overview: UNCONNECTED });

  const action_start = action(() => {
    fireEvent(findElement(overview[UI], "cf-autostart"), "onstart", {});
  });

  return {
    [TESTS]: [
      { assertion: assert(() => overview[NAME] === "Space Overview") },
      { assertion: assert(() => overview.summary === "Space Overview") },
      { assertion: assert(() => shownMessages(overview[UI]).length === 0) },
      { assertion: assert(() => !hasText(overview[UI], "Themes")) },
      { action: action_start },
      {
        assertion: assert(() =>
          shownMessages(overview[UI])[0]?.role === "user" &&
          shownMessages(overview[UI])[0]?.content?.[0]?.text ===
            "Analyze this space and give me an overview of what's here."
        ),
      },
      {
        assertion: assert(() =>
          hasText(connected[UI], CONNECTED.headline) &&
          hasText(connected[UI], "Kitchen gardenGrowing herbs for recipes.") &&
          hasText(connected[UI], "Explore NextPlan the autumn planting.")
        ),
      },
      {
        assertion: assert(() =>
          hasText(
            connected[UI],
            "ConnectionsThe basil note feeds the pesto recipe.",
          )
        ),
      },
      {
        assertion: assert(() =>
          hasText(unconnected[UI], UNCONNECTED.headline) &&
          hasText(unconnected[UI], "TravelNotes from past trips.") &&
          hasText(unconnected[UI], "Explore NextGroup the notes by country.")
        ),
      },
      { assertion: assert(() => !hasText(unconnected[UI], "Connections")) },
    ],
    overview,
    connected,
    unconnected,
  };
});
