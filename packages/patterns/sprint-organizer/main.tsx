import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

export type ItemStatus =
  | "todo"
  | "scoping"
  | "active"
  | "usable"
  | "done"
  | "cut";

/** One unit of work. Its `id` is stable: a cut item keeps its id. */
export interface WorkItem {
  id: string;
  /** The owning project's prefix. */
  project: string;
  component: string;
  /** The one person who answers for the item; "" when nobody does. */
  lead: string | Default<"">;
  withPeople: string[] | Default<[]>;
  /** The lead is a proposal, not a commitment. */
  tentative: boolean | Default<false>;
  status: ItemStatus | Default<"todo">;
  source: string | Default<"">;
  notes: string | Default<"">;
}

export interface Project {
  /** Short uppercase key that item ids are minted under, such as "GDN". */
  prefix: string;
  title: string;
  intent: string | Default<"">;
}

export interface PersonLoad {
  name: string;
  lead: string[];
  with: string[];
}

export type OrganizerView = "projects" | "people";

/** What `importAll` takes: a whole organizer, replacing the one held. */
export interface OrganizerSnapshot {
  title?: string;
  window?: string;
  people: string[];
  projects: Project[];
  items: WorkItem[];
}

interface SprintOrganizerInput {
  title?: PerSpace<Writable<string | Default<"Sprint organizer">>>;
  window?: PerSpace<Writable<string | Default<"">>>;
  people?: PerSpace<Writable<string[] | Default<[]>>>;
  projects?: PerSpace<Writable<Project[] | Default<[]>>>;
  items?: PerSpace<Writable<WorkItem[] | Default<[]>>>;
}

export interface SprintOrganizerOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  window: string;
  people: string[];
  projects: Project[];
  items: WorkItem[];
  load: PersonLoad[];
  unownedIds: string[];
  liveCount: number;
  ownedCount: number;
  summary: string;
  addPerson: Stream<{ name: string }>;
  addProject: Stream<{ prefix: string; title: string; intent?: string }>;
  addItem: Stream<{ project: string; component: string }>;
  assign: Stream<{ id: string; lead: string; tentative?: boolean }>;
  setWith: Stream<{ id: string; withPeople: string[] }>;
  dropHelper: Stream<{ id: string; name: string }>;
  setStatus: Stream<{ id: string; status: ItemStatus }>;
  importAll: Stream<OrganizerSnapshot>;
}

// ===== Helpers =====

const STATUS_ITEMS = [
  { label: "—", value: "todo" },
  { label: "scoping", value: "scoping" },
  { label: "active", value: "active" },
  { label: "usable", value: "usable" },
  { label: "done", value: "done" },
  { label: "cut", value: "cut" },
];

const ROW_GRID = "display: grid; gap: 8px; align-items: center; " +
  "grid-template-columns: 4.5rem minmax(12rem, 2fr) 9rem 5.5rem 12rem 7rem " +
  "minmax(8rem, 1fr);";

const isLive = (item: WorkItem): boolean => item.status !== "cut";

/** Whether a person is on an item without leading it. */
const helps = (item: WorkItem, name: string): boolean => {
  const names: readonly string[] = item.withPeople ?? [];
  return names.includes(name);
};

/** The number an id ends in, or 0 when it does not end in one. */
const idNumber = (id: string, prefix: string): number => {
  const match = id.startsWith(`${prefix}-`)
    ? Number(id.slice(prefix.length + 1))
    : 0;
  return Number.isInteger(match) && match > 0 ? match : 0;
};

/** The next id under a prefix. A cut item still holds its number. */
export const nextItemId = (
  items: readonly WorkItem[],
  prefix: string,
): string => {
  const highest = items.reduce(
    (max, item) => Math.max(max, idNumber(item.id, prefix)),
    0,
  );
  return `${prefix}-${highest + 1}`;
};

