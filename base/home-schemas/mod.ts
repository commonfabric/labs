/**
 * Home space schemas package.
 *
 * Contains schema definitions for home space data structures:
 * - Favorites: user's favorited pieces
 * - Journal: user's activity log
 * - Learned: user's learned profile data
 * - Spaces: user's managed spaces list
 * - Social spaces: separate collection observations, the profile acting in
 *   each space, and command projections
 *
 * This package exists to break the circular dependency between
 * @commonfabric/runner and @commonfabric/piece. Both packages can
 * safely import schemas from here.
 */

import { JSONSchema } from "@commonfabric/api";
import { Schema } from "@commonfabric/api/schema";

export {
  type FavoriteAddress,
  type FavoriteEntry,
  favoriteEntrySchema,
  favoriteKey,
  type FavoriteList,
  favoriteListSchema,
} from "./favorites.ts";

export {
  type Journal,
  type JournalEntry,
  journalEntrySchema,
  type JournalEventType,
  journalEventTypes,
  journalSchema,
  type JournalSnapshot,
  journalSnapshotSchema,
} from "./journal.ts";

export {
  type Fact,
  factSchema,
  type LearnedSection,
  learnedSectionSchema,
  type Preference,
  preferenceSchema,
  type Question,
  questionSchema,
} from "./learned.ts";

export {
  type SiteTable,
  siteTableCause,
  siteTableSchema,
  type SpaceEntry,
  spaceEntrySchema,
  type SpaceHostEntry,
  spaceHostEntrySchema,
  type SpacesList,
  spacesListSchema,
} from "./spaces.ts";

export { type Home, homeSchema } from "./home.ts";

export {
  type HomeSharedSpaceCollectionView,
  type HomeSharedSpaceProfileView,
  sharedSpaceCollectionViewSchema,
  sharedSpaceCommandsSchema,
  sharedSpaceEntrySchema,
  sharedSpaceImportCommandsSchema,
  sharedSpaceProfileViewSchema,
  sharedSpaceReceiptViewSchema,
} from "./shared-spaces.ts";

export const objectStubSchema = {
  type: "unknown",
} as const satisfies JSONSchema;
export type ObjectStub = Schema<typeof objectStubSchema>;
