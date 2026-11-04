# Pattern Spec: Parking Coordinator

## Description

A coordination tool for a small team to manage shared office parking spots. Team
members can see which spots are available today and for the week ahead, request
a spot for a specific date, and cancel requests they no longer need. An admin
mode enables managing the roster of people and spots, setting priority order
(which determines who gets first pick when allocating), and assigning preferred
or default spots per person. When a request is submitted, the system
automatically allocates the best available spot based on the person's default
spot, their ordered preferences, and their priority relative to other
requesters.

## Complexity Assessment

- **Tier:** Intermediate
- **Reference exemplars:** `apps/contacts/contact-book.tsx` (multiple entity
  types, admin CRUD, list management), `apps/habit-tracker/habit-tracker.tsx`
  (date-based records, per-day derived views)
- **Rationale:** The pattern manages three related entity types with
  cross-references, computes derived availability state across dates, implements
  an allocation algorithm with priority and preference rules, and includes two
  distinct capability levels (team member vs. admin). No LLM, no multi-step
  state machines, and no complex rendering tree — this keeps it solidly
  Intermediate rather than Advanced.

## Data Model

### Parking Spot

Represents a physical parking spot in the office lot.

- **number**: The spot's identifier as shown in the lot (e.g., "1", "5", "12").
  Used as the primary display label.
- **label**: Optional short name for the spot (e.g., "Near entrance"). Displayed
  alongside the number.