export const loadByPerson = (
  people: readonly string[],
  items: readonly WorkItem[],
): PersonLoad[] => {
  const live = items.filter(isLive);
  return people.map((name) => ({
    name,
    lead: live.filter((item) => item.lead === name).map((item) => item.id),
    with: live
      .filter((item) => helps(item, name))
      .map((item) => item.id),
  }));
};

// ===== Section and person sub-patterns =====

const ProjectSection = pattern<
  {
    project: Project;
    items: WorkItem[];
    personFilter: string;
    unownedOnly: boolean;
    leadChoices: { label: string; value: string }[];
    withChoices: { label: string; value: string }[];
    addItem: Stream<{ project: string; component: string }>;
    dropHelper: Stream<{ id: string; name: string }>;
  },
  { [UI]: VNode }
>((
  {
    project,
    items,
    personFilter,
    unownedOnly,
    leadChoices,
    withChoices,
    addItem,
    dropHelper,
  },
) => {
  const mine = computed(() =>
    items.filter((item) => item.project === project.prefix)
  );
  const shown = computed(() =>
    items.filter((item) => {
      if (item.project !== project.prefix) return false;
      if (unownedOnly && item.lead) return false;
      if (!personFilter) return true;
      return item.lead === personFilter ||
        helps(item, personFilter);
    })
  );
  const unownedCount = computed(() =>
    mine.filter((item) => isLive(item) && !item.lead).length
  );
  const liveCount = computed(() => mine.filter(isLive).length);
  const hasShown = computed(() => shown.length > 0);

  // The row is plain JSX rather than a pattern of its own. `shown` reads the
  // viewer's session-scoped filters, and row patterns mapped from such a list
  // do not mount in the shell.
  const rows = shown.map((item: WorkItem) => (
    <div style={ROW_GRID}>
      <cf-text variant="caption" style="font-family: monospace;">
        {item.id}
      </cf-text>
      <cf-input $value={item.component} placeholder="Component..." />
      <cf-select $value={item.lead} items={leadChoices} size="sm" />
      <cf-hstack gap="1" align="center">
        <cf-checkbox $checked={item.tentative} />
        <cf-text variant="caption" tone="muted">maybe</cf-text>
      </cf-hstack>
      <cf-vstack gap="1">
        <cf-hstack gap="1" wrap>
          {item.withPeople.map((name: string) => (
            <cf-chip
              label={name}
              size="xs"
              removable
              oncf-remove={() => dropHelper.send({ id: item.id, name })}
            />
          ))}
        </cf-hstack>
        <cf-autocomplete
          multiple
          $value={item.withPeople}
          items={withChoices}
          placeholder="Add someone..."
        />
      </cf-vstack>
      <cf-select $value={item.status} items={STATUS_ITEMS} size="sm" />
      <cf-input $value={item.notes} placeholder="Notes..." />
    </div>
  ));

  return {
    [UI]: (
      <cf-card>
        <cf-vstack gap="2">
          <cf-hstack justify="between" align="center">
            <cf-hstack gap="2" align="center">
              <cf-badge size="xs" color="neutral">{project.prefix}</cf-badge>
              <cf-heading level={5}>{project.title}</cf-heading>
            </cf-hstack>
            <cf-text variant="caption" tone="muted">
              {unownedCount} of {liveCount} unowned
            </cf-text>
          </cf-hstack>
          {project.intent
            ? <cf-text tone="muted" block>{project.intent}</cf-text>
            : null}
          {hasShown
            ? (
              <div style={ROW_GRID}>
                <cf-text variant="caption" tone="muted">ID</cf-text>
                <cf-text variant="caption" tone="muted">Component</cf-text>
                <cf-text variant="caption" tone="muted">Lead</cf-text>
                <cf-text variant="caption" tone="muted">Firm?</cf-text>
                <cf-text variant="caption" tone="muted">With</cf-text>
                <cf-text variant="caption" tone="muted">Status</cf-text>
                <cf-text variant="caption" tone="muted">Notes</cf-text>
              </div>
            )
            : null}
          {rows}
          <cf-message-input
            placeholder={computed(() => `Add a ${project.prefix} item...`)}
            oncf-send={(e: { detail?: { message?: string } }) => {
              const component = e.detail?.message?.trim();
              if (component) {
                addItem.send({ project: project.prefix, component });
              }
            }}
          />
        </cf-vstack>
      </cf-card>
    ),
  };
});

