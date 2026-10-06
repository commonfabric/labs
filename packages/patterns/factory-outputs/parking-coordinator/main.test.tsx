/**
 * Parking Coordinator Pattern Tests
 *
 * Tests core functionality:
 * - Initial state (pre-seeded spots, no people, no requests)
 * - Adding / removing people (admin actions)
 * - Priority reordering (movePersonUp / movePersonDown)
 * - Adding / removing spots (admin actions)
 * - Spot request submission with auto-allocation (default spot, preferences, any remaining)
 * - Denied allocation when all spots are taken
 * - Duplicate request prevention
 * - Request cancellation
 * - Admin override (manual assignment, autoAllocated: false)
 *
 * NOTE: Uses .filter(() => true).length for array lengths per reactivity tracking note.
 */
import {
  action,
  assert,
  computed,
  pattern,
  resultOf,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  findNodeByProp,
  hasText,
  propValue,
} from "../../test/vnode-helpers.ts";
import ParkingCoordinator, { DEFAULT_SPOTS } from "./main.tsx";
import type {
  ParkingProfile,
  ParkingSpot,
  Person,
  SpotRequest,
  Vehicle,
} from "./main.tsx";

const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

const toLocalDateStr = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
};

function addDays(timestamp: number, days: number): string {
  const d = new Date(timestamp);
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d.getTime());
}

