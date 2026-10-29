import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

import { favoriteEntrySchema, favoriteListSchema } from "./favorites.ts";
import { journalEntrySchema, journalSchema } from "./journal.ts";
import { learnedSectionSchema } from "./learned.ts";
import { spacesListSchema } from "./spaces.ts";

export const homeSchema = {
  type: "object",
  properties: {
    favorites: favoriteListSchema,
    journal: journalSchema,
    learned: learnedSectionSchema,
    spaces: spacesListSchema,
    defaultAppUrl: { type: "string", default: "" },
    addFavorite: { ...favoriteEntrySchema, asCell: ["stream"] },
    removeFavorite: { ...favoriteEntrySchema, asCell: ["stream"] },
    addJournalEntry: { ...journalEntrySchema, asCell: ["stream"] },
  },
} as const satisfies JSONSchema;

export type Home = Schema<typeof homeSchema>;