const PersonCard = pattern<{ entry: PersonLoad }, { [UI]: VNode }>((
  { entry },
) => ({
  [UI]: (
    <cf-card>
      <cf-vstack gap="1">
        <cf-hstack justify="between" align="center">
          <cf-heading level={5}>{entry.name}</cf-heading>
          <cf-text variant="caption" tone="muted">
            {computed(() => entry.lead.length)} lead ·{" "}
            {computed(() => entry.with.length)} with
          </cf-text>
        </cf-hstack>
        <cf-hstack gap="1" wrap>
          {entry.lead.map((id) => (
            <cf-badge size="xs" color="primary">{id}</cf-badge>
          ))}
          {entry.with.map((id) => (
            <cf-badge size="xs" color="neutral">{id}</cf-badge>
          ))}
        </cf-hstack>
      </cf-vstack>
    </cf-card>
  ),
}));

// ===== Pattern =====

export default pattern<SprintOrganizerInput, SprintOrganizerOutput>((
  { title, window, people, projects, items },
) => {
  // How one viewer is looking at the organizer. None of it is stored with the
  // plan, so two people filtering differently do not disturb each other.
  const view = new Writable.perSession<OrganizerView>("projects");
  /** Show only this person's items; "" shows everyone's. */
  const personFilter = new Writable.perSession("");
  const unownedOnly = new Writable.perSession(false);

  const addPerson = action(({ name }: { name: string }) => {
    const trimmed = name.trim();
    if (trimmed && !people.get().includes(trimmed)) people.push(trimmed);
  });

  const addProject = action(
    ({ prefix, title: projectTitle, intent }: {
      prefix: string;
      title: string;
      intent?: string;
    }) => {
      const key = prefix.trim().toUpperCase();
      const known = projects.get().some((project) => project.prefix === key);
      if (key && projectTitle.trim() && !known) {
        projects.push({
          prefix: key,
          title: projectTitle.trim(),
          intent: intent?.trim() ?? "",
        });
      }
    },
  );

  const addItem = action(
    ({ project, component }: { project: string; component: string }) => {
      const trimmed = component.trim();
      const known = projects.get().some((entry) => entry.prefix === project);
      if (trimmed && known) {
        items.push({
          id: nextItemId(items.get(), project),
          project,
          component: trimmed,
          lead: "",
          withPeople: [],
          tentative: false,
          status: "todo",
          source: "",
          notes: "",
        });
      }
    },
  );

  const assign = action(
    ({ id, lead, tentative }: {
      id: string;
      lead: string;
      tentative?: boolean;
    }) => {
      const index = items.get().findIndex((item) => item.id === id);
      if (index >= 0) {
        items.key(index).key("lead").set(lead);
        items.key(index).key("tentative").set(tentative ?? false);
      }
    },
  );

  const setWith = action(
    ({ id, withPeople }: { id: string; withPeople: string[] }) => {
      const index = items.get().findIndex((item) => item.id === id);
      if (index >= 0) items.key(index).key("withPeople").set(withPeople);
    },
  );

  const dropHelper = action(({ id, name }: { id: string; name: string }) => {
    const index = items.get().findIndex((item) => item.id === id);
    if (index >= 0) {
      const helpers: readonly string[] = items.get()[index]?.withPeople ?? [];
      items.key(index).key("withPeople").set(
        helpers.filter((helper) => helper !== name),
      );
    }
  });

  const setStatus = action(
    ({ id, status }: { id: string; status: ItemStatus }) => {
      const index = items.get().findIndex((item) => item.id === id);
      if (index >= 0) items.key(index).key("status").set(status);
    },
  );

  const importAll = action((snapshot: OrganizerSnapshot) => {
    if (snapshot.title !== undefined) title.set(snapshot.title);
    if (snapshot.window !== undefined) window.set(snapshot.window);
    people.set(snapshot.people);
    projects.set(snapshot.projects);
    items.set(snapshot.items);
  });

  const load = computed(() => loadByPerson(people.get(), items.get()));
  const unownedIds = computed(() =>
    items.get().filter((item) => isLive(item) && !item.lead).map((item) =>
      item.id
    )
  );
  const liveCount = computed(() => items.get().filter(isLive).length);
  const ownedCount = computed(() => liveCount - unownedIds.length);
  const summary = computed(() =>
    `${ownedCount} of ${liveCount} items have a lead; ` +
    load.map((entry) => `${entry.name} ${entry.lead.length}`).join(", ")
  );

  const leadChoices = computed(() => [
    { label: "— nobody —", value: "" },
    ...people.get().map((name) => ({ label: name, value: name })),
  ]);
  const withChoices = computed(() =>
    people.get().map((name) => ({ label: name, value: name }))
  );
  const filterChoices = computed(() => [
    { label: "Everyone", value: "" },
    ...people.get().map((name) => ({ label: name, value: name })),
  ]);

  const showProjects = computed(() => view.get() === "projects");

  const sections = projects.map((project: Project) => (
    <ProjectSection
      project={project}
      items={items}
      personFilter={personFilter}
      unownedOnly={unownedOnly}
      leadChoices={leadChoices}
      withChoices={withChoices}
      addItem={addItem}
      dropHelper={dropHelper}
    />
  ));

  const personCards = load.map((entry: PersonLoad) => (
    <PersonCard entry={entry} />
  ));

  return {
    [NAME]: computed(() => `${title.get()} (${ownedCount}/${liveCount})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="2" padding="4">
          <cf-hstack justify="between" align="center">
            <cf-heading level={3}>{title}</cf-heading>
            <cf-text tone="muted">
              {ownedCount} of {liveCount} items have a lead
            </cf-text>
          </cf-hstack>
          {window ? <cf-text tone="muted" block>{window}</cf-text> : null}
          <cf-tabs $value={view}>
            <cf-tab-list>
              <cf-tab value="projects">By project</cf-tab>
              <cf-tab value="people">By person</cf-tab>
            </cf-tab-list>
          </cf-tabs>
          <cf-hstack gap="3" align="center">
            <cf-select
              $value={personFilter}
              items={filterChoices}
              size="sm"
              style="width: 14rem;"
            />
            <cf-hstack gap="1" align="center">
              <cf-checkbox $checked={unownedOnly} />
              <cf-text variant="caption">Unowned only</cf-text>
            </cf-hstack>
          </cf-hstack>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          {showProjects
            ? <cf-vstack gap="3" padding="4">{sections}</cf-vstack>
            : (
              <cf-vstack gap="3" padding="4">
                {personCards}
                <cf-card>
                  <cf-vstack gap="1">
                    <cf-heading level={5}>Unowned</cf-heading>
                    <cf-hstack gap="1" wrap>
                      {unownedIds.map((id) => (
                        <cf-badge size="xs" color="danger">{id}</cf-badge>
                      ))}
                    </cf-hstack>
                  </cf-vstack>
                </cf-card>
                <cf-message-input
                  placeholder="Add a person..."
                  oncf-send={(e: { detail?: { message?: string } }) => {
                    const name = e.detail?.message?.trim();
                    if (name) addPerson.send({ name });
                  }}
                />
              </cf-vstack>
            )}
        </cf-vscroll>
      </cf-screen>
    ),
    title,
    window,
    people,
    projects,
    items,
    load,
    unownedIds,
    liveCount,
    ownedCount,
    summary,
    addPerson,
    addProject,
    addItem,
    assign,
    setWith,
    dropHelper,
    setStatus,
    importAll,
  };
});