export default pattern(() => {
  // Dates derive from the reactive #now clock (one-shot, coarsened to 1s) rather
  // than reading the ambient wall clock at pattern-body evaluation, which the
  // time-capability gate blocks outside a handler. Keep every scenario safely in
  // the future (+7/+8 days): the #now wish can advance while this large test runs
  // (notably across midnight), so anchoring later actions a week out keeps them
  // from becoming nondeterministically "past". testDate/nextTestDate are computed
  // cells; they and their dependents remain unavailable until #now resolves,
  // then the runtime re-runs the actions and assertions.
  const nowCell = wish<number>({ query: "#now" });
  const nowCellValue = resultOf(nowCell.result);
  const testDate = computed(() => addDays(nowCellValue, 7));
  const nextTestDate = computed(() => addDays(nowCellValue, 8));

  // ============================================================
  // Subject 1: People Management
  // ============================================================
  // A role binds to a profile cell, so every subject that exercises admin
  // authority needs an identity for the viewer, and every person who is to
  // hold a role needs one on their row.
  const s1Viewer = Writable.of<ParkingProfile>({ name: "Alice" });
  const s1 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
    viewer: { name: "Alice", profile: s1Viewer },
  });

  const action_enable_s1_admin_manager = action(() =>
    s1.enableAdminManager.send()
  );

  const assert_s1_manager_can_start_people_flow = assert(() =>
    s1.currentUserCanManageAdmins === true &&
    hasText(
      findNodeById(s1[UI], "parking-admin-add-person-open"),
      "+ Add Person",
    )
  );

  const action_add_alice = action(() => {
    s1.addPerson.send({
      name: "Alice",
      email: "alice@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "5",
      preferences: "5, 1",
    });
  });

  const action_add_bob = action(() => {
    s1.addPerson.send({
      name: "Bob",
      email: "bob@co.com",
      commuteMode: "transit",
      priorityRank: 2,
      defaultSpot: "",
      preferences: "12",
    });
  });

  const action_add_alice_duplicate = action(() => {
    s1.addPerson.send({
      name: "Alice",
      email: "alice2@co.com",
      commuteMode: "wfh",
      priorityRank: 5,
      defaultSpot: "",
      preferences: "",
    });
  });

  const action_remove_bob = action(() => {
    s1.removePerson.send({ name: "Bob" });
  });

  const action_edit_person_no_payload = action(() => {
    s1.editPerson.send(undefined as never);
  });

  // Initial state
  const assert_s1_no_people = assert(() => len(s1.people) === 0);
  const assert_s1_three_spots = assert(() => len(s1.spots) === 3);

  // After adding Alice
  const assert_s1_alice_exists = assert(() =>
    s1.people.some((p: Person) => p.name === "Alice")
  );
  const assert_s1_alice_default_spot = assert(() => {
    const alice = s1.people.find((p: Person) => p.name === "Alice");
    return alice?.defaultSpot === "5";
  });
  const assert_s1_alice_preferences = assert(() => {
    const alice = s1.people.find((p: Person) => p.name === "Alice");
    return alice?.spotPreferences.some((s) => s === "5") === true &&
      alice?.spotPreferences.some((s) => s === "1") === true;
  });
  const assert_s1_one_person = assert(() => len(s1.people) === 1);
  const assert_s1_alice_unchanged = assert(() => {
    const alice = s1.people.find((p: Person) => p.name === "Alice");
    return len(s1.people) === 1 && alice?.email === "alice@co.com";
  });

  // After adding Bob
  const assert_s1_two_people = assert(() => len(s1.people) === 2);
  const assert_s1_bob_preferences = assert(() => {
    const bob = s1.people.find((p: Person) => p.name === "Bob");
    return bob?.spotPreferences.some((s) => s === "12") === true;
  });

  // Duplicate rejected
  const assert_s1_still_two = assert(() => len(s1.people) === 2);

  // After removing Bob
  const assert_s1_one_after_remove = assert(() => len(s1.people) === 1);
  const assert_s1_bob_gone = assert(() =>
    !s1.people.some((p: Person) => p.name === "Bob")
  );

  // ============================================================
  // Subject 2: Priority Reordering
  // ============================================================
  const s2 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [
      {
        name: "Alice",
        email: "a@co.com",
        commuteMode: "drive",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 1,
      },
      {
        name: "Bob",
        email: "b@co.com",
        commuteMode: "transit",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 2,
      },
      {
        name: "Carol",
        email: "c@co.com",
        commuteMode: "bike",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 3,
      },
    ],
    requests: [],
  });

  const action_move_carol_up = action(() =>
    s2.movePersonUp.send({ name: "Carol" })
  );
  const action_move_alice_down = action(() =>
    s2.movePersonDown.send({ name: "Alice" })
  );

  const assert_s2_alice_rank1 = assert(() => {
    return s2.people.find((p: Person) => p.name === "Alice")?.priorityRank ===
      1;
  });
  const assert_s2_carol_rank3 = assert(() => {
    return s2.people.find((p: Person) => p.name === "Carol")?.priorityRank ===
      3;
  });
  // After moving Carol up (should swap Carol rank 3 with Bob rank 2)
  const assert_s2_carol_rank2 = assert(() => {
    return s2.people.find((p: Person) => p.name === "Carol")?.priorityRank ===
      2;
  });
  const assert_s2_bob_rank3 = assert(() => {
    return s2.people.find((p: Person) => p.name === "Bob")?.priorityRank === 3;
  });
  // After moving Alice down (rank 1 should swap with rank 2 = Carol now)
  const assert_s2_alice_rank2 = assert(() => {
    return s2.people.find((p: Person) => p.name === "Alice")?.priorityRank ===
      2;
  });

  // ============================================================
  // Subject 3: Spot Management
  // ============================================================
  const alice3Profile = Writable.of<ParkingProfile>({ name: "Alice" });
  const adminAlice3: Person = {
    profile: alice3Profile,
    name: "Alice",
    email: "alice@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };
  const s3 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [adminAlice3],
    requests: [],
    viewer: { name: "Alice", profile: alice3Profile },
  });

  const action_add_spot7_without_admin = action(() =>
    s3.addSpot.send({ spotNumber: "7", label: "Level 2", notes: "Covered" })
  );
  const action_enable_s3_admin_manager = action(() =>
    s3.enableAdminManager.send()
  );
  const action_make_alice_spot_admin = action(() =>
    s3.togglePersonAdmin.send({ profile: alice3Profile })
  );
  const action_add_spot7 = action(() =>
    s3.addSpot.send({ spotNumber: "7", label: "Level 2", notes: "Covered" })
  );
  const action_add_spot1_dup = action(() =>
    s3.addSpot.send({ spotNumber: "1", label: "Dup", notes: "" })
  );
  const action_remove_spot5 = action(() =>
    s3.removeSpot.send({ spotNumber: "5" })
  );
  const action_edit_spot_no_payload = action(() => {
    s3.editSpot.send(undefined as never);
  });

  const assert_s3_three_spots = assert(() => len(s3.spots) === 3);
  const assert_s3_non_admin_spot_blocked = assert(() => len(s3.spots) === 3);
  const assert_s3_can_manage_admins = assert(() =>
    s3.currentUserCanManageAdmins === true
  );
  const assert_s3_alice_is_admin = assert(() =>
    s3.currentPersonIsAdmin === true
  );
  const assert_s3_four_spots = assert(() => len(s3.spots) === 4);
  const assert_s3_spot7_label = assert(() => {
    const s = s3.spots.find((sp: ParkingSpot) => sp.spotNumber === "7");
    return s?.label === "Level 2" && s?.active === true;
  });
  const assert_s3_spot7_unchanged = assert(() => {
    const s = s3.spots.find((sp: ParkingSpot) => sp.spotNumber === "7");
    return len(s3.spots) === 4 && s?.label === "Level 2" && s?.active === true;
  });
  const assert_s3_still_four = assert(() => len(s3.spots) === 4); // dup rejected
  const assert_s3_three_after_remove = assert(() => len(s3.spots) === 3);
  const assert_s3_spot5_gone = assert(() =>
    !s3.spots.some((sp: ParkingSpot) => sp.spotNumber === "5")
  );

  // ============================================================
  // Subject 4: Request Submission (Allocation)
  // ============================================================

  // Alice with defaultSpot "5" → should get spot 5
  const alice4: Person = {
    name: "Alice",
    email: "a@co.com",
    commuteMode: "drive",
    spotPreferences: ["1"],
    defaultSpot: "5",
    priorityRank: 1,
  };
  const bob4: Person = {
    name: "Bob",
    email: "b@co.com",
    commuteMode: "transit",
    spotPreferences: ["1", "12"],
    defaultSpot: "",
    priorityRank: 2,
  };
  const carol4: Person = {
    name: "Carol",
    email: "c@co.com",
    commuteMode: "bike",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 3,
  };

  const s4 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4, bob4, carol4],
    requests: [],
  });

  // Alice requests the test date → gets default spot "5"
  const action_alice_request = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: testDate });
  });

  // Bob requests the same date → spot "5" is taken, so preference "1" wins
  const action_bob_request = action(() => {
    s4.submitRequest.send({ personName: "Bob", date: testDate });
  });

  // Carol requests the same date → gets "12" (the last remaining spot)
  const action_carol_request = action(() => {
    s4.submitRequest.send({ personName: "Carol", date: testDate });
  });

  // Alice duplicate request for the same date → rejected
  const action_alice_dupe = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: testDate });
  });

  // Alice requests the following date (no conflicts)
  const action_alice_tomorrow = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: nextTestDate });
  });

  const assert_s4_no_requests = assert(() => len(s4.requests) === 0);

  // After Alice requests the test date
  const assert_s4_alice_allocated = assert(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Alice" && r.date === testDate
    );
    return req?.status === "allocated" && req?.assignedSpot === "5" &&
      req?.autoAllocated === true;
  });

  // After Bob requests the test date
  const assert_s4_bob_allocated_pref = assert(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Bob" && r.date === testDate
    );
    return req?.status === "allocated" && req?.assignedSpot === "1";
  });

  // After Carol requests the test date (only "12" left)
  const assert_s4_carol_allocated = assert(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Carol" && r.date === testDate
    );
    return req?.status === "allocated" && req?.assignedSpot === "12";
  });

  // Alice dupe: still only one request for the test date
  const assert_s4_alice_still_one_today = assert(() => {
    const aliceToday = s4.requests.filter((r: SpotRequest) =>
      r.personName === "Alice" && r.date === testDate
    );
    return len(aliceToday) === 1;
  });

  // Duplicate shows in result message
  const assert_s4_dupe_result = assert(() =>
    s4.requestResult.toLowerCase().includes("already")
  );

  // Alice's following-date request gets allocated (any spot)
  const assert_s4_alice_tomorrow_allocated = assert(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Alice" && r.date === nextTestDate
    );
    return req?.status === "allocated" && req?.assignedSpot !== "";
  });

  // ============================================================
  // Subject 5: Full booking → denied
  // ============================================================
  const dave5: Person = {
    name: "Dave",
    email: "d@co.com",
    commuteMode: "other",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 4,
  };

  const s5 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4, bob4, carol4, dave5],
    requests: [
      {
        id: "r1",
        personName: "Alice",
        date: testDate,
        status: "allocated",
        assignedSpot: "1",
        autoAllocated: true,
      },
      {
        id: "r2",
        personName: "Bob",
        date: testDate,
        status: "allocated",
        assignedSpot: "5",
        autoAllocated: true,
      },
      {
        id: "r3",
        personName: "Carol",
        date: testDate,
        status: "allocated",
        assignedSpot: "12",
        autoAllocated: true,
      },
    ],
  });

  const action_dave_request_denied = action(() => {
    s5.submitRequest.send({ personName: "Dave", date: testDate });
  });

  const assert_s5_dave_denied = assert(() => {
    const req = s5.requests.find((r: SpotRequest) =>
      r.personName === "Dave" && r.date === testDate
    );
    return req?.status === "denied" && req?.assignedSpot === "";
  });

  // ============================================================
  // Subject 6: Cancellation
  // ============================================================
  const s6 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4],
    requests: [
      {
        id: "rx1",
        personName: "Alice",
        date: testDate,
        status: "allocated",
        assignedSpot: "5",
        autoAllocated: true,
      },
    ],
  });

  const action_cancel_alice = action(() =>
    s6.cancelRequest.send({ requestId: "rx1" })
  );

  const assert_s6_allocated = assert(() => {
    return s6.requests.find((r: SpotRequest) => r.id === "rx1")?.status ===
      "allocated";
  });
  const assert_s6_cancelled = assert(() => {
    return s6.requests.find((r: SpotRequest) => r.id === "rx1")?.status ===
      "cancelled";
  });

  // ============================================================
  // Subject 7: Admin Override
  // ============================================================
  const alice7Profile = Writable.of<ParkingProfile>({ name: "Alice" });
  const s7 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [{ ...alice4, profile: alice7Profile }, bob4],
    requests: [],
    viewer: { name: "Alice", profile: alice7Profile },
  });

  const action_try_admin_override_without_admin = action(() => {
    s7.adminOverride.send({
      spotNumber: "5",
      date: testDate,
      personName: "Bob",
    });
  });
  const action_enable_s7_admin_manager = action(() =>
    s7.enableAdminManager.send()
  );
  const action_make_alice_override_admin = action(() =>
    s7.togglePersonAdmin.send({ profile: alice7Profile })
  );
  const action_admin_override_bob_spot5 = action(() => {
    s7.adminOverride.send({
      spotNumber: "5",
      date: testDate,
      personName: "Bob",
    });
  });

  const assert_s7_non_admin_override_blocked = assert(() =>
    len(s7.requests) === 0
  );
  const assert_s7_can_manage_admins = assert(() =>
    s7.currentUserCanManageAdmins === true
  );
  const assert_s7_alice_is_admin = assert(() =>
    s7.currentPersonIsAdmin === true
  );
  const assert_s7_bob_override = assert(() => {
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Bob" && r.date === testDate &&
        r.assignedSpot === "5" &&
        r.autoAllocated === false && r.status === "allocated",
    );
  });

  // Override with conflict: assign spot 5 to Alice (Bob already has it)
  const action_admin_override_alice_spot5 = action(() => {
    s7.adminOverride.send({
      spotNumber: "5",
      date: testDate,
      personName: "Alice",
    });
  });

  const assert_s7_alice_has_spot5 = assert(() => {
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Alice" && r.assignedSpot === "5" &&
        r.status === "allocated",
    );
  });

  const assert_s7_bob_spot5_cancelled = assert(() => {
    // Bob's original spot 5 allocation should be cancelled
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Bob" && r.assignedSpot === "5" &&
        r.status === "cancelled",
    );
  });

  // ============================================================
  // Subject 8: Admin mode toggle
  // ============================================================
  const alice8Profile = Writable.of<ParkingProfile>({ name: "Alice" });
  const s8 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [{ ...alice4, profile: alice8Profile }],
    requests: [],
    viewer: { name: "Alice", profile: alice8Profile },
  });

  const action_toggle_admin = action(() => s8.toggleAdminMode.send());
  const action_enable_s8_admin_manager = action(() =>
    s8.enableAdminManager.send()
  );
  const action_make_alice_mode_admin = action(() =>
    s8.togglePersonAdmin.send({ profile: alice8Profile })
  );

  const assert_s8_admin_off = assert(() => s8.adminMode === false);
  const assert_s8_admin_view_locked = assert(() => {
    const adminAccess = findNodeById(s8[UI], "parking-admin-access");
    const enableManager = findNodeById(
      s8[UI],
      "parking-enable-admin-manager",
    );
    const adminToggle = findNodeById(s8[UI], "parking-admin-mode-toggle");
    const aliceAdminToggle = findNodeByProp(
      s8[UI],
      "data-parking-admin-toggle",
      "Alice",
    );
    // The access chip carries its text in a `label` prop, so this looks for
    // the prop rather than for rendered text.
    return findNodeByProp(adminAccess, "label", "Cannot manage admins") !==
        undefined &&
      hasText(aliceAdminToggle, "Make admin") &&
      propValue(enableManager, "disabled") === false &&
      propValue(aliceAdminToggle, "disabled") === true &&
      propValue(adminToggle, "disabled") === true &&
      findNodeById(s8[UI], "parking-admin-people-section") === undefined;
  });
  const assert_s8_can_manage_admins = assert(() =>
    s8.currentUserCanManageAdmins === true
  );
  const assert_s8_admin_view_manager_enabled = assert(() => {
    const adminAccess = findNodeById(s8[UI], "parking-admin-access");
    const enableManager = findNodeById(
      s8[UI],
      "parking-enable-admin-manager",
    );
    const aliceAdminToggle = findNodeByProp(
      s8[UI],
      "data-parking-admin-toggle",
      "Alice",
    );
    return findNodeByProp(adminAccess, "label", "Can manage admins") !==
        undefined &&
      hasText(aliceAdminToggle, "Make admin") &&
      propValue(enableManager, "disabled") === true &&
      propValue(aliceAdminToggle, "disabled") === false;
  });
  const assert_s8_alice_is_admin = assert(() =>
    s8.currentPersonIsAdmin === true
  );
  const assert_s8_admin_view_alice_admin = assert(() => {
    const adminToggle = findNodeById(s8[UI], "parking-admin-mode-toggle");
    const aliceRow = findNodeByProp(
      s8[UI],
      "data-parking-admin-row",
      "Alice",
    );
    const aliceAdminToggle = findNodeByProp(
      s8[UI],
      "data-parking-admin-toggle",
      "Alice",
    );
    // Alice's role chip carries its text in a `label` prop, so this looks for
    // the prop rather than for rendered text.
    return findNodeByProp(aliceRow, "label", "Admin") !== undefined &&
      hasText(aliceAdminToggle, "Remove admin") &&
      propValue(adminToggle, "disabled") === false &&
      hasText(adminToggle, "Admin: OFF");
  });
  const assert_s8_admin_on = assert(() => s8.adminMode === true);
  const assert_s8_admin_view_admin_mode_visible = assert(() =>
    hasText(
      findNodeById(s8[UI], "parking-admin-mode-toggle"),
      "Admin: ON",
    ) &&
    hasText(
      findNodeById(s8[UI], "parking-admin-people-section"),
      "People",
    ) &&
    hasText(
      findNodeById(s8[UI], "parking-admin-add-person-open"),
      "+ Add Person",
    )
  );

  // ============================================================
  // Subject 9: Vehicle data on people
  // ============================================================

  // 9a: addPerson WITH vehicles — plateId normalized, plateState defaulted
  const s9a = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9a_add_with_vehicles = action(() => {
    s9a.addPerson.send({
      name: "Zara",
      email: "zara@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        // plateId should be normalized: lowercase + special chars stripped
        {
          plateId: "7abc-123!",
          plateState: "",
          color: "Red",
          make: "Toyota",
          model: "Camry",
        },
        // blank plateState → defaults to "CA"
        { plateId: "XYZ999", plateState: "", color: "", make: "", model: "" },
      ],
    });
  });

  const assert_s9a_zara_has_vehicles = assert(() => {
    const zara = s9a.people.find((p: Person) => p.name === "Zara");
    const vs: Vehicle[] = zara?.vehicles ?? [];
    return (
      len(vs) === 2 &&
      vs[0].plateId === "7ABC123" && // normalized
      vs[0].plateState === "CA" && // defaulted from blank
      vs[0].color === "Red" &&
      vs[1].plateId === "XYZ999" &&
      vs[1].plateState === "CA"
    );
  });

  // 9b: addPerson with a vehicle whose plateId is blank after normalization → dropped
  const s9b = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9b_add_blank_plate = action(() => {
    s9b.addPerson.send({
      name: "Ben",
      email: "ben@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        // plateId with only special chars → normalizes to "" → dropped
        { plateId: "---", plateState: "CA", color: "", make: "", model: "" },
        // valid one stays
        { plateId: "ABC123", plateState: "NY", color: "", make: "", model: "" },
      ],
    });
  });

  const assert_s9b_blank_plate_dropped = assert(() => {
    const ben = s9b.people.find((p: Person) => p.name === "Ben");
    const vs: Vehicle[] = ben?.vehicles ?? [];
    return len(vs) === 1 && vs[0].plateId === "ABC123" &&
      vs[0].plateState === "NY";
  });

  // 9c: existing callers that don't pass vehicles → default [] (backward-compat)
  const s9c = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9c_add_no_vehicles = action(() => {
    s9c.addPerson.send({
      name: "Carol",
      email: "carol@co.com",
      commuteMode: "bike",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
    });
  });

  const assert_s9c_no_vehicles_default = assert(() => {
    const carol = s9c.people.find((p: Person) => p.name === "Carol");
    const vs: Vehicle[] = carol?.vehicles ?? [];
    return len(vs) === 0;
  });

  // 9e: addPerson with invalid make+model combo → model dropped, make preserved
  const s9e = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9e_add_invalid_combo = action(() => {
    s9e.addPerson.send({
      name: "Eve",
      email: "eve@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        // Honda does not have Camry — model must be dropped
        {
          plateId: "EVE001",
          plateState: "CA",
          color: "",
          make: "Honda",
          model: "Camry",
        },
      ],
    });
  });

  const assert_s9e_model_dropped = assert(() => {
    const eve = s9e.people.find((p: Person) => p.name === "Eve");
    const vs: Vehicle[] = eve?.vehicles ?? [];
    return len(vs) === 1 && vs[0].make === "Honda" && vs[0].model === "";
  });

  // 9f: addPerson with valid make+model combo → both kept
  const s9f = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9f_add_valid_combo = action(() => {
    s9f.addPerson.send({
      name: "Frank",
      email: "frank@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        {
          plateId: "FRK001",
          plateState: "CA",
          color: "",
          make: "Honda",
          model: "Civic",
        },
      ],
    });
  });

  const assert_s9f_valid_combo_kept = assert(() => {
    const frank = s9f.people.find((p: Person) => p.name === "Frank");
    const vs: Vehicle[] = frank?.vehicles ?? [];
    return len(vs) === 1 && vs[0].make === "Honda" && vs[0].model === "Civic";
  });

  // 9g: addPerson with two vehicles sharing same plateId+state → deduped to one
  const s9g = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9g_add_dupes = action(() => {
    s9g.addPerson.send({
      name: "Grace",
      email: "grace@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        {
          plateId: "DUP001",
          plateState: "CA",
          color: "Red",
          make: "",
          model: "",
        },
        {
          plateId: "DUP001",
          plateState: "CA",
          color: "Blue",
          make: "",
          model: "",
        },
      ],
    });
  });

  const assert_s9g_deduped = assert(() => {
    const grace = s9g.people.find((p: Person) => p.name === "Grace");
    const vs: Vehicle[] = grace?.vehicles ?? [];
    // First occurrence kept, second dropped
    return len(vs) === 1 && vs[0].plateId === "DUP001" && vs[0].color === "Red";
  });

  // 9h: addPerson with invalid color → stored as ""
  const s9h = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_s9h_add_invalid_color = action(() => {
    s9h.addPerson.send({
      name: "Hank",
      email: "hank@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        {
          plateId: "HNK001",
          plateState: "CA",
          color: "Chartreuse",
          make: "",
          model: "",
        },
      ],
    });
  });

  const assert_s9h_invalid_color_cleared = assert(() => {
    const hank = s9h.people.find((p: Person) => p.name === "Hank");
    const vs: Vehicle[] = hank?.vehicles ?? [];
    return len(vs) === 1 && vs[0].color === "";
  });

  // 9d: editPerson WITH vehicles replaces them; WITHOUT vehicles preserves them
  const personWithVehicle: Person = {
    name: "Dana",
    email: "dana@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
    vehicles: [{
      plateId: "OLD001",
      plateState: "CA",
      color: "Blue",
      make: "Honda",
      model: "Civic",
    }],
  };

  const s9d = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [personWithVehicle],
    requests: [],
  });

  // Edit WITH new vehicles → replaces
  const action_s9d_edit_with_vehicles = action(() => {
    s9d.editPerson.send({
      originalName: "Dana",
      name: "Dana",
      email: "dana@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      vehicles: [
        {
          plateId: "new-456",
          plateState: "WA",
          color: "Black",
          make: "Ford",
          model: "F-150",
        },
      ],
    });
  });

  const assert_s9d_vehicles_replaced = assert(() => {
    const dana = s9d.people.find((p: Person) => p.name === "Dana");
    const vs: Vehicle[] = dana?.vehicles ?? [];
    return len(vs) === 1 && vs[0].plateId === "NEW456" &&
      vs[0].plateState === "WA";
  });

  // Edit WITHOUT vehicles → preserves existing
  const action_s9d_edit_no_vehicles = action(() => {
    s9d.editPerson.send({
      originalName: "Dana",
      name: "Dana",
      email: "dana2@co.com", // change email only
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
      // vehicles omitted
    });
  });

  const assert_s9d_vehicles_preserved = assert(() => {
    const dana = s9d.people.find((p: Person) => p.name === "Dana");
    const vs: Vehicle[] = dana?.vehicles ?? [];
    // vehicles from previous edit still present, email changed
    return (
      len(vs) === 1 &&
      vs[0].plateId === "NEW456" &&
      dana?.email === "dana2@co.com"
    );
  });

  // ============================================================
  // Test sequence
  // ============================================================

  return {
    [TESTS]: [
      // People management
      { assertion: assert_s1_no_people },
      { assertion: assert_s1_three_spots },
      { action: action_enable_s1_admin_manager },
      { assertion: assert_s1_manager_can_start_people_flow },
      { action: action_add_alice },
      { assertion: assert_s1_alice_exists },
      { assertion: assert_s1_alice_default_spot },
      { assertion: assert_s1_alice_preferences },
      { assertion: assert_s1_one_person },
      { action: action_edit_person_no_payload },
      { assertion: assert_s1_alice_unchanged },
      { action: action_add_bob },
      { assertion: assert_s1_two_people },
      { assertion: assert_s1_bob_preferences },
      { action: action_add_alice_duplicate },
      { assertion: assert_s1_still_two },
      { action: action_remove_bob },
      { assertion: assert_s1_one_after_remove },
      { assertion: assert_s1_bob_gone },

      // Priority reordering
      { assertion: assert_s2_alice_rank1 },
      { assertion: assert_s2_carol_rank3 },
      { action: action_move_carol_up },
      { assertion: assert_s2_carol_rank2 },
      { assertion: assert_s2_bob_rank3 },
      { action: action_move_alice_down },
      { assertion: assert_s2_alice_rank2 },

      // Spot management
      { assertion: assert_s3_three_spots },
      { action: action_add_spot7_without_admin },
      { assertion: assert_s3_non_admin_spot_blocked },
      { action: action_enable_s3_admin_manager },
      { assertion: assert_s3_can_manage_admins },
      { action: action_make_alice_spot_admin },
      { assertion: assert_s3_alice_is_admin },
      { action: action_add_spot7 },
      { assertion: assert_s3_four_spots },
      { assertion: assert_s3_spot7_label },
      { action: action_edit_spot_no_payload },
      { assertion: assert_s3_spot7_unchanged },
      { action: action_add_spot1_dup },
      { assertion: assert_s3_still_four },
      { action: action_remove_spot5 },
      { assertion: assert_s3_three_after_remove },
      { assertion: assert_s3_spot5_gone },

      // Request allocation
      { assertion: assert_s4_no_requests },
      { action: action_alice_request },
      { assertion: assert_s4_alice_allocated },
      { action: action_bob_request },
      { assertion: assert_s4_bob_allocated_pref },
      { action: action_carol_request },
      { assertion: assert_s4_carol_allocated },
      { action: action_alice_dupe },
      { assertion: assert_s4_alice_still_one_today },
      { assertion: assert_s4_dupe_result },
      { action: action_alice_tomorrow },
      { assertion: assert_s4_alice_tomorrow_allocated },

      // Denied when full
      { action: action_dave_request_denied },
      { assertion: assert_s5_dave_denied },

      // Cancellation
      { assertion: assert_s6_allocated },
      { action: action_cancel_alice },
      { assertion: assert_s6_cancelled },

      // Admin override
      { action: action_try_admin_override_without_admin },
      { assertion: assert_s7_non_admin_override_blocked },
      { action: action_enable_s7_admin_manager },
      { assertion: assert_s7_can_manage_admins },
      { action: action_make_alice_override_admin },
      { assertion: assert_s7_alice_is_admin },
      { action: action_admin_override_bob_spot5 },
      { assertion: assert_s7_bob_override },
      { action: action_admin_override_alice_spot5 },
      { assertion: assert_s7_alice_has_spot5 },
      { assertion: assert_s7_bob_spot5_cancelled },

      // Admin mode toggle
      { assertion: assert_s8_admin_off },
      { assertion: assert_s8_admin_view_locked },
      { action: action_toggle_admin },
      { assertion: assert_s8_admin_off },
      { action: action_enable_s8_admin_manager },
      { assertion: assert_s8_can_manage_admins },
      { assertion: assert_s8_admin_view_manager_enabled },
      { action: action_make_alice_mode_admin },
      { assertion: assert_s8_alice_is_admin },
      { assertion: assert_s8_admin_view_alice_admin },
      { action: action_toggle_admin },
      { assertion: assert_s8_admin_on },
      { assertion: assert_s8_admin_view_admin_mode_visible },
      { action: action_toggle_admin },
      { assertion: assert_s8_admin_off },

      // Vehicle data on people
      { action: action_s9a_add_with_vehicles },
      { assertion: assert_s9a_zara_has_vehicles },
      { action: action_s9b_add_blank_plate },
      { assertion: assert_s9b_blank_plate_dropped },
      { action: action_s9c_add_no_vehicles },
      { assertion: assert_s9c_no_vehicles_default },
      { action: action_s9d_edit_with_vehicles },
      { assertion: assert_s9d_vehicles_replaced },
      { action: action_s9d_edit_no_vehicles },
      { assertion: assert_s9d_vehicles_preserved },
      // Extended boundary tests
      { action: action_s9e_add_invalid_combo },
      { assertion: assert_s9e_model_dropped },
      { action: action_s9f_add_valid_combo },
      { assertion: assert_s9f_valid_combo_kept },
      { action: action_s9g_add_dupes },
      { assertion: assert_s9g_deduped },
      { action: action_s9h_add_invalid_color },
      { assertion: assert_s9h_invalid_color_cleared },
    ],
    s1,
    s2,
    s3,
    s4,
    s5,
    s6,
    s7,
    s8,
    s9a,
    s9b,
    s9c,
    s9d,
    s9e,
    s9f,
    s9g,
    s9h,
    // TODO(cfc-schema-ref): the CFC schema-ref resolver warns about
    // unsupported/unresolved $ref(s) in this pattern's schemas (logger "cfc",
    // fail-closed). Fix the schema(s), then drop this opt-out.
    allowConsoleWarnings: true,
  };
});
