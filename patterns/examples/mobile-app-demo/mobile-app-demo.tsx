import {
  action,
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// deno-lint-ignore no-empty-interface
interface MobileAppDemoInput {}
export interface MobileAppDemoOutput {
  [NAME]: string;
  [UI]: VNode;
}

const IOS_HOME_THEME = {
  borderRadius: "18px",
  colors: {
    surface: {
      light: "rgba(255, 255, 255, 0.72)",
      dark: "rgba(255, 255, 255, 0.08)",
    },
    surfaceHover: {
      light: "rgba(255, 255, 255, 0.88)",
      dark: "rgba(255, 255, 255, 0.14)",
    },
  },
};

type TaskItem = {
  title: string;
  detail: string;
  meta: string;
  actionLabel: string;
  actionTone: "blue" | "coral" | "graphite";
  section: "Needs action" | "Knock something out";
};

type ShortcutItem = {
  icon: string;
  title: string;
  subtitle: string;
};

type ArtifactItem = {
  title: string;
  tint: string;
};

type TabContent = {
  heading: string;
  subtitle?: string;
  tasks?: TaskItem[];
  shortcuts?: ShortcutItem[];
  artifacts?: ArtifactItem[];
  items?: { title: string; detail: string; meta: string }[];
};

const TASK_SECTIONS: Array<"Needs action" | "Knock something out"> = [
  "Needs action",
  "Knock something out",
];

const HOME_CONTENT: TabContent = {
  heading: "Good evening.",
  subtitle: "Last woven just now",
  tasks: [
    {
      title: "Schedule an appointment with a vet specializing in GI",
      detail: "Pet care",
      meta: "Needs action",
      actionLabel: "Review",
      actionTone: "blue",
      section: "Needs action",
    },
    {
      title: "Prepare slides for all-hands meeting",
      detail: "Work",
      meta: "Needs action",
      actionLabel: "Launch",
      actionTone: "coral",
      section: "Needs action",
    },
    {
      title: "Draft the Pattern implementation for the new home surface",
      detail: "Fabric",
      meta: "Ready",
      actionLabel: "Start",
      actionTone: "graphite",
      section: "Knock something out",
    },
    {
      title: "Triage the latest partner threads before tomorrow morning",
      detail: "Comms",
      meta: "Fresh",
      actionLabel: "Reply",
      actionTone: "blue",
      section: "Knock something out",
    },
  ],
  shortcuts: [
    { icon: "✦", title: "Answer", subtitle: "questions" },
    { icon: "◎", title: "Create", subtitle: "pattern" },
    { icon: "▤", title: "Learn", subtitle: "about Fabric" },
    { icon: "◌", title: "Review", subtitle: "activity" },
  ],
  artifacts: [
    { title: "Launch brief", tint: "#ece9ff" },
    { title: "Roadmap v2", tint: "#dfeaff" },
    { title: "Brand draft", tint: "#ffe9df" },
    { title: "Workspace map", tint: "#e5f6ef" },
  ],
};

const tabContent: Record<string, TabContent> = {
  home: HOME_CONTENT,
  search: {
    heading: "Search",
    items: [
      {
        title: "Navigation shell feedback",
        detail: "3 results",
        meta: "Thread",
      },
      { title: "Pattern deploy notes", detail: "7 results", meta: "Document" },
      { title: "Mobile home surface", detail: "12 results", meta: "Project" },
    ],
  },
  inbox: {
    heading: "Inbox",
    items: [
      {
        title: "Design review moved to Friday",
        detail: "From: Alex",
        meta: "2h ago",
      },
      {
        title: "Pattern deploy notes ready",
        detail: "From: Sam",
        meta: "4h ago",
      },
      {
        title: "New comments from research team",
        detail: "From: Jordan",
        meta: "Yesterday",
      },
      {
        title: "Fabric sync: nav shell feedback",
        detail: "From: Chris",
        meta: "Yesterday",
      },
    ],
  },
  profile: {
    heading: "Profile",
    items: [
      { title: "Edit display name", detail: "Settings", meta: "Account" },
      {
        title: "Notification preferences",
        detail: "Settings",
        meta: "Alerts",
      },
      { title: "Connected apps", detail: "2 active", meta: "Integrations" },
    ],
  },
};

function chipColor(
  tone: "blue" | "coral" | "graphite",
): "primary" | "accent" | "neutral" {
  if (tone === "blue") {
    return "primary";
  }
  if (tone === "coral") {
    return "accent";
  }
  return "neutral";
}

export default pattern<MobileAppDemoInput, MobileAppDemoOutput>(() => {
  const activeTab = new Writable("home");
  const sheetOpen = new Writable(false);
  const toastOpen = new Writable(false);

  const openSheet = action(() => sheetOpen.set(true));
  const closeSheet = action(() => sheetOpen.set(false));
  const handleCreate = action(() => {
    sheetOpen.set(false);
    toastOpen.set(true);
  });
  const dismissToast = action(() => toastOpen.set(false));

  return {
    [NAME]: "Mobile App Demo",
    [UI]: (
      <cf-theme theme={IOS_HOME_THEME}>
        <cf-screen>
          {computed(() => {
            const tab = activeTab.get();
            const content = tabContent[tab] ?? tabContent.home;
            const isHome = tab === "home";

            if (isHome) {
              const home = content as typeof HOME_CONTENT;
              return (
                <cf-vscroll style="padding: 0 16px 100px;">
                  <cf-vstack gap="4" style="padding-top: 8px;">
                    {/* Header */}
                    <div>
                      <cf-heading
                        level={1}
                        style="font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -0.05em; line-height: 1.05; margin: 0 0 4px;"
                      >
                        {home.heading}
                      </cf-heading>
                      <cf-text variant="body-large" tone="muted">
                        {home.subtitle}
                      </cf-text>
                    </div>

                    {/* Task sections */}
                    {TASK_SECTIONS.map((
                      section: "Needs action" | "Knock something out",
                    ) => (
                      <cf-vstack gap="2">
                        <cf-hstack align="center" justify="between">
                          <cf-text variant="caption" tone="muted">
                            {section}
                          </cf-text>
                          <cf-text variant="body" tone="muted">
                            ›
                          </cf-text>
                        </cf-hstack>
                        <cf-separator />
                        <cf-vstack gap="2">
                          {(home.tasks ?? [])
                            .filter((t: TaskItem) => t.section === section)
                            .map((task: TaskItem) => (
                              <cf-card style="--cf-card-background: var(--cf-theme-color-surface);">
                                <cf-hstack align="start" justify="between">
                                  <cf-vstack
                                    gap="1"
                                    style="flex: 1; min-width: 0;"
                                  >
                                    <cf-text variant="body-compact" block>
                                      {task.title}
                                    </cf-text>
                                    <cf-text variant="caption" tone="muted">
                                      {task.detail}
                                    </cf-text>
                                  </cf-vstack>
                                  <cf-chip
                                    label={task.actionLabel}
                                    size="sm"
                                    color={chipColor(task.actionTone)}
                                  />
                                </cf-hstack>
                              </cf-card>
                            ))}
                        </cf-vstack>
                      </cf-vstack>
                    ))}

                    {/* Shortcuts */}
                    <cf-vstack gap="2">
                      <cf-hstack align="center" justify="between">
                        <cf-text variant="caption" tone="muted">
                          Shortcuts
                        </cf-text>
                        <cf-text variant="body" tone="muted">
                          ›
                        </cf-text>
                      </cf-hstack>
                      <cf-separator />
                      <cf-hscroll fadeEdges>
                        <cf-hstack gap="3" style="padding-bottom: 4px;">
                          {(home.shortcuts ?? []).map((sc: ShortcutItem) => (
                            <cf-card style="--cf-card-background: var(--cf-theme-color-surface); --cf-card-backdrop-blur: 8px; min-width: 88px; width: 88px;">
                              <cf-vstack
                                gap="1"
                                align="center"
                                style="padding: 4px 0; text-align: center;"
                              >
                                <cf-text variant="body-large" tone="muted">
                                  {sc.icon}
                                </cf-text>
                                <cf-text variant="caption">
                                  {sc.title}
                                </cf-text>
                                <cf-text variant="caption" tone="muted">
                                  {sc.subtitle}
                                </cf-text>
                              </cf-vstack>
                            </cf-card>
                          ))}
                        </cf-hstack>
                      </cf-hscroll>
                    </cf-vstack>

                    {/* Artifacts */}
                    <cf-vstack gap="2">
                      <cf-hstack align="center" justify="between">
                        <cf-text variant="caption" tone="muted">
                          Recent artifacts
                        </cf-text>
                        <cf-text variant="body" tone="muted">
                          ›
                        </cf-text>
                      </cf-hstack>
                      <cf-separator />
                      <cf-grid columns="2" gap="3">
                        {(home.artifacts ?? []).map((
                          artifact: ArtifactItem,
                        ) => (
                          <div
                            style={`background: linear-gradient(145deg, var(--cf-theme-color-surface), ${artifact.tint}); height: 120px; border-radius: var(--cf-theme-border-radius, 0.5rem); border: 1px solid var(--cf-theme-color-border, rgba(67,75,97,0.10)); display: flex; align-items: flex-end; padding: 12px;`}
                          >
                            <cf-text variant="caption" tone="muted">
                              {artifact.title}
                            </cf-text>
                          </div>
                        ))}
                      </cf-grid>
                    </cf-vstack>
                  </cf-vstack>
                </cf-vscroll>
              );
            }

            // Non-home tabs: simple card list
            const items = content.items ?? [];
            return (
              <cf-vscroll style="padding: 0 16px 100px;">
                <cf-vstack gap="3" style="padding-top: 8px;">
                  <cf-heading level={3} style="margin: 12px 0 4px;">
                    {content.heading}
                  </cf-heading>
                  {items.map((
                    item: { title: string; detail: string; meta: string },
                  ) => (
                    <cf-card>
                      <cf-vstack gap="1">
                        <cf-text variant="body-compact">{item.title}</cf-text>
                        <cf-hstack justify="between">
                          <cf-text variant="caption" tone="muted">
                            {item.detail}
                          </cf-text>
                          <cf-text variant="caption" tone="muted">
                            {item.meta}
                          </cf-text>
                        </cf-hstack>
                      </cf-vstack>
                    </cf-card>
                  ))}
                </cf-vstack>
              </cf-vscroll>
            );
          })}

          <cf-tab-bar $value={activeTab} variant="inset" slot="footer">
            <cf-tab-bar-item value="home" label="Home">
              <span slot="icon">&#127968;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="search" label="Search">
              <span slot="icon">&#128269;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="inbox" label="Inbox">
              <span slot="icon">&#128236;</span>
            </cf-tab-bar-item>
            <cf-tab-bar-item value="profile" label="Profile">
              <span slot="icon">&#128100;</span>
            </cf-tab-bar-item>
            <cf-button
              slot="action"
              color="primary"
              variant="solid"
              size="icon"
              onClick={openSheet}
            >
              &#65291;
            </cf-button>
          </cf-tab-bar>

          <cf-modal
            $open={sheetOpen}
            presentation="sheet"
            grabber
            detent="half"
            dismissable
          >
            <div slot="header">
              <cf-heading level={5}>New Task</cf-heading>
            </div>
            <cf-vstack gap="3" style="padding: 4px 0;">
              <cf-textarea
                placeholder="What needs to be done?"
                style="min-height: 80px;"
              />
            </cf-vstack>
            <div slot="footer">
              <cf-hstack gap="2" justify="end" style="width: 100%;">
                <cf-button
                  color="neutral"
                  variant="outline"
                  onClick={closeSheet}
                >
                  Cancel
                </cf-button>
                <cf-button
                  color="primary"
                  variant="solid"
                  onClick={handleCreate}
                >
                  Create
                </cf-button>
              </cf-hstack>
            </div>
          </cf-modal>

          <cf-toast-provider position="bottom">
            <cf-toast
              open={toastOpen}
              status="success"
              duration={4000}
              oncf-toast-dismiss={dismissToast}
            >
              Task created.
              <cf-button
                slot="action"
                color="neutral"
                variant="ghost"
                size="sm"
              >
                View
              </cf-button>
            </cf-toast>
          </cf-toast-provider>
        </cf-screen>
      </cf-theme>
    ),
  };
});
