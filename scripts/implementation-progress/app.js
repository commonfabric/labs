/** Renders implementation status and recorded read-cost intervals. */

const labels = {
  done: "Landed",
  review: "In review",
  active: "In progress",
  next: "Next / unblocked",
  todo: "To do",
};
let status;
let demo;
let filter = "all";
const byId = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};
const metric = (label, value) => {
  const element = node("div", "", "metric");
  element.append(node("strong", value.toLocaleString()), node("span", label));
  return element;
};
function renderStages() {
  byId("stages").replaceChildren(
    ...status.stages.filter((stage) =>
      filter === "all" || stage.status === filter
    ).map((stage) => {
      const card = node("article", "", "card");
      card.append(
        node("span", labels[stage.status], `badge ${stage.status}`),
        node("h3", `${stage.id} · ${stage.title}`),
        node("p", stage.detail),
      );
      return card;
    }),
  );
  for (const button of byId("filters").children) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.filter === filter),
    );
  }
}
function renderInterval() {
  const interval = demo.intervals[Number(byId("interval").value)];
  byId("demo-summary").replaceChildren(
    metric("completed runs", interval.runs),
    metric("proxy accesses", interval.accesses),
    metric("actual link hops", interval.hops),
  );
  byId("rows").replaceChildren(...interval.rows.map((row) => {
    const tr = node("tr", "");
    const source = node("td", row.source);
    const bar = node("div", "", "bar");
    bar.style.width = `${100 * row.accesses / Math.max(1, interval.accesses)}%`;
    source.append(bar);
    tr.append(
      source,
      ...["runs", "accesses", "hops", "documents", "dependencies"]
        .map((key) => node("td", row[key].toLocaleString())),
    );
    return tr;
  }));
}
async function refresh() {
  try {
    const responses = await Promise.all([
      fetch("/status.json"),
      fetch("/demo.json"),
    ]);
    if (responses.some((response) => !response.ok)) {
      throw new Error("Status unavailable");
    }
    [status, demo] = await Promise.all(
      responses.map((response) => response.json()),
    );
    byId("activity").textContent = status.activity;
    byId("updated").textContent = `Status updated ${
      new Date(status.updated).toLocaleString()
    } · Validated implementation ${status.validatedRevision}`;
    byId("design").href = status.design;
    byId("pr").href = status.pr;
    byId("pr").textContent = `PR #${
      new URL(status.pr).pathname.split("/").at(-1)
    }`;
    byId("review").textContent = status.review;
    byId("checks").replaceChildren(
      ...status.checks.map((check) => node("li", check)),
    );
    byId("summary").replaceChildren(
      ...["done", "review", "active", "next", "todo"].map((key) =>
        metric(
          labels[key],
          status.stages.filter((stage) => stage.status === key).length,
        )
      ),
    );
    byId("question-list").replaceChildren(
      ...status.questions.map((question) => {
        const card = node("article", "", "card");
        card.append(
          node("span", question.status, "badge review"),
          node("h3", `${question.id} · ${question.title}`),
          node("p", question.proposal),
          node("p", `Blocks: ${question.blocks}`, "muted"),
        );
        return card;
      }),
    );
    byId("milestones").replaceChildren(...status.milestones.map((milestone) => {
      const card = node("article", "", "card");
      card.append(
        node("span", milestone.state, "badge"),
        node("h3", milestone.title),
        node("p", milestone.detail),
      );
      return card;
    }));
    const selected = byId("interval").value;
    byId("interval").replaceChildren(
      ...demo.intervals.map((interval, index) => {
        const option = node(
          "option",
          `${interval.label}${index === 5 ? " · vote update" : ""}`,
        );
        option.value = String(index);
        return option;
      }),
    );
    byId("interval").value = selected || "5";
    byId("command").textContent = demo.command;
    byId("recorded-command").textContent = demo.recordedCommand;
    byId("provenance").textContent = `Recorded ${demo.date} · ${demo.revision}`;
    byId("budget-provenance").textContent = demo.budgets?.provenance ??
      "Recording budget enforcement demo…";
    byId("browser-provenance").textContent = demo.browser?.provenance ?? "";
    byId("browser-runs").replaceChildren(
      ...(demo.browser?.runs ?? []).map((run) => {
        const card = node("article", "", "card");
        card.append(
          node("h3", `${run.voteCount.toLocaleString()} votes`),
          node(
            "p",
            `${run.sample.accesses.toLocaleString()} body accesses · ${run.sample.linkHops.toLocaleString()} link hops · ${run.sample.runs} runs · ${run.sample.maxAccesses.toLocaleString()} largest run`,
          ),
          node(
            "p",
            `${run.sample.eventCommits} successful event commits · ${run.sample.eventCommitErrors} errors · local p75 ${run.p75Ms} ms`,
          ),
        );
        const link = node("a", "");
        link.href = run.screenshot;
        const img = node("img", "");
        img.src = run.screenshot;
        img.alt = `Rendered lunch poll after a vote, ${run.voteCount} votes`;
        img.style.width = "100%";
        link.append(img);
        card.append(link);
        return card;
      }),
    );
    byId("budget-runs").replaceChildren(
      ...(demo.budgets?.runs ?? []).map((run) => {
        const card = node("article", "", "card");
        card.append(
          node("span", run.outcome, "badge"),
          node("h3", run.title),
          node("p", run.detail),
        );
        const details = node("details", "");
        details.append(
          node("summary", "CLI evidence and reproduction"),
          node("pre", run.output),
          node("pre", run.command),
        );
        card.append(details);
        return card;
      }),
    );
    renderStages();
    renderInterval();
    byId("error").textContent = "";
  } catch (error) {
    byId("error").textContent =
      `Could not refresh: ${error.message}. Displayed data may be stale.`;
  }
}
for (const [key, label] of Object.entries({ all: "All stages", ...labels })) {
  const button = node("button", label);
  button.dataset.filter = key;
  button.onclick = () => {
    filter = key;
    renderStages();
  };
  byId("filters").append(button);
}
byId("interval").onchange = renderInterval;
const events = new EventSource("/events");
events.onopen = () => {
  byId("connection").textContent = "Live file updates connected";
};
events.onmessage = refresh;
events.onerror = () => {
  byId("connection").textContent = "Disconnected · displayed data may be stale";
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
refresh();
