/**
 * Shared type definitions for the contacts pattern family.
 *
 * Extracted to break circular dependencies between contacts.tsx,
 * person.tsx, and family-member.tsx.
 */
import { type Default, NAME, UI, type VNode } from "commonfabric";

// ============================================================================
// PersonLike - Schelling point for person data (structural type)
// ============================================================================

/**
 * Minimal interface for person-like items.
 * Defined locally in patterns, not in core API - works via duck typing.
 * Any object with { firstName, lastName } satisfies PersonLike.
 */
export interface PersonLike {
  firstName: string;
  lastName: string;

  /** Optional link to same entity in another context (e.g., work vs personal) */
  sameAs?: PersonLike;
}

// ============================================================================
// Address & SocialProfile - Structured sub-types
// ============================================================================

export interface Address {
  label: string | Default<"">; // "Home", "Work", etc.
  street: string | Default<"">;
  city: string | Default<"">;
  state: string | Default<"">;
  zip: string | Default<"">;
  country: string | Default<"">;
}

export interface SocialProfile {
  platform: string | Default<"">; // "LinkedIn", "Twitter", etc.
  url: string | Default<"">;
}

// ============================================================================
// Birthday - Structured date with optional year
// ============================================================================

export interface Birthday {
  month: number | Default<0>; // 1-12, 0 = unset
  day: number | Default<0>; // 1-31, 0 = unset
  year: number | Default<0>; // 4-digit year, 0 = unknown
}

// ============================================================================
// Person Type - Extends PersonLike with optional contact fields
// ============================================================================

export interface Person extends PersonLike {
  firstName: string;
  lastName: string;
  // Name extensions
  middleName: string | Default<"">;
  nickname: string | Default<"">; // preferred name / what they go by
  prefix: string | Default<"">; // Dr., Mr., Prof.
  suffix: string | Default<"">; // Jr., III, Ph.D.
  // Identity metadata
  pronouns: string | Default<"">; // freeform: "he/him", "they/them"
  birthday: Birthday | Default<{ month: 0; day: 0; year: 0 }>;
  photo: string | Default<"">; // URL or data reference
  // Contact fields
  email: string | Default<"">;
  phone: string | Default<"">;
  notes: string | Default<"">;
  tags: string[] | Default<[]>;
  addresses: Address[] | Default<[]>;
  socialProfiles: SocialProfile[] | Default<[]>;
}

// ============================================================================
// FamilyMember Type - Extends PersonLike with family-specific fields
// ============================================================================

export interface FamilyMember extends PersonLike {
  firstName: string;
  lastName: string;
  relationship: string | Default<"">;
  birthday: string | Default<"">; // ISO date string (YYYY-MM-DD)
  dietaryRestrictions: string[] | Default<[]>;
  notes: string | Default<"">;
  tags: string[] | Default<[]>;
  allergies: string[] | Default<[]>;
  giftIdeas: string[] | Default<[]>;
}

// ============================================================================
// ContactPiece - What the container stores in its contacts array
// ============================================================================

/**
 * A contact piece has [NAME], [UI], and either person or member data.
 */
export interface ContactPiece {
  [NAME]: string;
  [UI]: VNode;
  person?: Person;
  member?: FamilyMember;
}

// ============================================================================
// ContactGroup - Manual grouping of contacts
// ============================================================================

export interface ContactGroup {
  name: string;
  contactIndices: number[] | Default<[]>; // indices into contacts[]
}

// Default export required by cf check infrastructure
export default undefined;