- **notes**: Optional freeform notes about the spot (e.g., "Tight, no large
  vehicles").
- **active**: Whether the spot is currently in service. Inactive spots are
  hidden from requests and allocation but their past records are preserved.

### Person

A team member who may request parking.

- **name**: The person's display name.
- **email**: The person's email address.
- **commuteMode**: Their usual way of getting to the office. One of: drive,
  transit, bike, wfh, other. Informational only — does not restrict who can
  request a spot.
- **spotPreferences**: An ordered list of spot numbers representing this
  person's ranked spot preferences. Earlier in the list = higher preference.
- **defaultSpot**: Optional. The spot number of this person's assigned default
  spot, if they have one. Gets first priority in auto-allocation before
  preferences are consulted.
- **priorityRank**: A positive integer indicating this person's priority in
  allocation. Lower number = higher priority (1 is highest). Used when multiple
  people request the same date — higher-priority people get their preferred
  spots first.

### Spot Request

A request by a person to have a parking spot on a specific date, along with the
allocation outcome.

- **personName**: The name of the person making the request. References the
  Person entity.
- **date**: The date for which parking is requested, in YYYY-MM-DD format.
- **status**: The current state of the request. One of:
  - `pending`: Submitted but allocation has not yet been determined (used if
    manual review is needed).
  - `allocated`: A spot has been assigned.
  - `denied`: No spot was available.
  - `cancelled`: The person cancelled the request.
- **assignedSpot**: Optional. The spot number assigned to this request. Only
  present when status is `allocated`.
- **autoAllocated**: Whether the spot was assigned automatically by the system
  (true) or manually by an admin (false).

### Relationships

- A Spot Request references one Person (by name) and optionally one Parking Spot
  (by number).
- A Person's `spotPreferences` list and `defaultSpot` field reference Parking
  Spot numbers.
- Multiple Spot Requests can exist for the same date, up to the number of active
  spots.
- One person can have at most one non-cancelled request per date.

## User Interactions

1. **View today's parking status.** The user sees all active parking spots
   listed with their current status for today: either "Available" or taken by a
   named person. This view updates to reflect the current date automatically.

2. **View the week-ahead allocation grid.** The user sees a 7-day grid starting
   from today, showing each day as a column and each active spot as a row (or
   vice versa). Each cell shows either the name of the person holding that spot
   on that day or indicates the spot is free.

3. **Request a spot for a date.** The user selects a date (today or any future
   date) and submits a request. The system immediately runs auto-allocation: it
   looks at all requests for that date ordered by priority rank, and assigns
   each person the best available spot (checking their default spot first, then
   each preference in order, then any remaining spot). The request receives
   status `allocated` with the assigned spot, or `denied` if no spots remain. A
   person may not submit a duplicate request for a date they already have an
   active (non-cancelled) request on.

4. **Cancel a parking request.** The user cancels one of their own active
   (allocated or pending) requests. The request status changes to `cancelled`.
   The freed spot becomes available for that date — no automatic reallocation
   occurs for other pending requests when a spot is freed.

5. **Toggle admin mode.** The user switches between regular team-member view and
   admin view. When admin mode is on, all admin management actions become
   available.

6. **Add a person (admin).** Admin enters a new person's name, email, commute
   mode, optional default spot, optional preferences list, and priority rank.
   The person is added to the roster.

7. **Edit a person's details (admin).** Admin updates any field of an existing
   person: name, email, commute mode, default spot, spot preferences order, or
   priority rank. Changes to preferences or default spot do not retroactively
   reallocate past or existing requests.

8. **Remove a person (admin).** Admin removes a person from the roster. Their
   existing Spot Requests are preserved as historical records but no new
   requests can be made for them.

9. **Reorder priority (admin).** Admin adjusts the priority ranks of people —
   either by editing individual rank numbers or by reordering a list. Priority
   affects future auto-allocation, not existing allocated requests.

10. **Add a parking spot (admin).** Admin adds a new parking spot with a number,
    optional label, and optional notes. The spot becomes immediately available
    for requests.

11. **Edit a parking spot (admin).** Admin updates a spot's label, notes, or
    active status. Deactivating a spot hides it from future request allocation;
    existing allocated requests for that spot on future dates remain intact but
    are flagged.

12. **Remove a parking spot (admin).** Admin removes a spot entirely. Spot
    Requests that reference the removed spot number are preserved in records but
    the spot disappears from the availability display.

13. **Manually assign or override a spot (admin).** Admin directly assigns a
    specific spot to a specific person for a specific date, bypassing
    auto-allocation. If a request exists for that person/date, it is updated to
    the assigned spot with `autoAllocated: false`. If no request exists, one is
    created with `allocated` status. If the target spot is already taken on that
    date, the conflict is shown and the admin must confirm or choose
    differently.

## Acceptance Criteria

- The today view shows all active spots; each spot displays either "Available"
  or the name of the person holding it for today's date.
- The week-ahead grid covers exactly 7 days starting from today and correctly
  reflects all non-cancelled allocations for those dates.
- Submitting a request for a date with at least one available spot results in
  status `allocated` with a spot number assigned.
- Submitting a request for a fully booked date results in status `denied` with
  no spot assigned.
- Auto-allocation respects priority: if two people request the same date at the
  same time, the lower priority-rank number (higher priority person) receives
  their preferred spot first.
- Auto-allocation preference order: default spot first (if available), then
  first available preference from the ordered list, then any remaining active
  spot.
- Cancelling a request changes its status to `cancelled` and the spot appears
  available again in today and week views.
- A person cannot submit a second request for a date where they already have an
  active (non-cancelled) request.
- Admin mode toggle reveals all admin management controls; toggling off hides
  them.
- Adding a person makes them immediately selectable for requests and visible in
  the people list.
- Removing a person removes them from the roster; their past request records
  remain visible in the allocation views.
- Adding a parking spot makes it available immediately; it appears in the today
  view and week-ahead grid.
- Deactivating a spot removes it from future allocation while preserving
  existing allocated requests for that spot.
- Admin manual assignment overrides auto-allocation and marks the request as not
  auto-allocated.
- People with commute mode "transit," "bike," "wfh," or "other" can successfully
  submit spot requests.
- The pattern loads with sensible initial state: the three default spots (#1,
  #5, #12) are pre-populated.

## Edge Cases

- **Empty roster:** No people in the system. Today view shows all spots as
  available. Request form has no people to select. Admin should be prompted to
  add people.
- **All spots taken for a date:** Any new request for that date immediately
  receives `denied` status with a clear message.
- **No available spots matching preferences:** If a person's default spot and
  all preferences are taken, they receive the first remaining spot (any
  available). If none remain, `denied`.
- **Requesting today after spots are taken:** Same allocation logic applies —
  date is today, but the spot may already be occupied by an earlier request.
- **Requesting a past date:** The UI should prevent or warn when a user selects
  a date in the past.
- **Duplicate request for same person/date:** The system rejects the new request
  submission and explains the person already has an active request for that
  date.
- **Spot deactivated with existing future allocations:** Those allocations
  remain; the spot is flagged as inactive but existing records are not deleted.
- **Person removed with future allocations:** Their future requests remain in
  the data but they no longer appear on the active roster.
- **Priority tie:** Two people with the same priority rank both request a
  fully-booked date. Neither preference is favored; order of submission
  determines who gets allocated if only one spot remains. Document this
  behavior.
- **Empty preferences list:** A person has no preferences and no default spot.
  They receive any available spot when requesting.
- **Single spot remaining, multiple preferences pointing to it:** The first
  person in priority order gets it; all others are denied if no other spots
  exist.
- **Week-ahead spanning month boundary:** The grid should correctly handle dates
  that cross into a new month or year.
- **Very long person names:** Names should truncate gracefully in the week-ahead
  grid cells.
- **Admin changes priority while pending requests exist:** Priority reordering
  affects future allocation only; it does not re-run allocation on existing
  requests.

## Assumptions

- **Allocation and Request merged into one entity.** The brief lists both "Spot
  Request" and "Allocation" as separate entities, but they describe the same
  record (who asked, for when, what they got, what the status is). Keeping them
  as one entity eliminates redundancy without losing any described information.
  The `autoAllocated` flag on SpotRequest covers the "whether it was
  auto-allocated" field from the Allocation entity.

- **Priority rank is a number, not a drag-drop order.** The brief says "set
  priority order" but doesn't specify the UI mechanism. The spec treats priority
  rank as an editable integer field. The UX designer will determine the
  appropriate interaction (direct number editing, drag-to-reorder, up/down
  arrows, etc.).

- **No retroactive reallocation.** When a request is cancelled and a spot is
  freed, the system does not automatically re-run allocation for other denied or
  pending requests. A freed spot simply becomes available. This keeps behavior
  predictable for a small team.

- **No authentication.** This is a small-team coordination tool. Admin mode is
  toggled via a UI control, not protected by a login. This matches the brief's
  "keep it practical and simple" directive.

- **One request per person per date.** The brief does not explicitly state this
  constraint but it is the only sensible interpretation. A person either needs a
  spot on a given day or they don't.

- **Allocation runs at request creation time.** The brief states
  "auto-allocation should run when a request is created." This means there is no
  separate "run allocation" step — the system allocates immediately and the
  result (allocated or denied) is returned with the request.

- **Default spots are pre-seeded.** The brief specifies the three initial spots
  (#1, #5, #12). The pattern initializes with these three spots already in the
  data so the tool is immediately usable without any admin setup.

- **Priority rank ties are resolved by submission order.** The brief specifies
  priority as a ranked list but does not address ties. Submission time is a fair
  and predictable tiebreaker.

- **Preferences list contains spot numbers as strings.** Since spot numbers are
  non-sequential identifiers (not sequential integers), they are treated as
  strings matching the `number` field of ParkingSpot entities.

- **Week-ahead means the next 7 days inclusive of today.** The brief says
  "week-ahead view" — interpreted as today through 6 days from now (7 days
  total), not a calendar-week Mon–Sun view. The UX designer may refine this.
