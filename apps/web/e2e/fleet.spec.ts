import { expect, test } from "@playwright/test";

import { requiresToolsNotice } from "../src/lib/archetypeConfig";
import { CONFIGURE_REQUIRED_COPY, HARD_GATE_HINT, HARD_GATE_HINT_COLLAPSED } from "../src/lib/pickerCopy";
import { ARCHETYPES } from "./fixtures.mjs";

// Fleet manager + archetype picker (Settings → Agents, ADR 0042). Drives the live
// control-plane endpoints (mocked): list, create from an archetype, stop. The mock
// FLEET is shared module state, so run serially + assert by presence (not exact counts).

test.describe.configure({ mode: "serial" });

// This spec MUTATES the mock fleet (create / stop / rename / add-remote). Claim a
// private fleet scope (the mock keys state on x-e2e-fleet) and reset it to baseline
// before every test — including serial-group retries — so a write can never leak
// into the next test, a retry, or another spec. The scope is keyed on the parallel
// worker so even concurrent runners (repeat-each, if mode:serial is ever lifted)
// stay isolated from each other.
test.beforeEach(async ({ page }, testInfo) => {
  const scope = `fleet-spec-${testInfo.parallelIndex}`;
  await page.setExtraHTTPHeaders({ "x-e2e-fleet": scope }); // app fetches carry it
  await page.request.post("/api/__test__/fleet/reset", { headers: { "x-e2e-fleet": scope } });
});

async function openFleet(page) {
  // Fleet lives in the Box group of the consolidated settings dialog (host console), opened
  // from the header hamburger → app drawer → Settings (folded in from the old Box rail surface).
  await page.getByTestId("header-menu").click();
  await page.getByTestId("app-drawer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-overlay .pl-sidenav").getByRole("tab", { name: "Fleet", exact: true }).click();
}

async function openAgents(page) {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleet(page);
}

// Fleet lives in the consolidated settings dialog (a modal) now, so its backdrop intercepts
// the topbar switcher — close it before interacting with the top bar.
async function closeOverlay(page) {
  await page.locator(".settings-overlay .pl-dialog__close").click();
  await expect(page.locator(".settings-overlay")).toHaveCount(0);
}

test("Agents tab lists the host (this instance) + peers, host active by default", async ({ page }) => {
  await openAgents(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  // The host self-registers — it's always present + marked "this instance", and focused
  // (active) when no peer is — so the panel is never "0 agents".
  await expect(page.getByText("this instance").first()).toBeVisible(); // DS Badge (#832)
  await expect(page.locator(".fleet-row.active .fleet-name")).toContainText("main");
  await expect(page.locator(".fleet-row", { hasText: "ava" })).toBeVisible();
  await expect(page.locator(".fleet-row", { hasText: "roxy" })).toBeVisible();
  // The host row has no stop/remove (can't act on itself); peers do.
  await expect(page.locator(".fleet-row", { hasText: "main" }).getByRole("button")).toHaveCount(0);
});

test("New agent → archetype picker → create navigates into the new agent", async ({ page }) => {
  await openAgents(page);
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
  await expect(page.locator(".pl-radiocard")).toHaveCount(2); // DS RadioCard, from GET /api/archetypes (Custom filtered out)
  await page.locator(".pl-radiocard", { hasText: "Product Manager" }).click();
  await page.getByLabel("Agent name").fill("newbot");
  await page.getByRole("button", { name: /Create/ }).click();
  // Create lands the operator IN the new agent's console — the id is the URL slug
  // (ADR 0042, the same navigation the FleetSwitcher uses) — because the next move is
  // configuring the agent just made, not re-reading the fleet list.
  await expect(page).toHaveURL(/\/app\/agent\/newbot-ab12\//);
  await expect(page.getByTestId("fleet-switcher")).toContainText("newbot");
});

test("New agent → configure a bundle's MCP inputs → create seeds them (#2041)", async ({ page }) => {
  await openAgents(page);

  // Capture the create payload — the Configure step must carry the operator's inputs.
  let posted = null;
  await page.route("**/api/fleet", async (route) => {
    if (route.request().method() === "POST") posted = route.request().postDataJSON();
    return route.continue();
  });

  await page.getByRole("button", { name: "New agent" }).click();
  await page.locator(".pl-radiocard", { hasText: "Product Manager" }).click();

  // The picked bundle asks for a GitHub token (secret, masked) + declares a Brave secret;
  // both surface in the inline Configure step (the preview peek supplies them).
  const token = page.getByLabel("GitHub token");
  await expect(token).toBeVisible();
  await expect(page.getByLabel("Brave API key")).toBeVisible();
  await token.fill("ghp_secret");

  await page.getByLabel("Agent name").fill("ghbot");
  await page.getByRole("button", { name: /Create/ }).click();

  // Create navigates into the new agent (see the picker test above); reaching the slug
  // URL also proves the POST has been captured before the payload assertions below.
  await expect(page).toHaveURL(/\/app\/agent\/ghbot-ab12\//);
  expect(posted?.inputs).toEqual({ github_token: "ghp_secret" });
  // The Brave secret was left blank → dropped (env-only fallback), not sent as an empty value.
  expect(posted?.secrets ?? []).toEqual([]);
});

test("New agent preview dialog lists the bundle's MCP servers + secrets (#2041)", async ({ page }) => {
  await openAgents(page);
  await page.getByRole("button", { name: "New agent" }).click();
  await page.locator(".pl-radiocard", { hasText: "Product Manager" }).click();
  await page.getByRole("button", { name: /See what.s included/ }).click();

  const dialog = page.locator(".pl-dialog", { hasText: "What's included" });
  await expect(dialog.getByText("MCP servers: GitHub (needs token)")).toBeVisible();
  await expect(dialog.getByText("Secrets: Brave API key")).toBeVisible();
});

// ── The archetype picker's hard gate (#2977/#2979/#2984) ──────────────────────────
// A required bundle `config_inputs` answer has no env fallback — the server refuses the
// create — so the picker must not offer a Create that can only 400. The Project Manager
// fixture is the contract-carrying, advanced archetype with two such answers.

// Open the picker and pick the (advanced, collapsed) Project Manager card.
async function pickProjectManager(page) {
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("button", { name: /^Advanced \(1\)/ }).click();
  await page.locator(".pl-radiocard", { hasText: "Project Manager" }).click();
  // The Configure step is open by default; its fields come from the preview peek.
  await expect(page.getByLabel("Repository path")).toBeVisible();
}

// The DS DropdownSelect trigger carries the field id (origin:key — escape the colon/dot).
const coderTrigger = (page) => page.locator('[id="config:project_board.coder"]');
const createButton = (page) => page.getByRole("button", { name: /^Create/ });
// The contract note, computed by the same helper the card renders with — the spec and
// the component can't drift apart on wording.
const PM = ARCHETYPES.find((a) => a.id === "project-manager");
const PM_CONTRACT_NOTICE = requiresToolsNotice(PM.label, PM.requires_tools);

test("picking the Project Manager archetype shows its capability contract under the card (#2979)", async ({ page }) => {
  await openAgents(page);
  await pickProjectManager(page);
  // The contract note names the tool the persona commits to — at choose-time, so a
  // contract break is a known trade-off rather than a post-boot banner.
  await expect(page.getByRole("note").filter({ hasText: PM_CONTRACT_NOTICE })).toBeVisible();
  // The toggle copy says the answers are required, not "optional — skip".
  await expect(page.getByRole("button", { name: /Configure Project Manager/ })).toContainText(CONFIGURE_REQUIRED_COPY);
});

test("Create stays disabled while a required bundle answer is blank; the hint says why (#2977)", async ({ page }) => {
  await openAgents(page);
  await pickProjectManager(page);
  await page.getByLabel("Agent name").fill("pmbot");
  // A valid name alone isn't enough: the two hard-required answers are blank.
  await expect(createButton(page)).toBeDisabled();
  await expect(page.getByText(HARD_GATE_HINT, { exact: true })).toBeVisible();
  // Required fields are starred; the optional string and the defaulted boolean are not.
  await expect(page.locator(".archetype-configure-fields label", { hasText: "Repository path *" })).toBeVisible();
  await expect(page.locator(".archetype-configure-fields label", { hasText: "Coding delegate *" })).toBeVisible();
  await expect(page.locator(".archetype-configure-fields label", { hasText: "Default branch" })).not.toContainText("*");
  await expect(page.locator(".archetype-configure-fields label", { hasText: "Auto-merge green PRs" })).not.toContainText("*");
  // Filling just ONE of the two keeps the gate shut.
  await page.getByLabel("Repository path").fill("/Users/me/dev/repo");
  await expect(createButton(page)).toBeDisabled();
});

test("the coding-delegate dropdown lists ONLY acp delegates (#2934)", async ({ page }) => {
  await openAgents(page);
  await pickProjectManager(page);
  // DropdownSelect (#274): open the trigger, then read the portaled menu items.
  await coderTrigger(page).click();
  await expect(page.getByRole("menuitemradio", { name: "coder", exact: true })).toBeVisible();
  // /api/delegates also serves an openai endpoint ("opus") and an a2a peer ("peer-pm") —
  // neither can take a build, so neither may be offered as the coder.
  await expect(page.getByRole("menuitemradio", { name: "opus", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitemradio", { name: "peer-pm", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Enter in the Name field does NOT submit while a required answer is blank (#2979)", async ({ page }) => {
  await openAgents(page);
  const posted = [];
  await page.route("**/api/fleet", async (route) => {
    if (route.request().method() === "POST") posted.push(route.request().postDataJSON());
    return route.continue();
  });
  await pickProjectManager(page);
  const name = page.getByLabel("Agent name");
  await name.fill("pmbot");
  await name.press("Enter");
  await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
  await expect(createButton(page)).toBeDisabled();

  // Positive control, and the proof the gated press above has fully run: the console
  // keeps an event stream open so there is no network-idle to wait for — instead, fill
  // the answers and press Enter AGAIN. The keyboard path still submits when ungated, and
  // the one POST that lands carries the answers; a gated press that had fired would have
  // landed first (same page, same handler) and be sitting in `posted` ahead of it.
  await page.getByLabel("Repository path").fill("/Users/me/dev/repo");
  await coderTrigger(page).click();
  await page.getByRole("menuitemradio", { name: "coder", exact: true }).click();
  await expect(createButton(page)).toBeEnabled();
  await name.press("Enter");
  await expect(page).toHaveURL(/\/app\/agent\/pmbot-ab12\//);
  expect(posted).toHaveLength(1);
  expect(posted[0].config_inputs).toEqual({ "project_board.repo": "/Users/me/dev/repo", "project_board.coder": "coder" });
});

test("collapsing Configure with a required answer blank shows the collapsed-state hint (#2979)", async ({ page }) => {
  await openAgents(page);
  await pickProjectManager(page);
  await page.getByLabel("Agent name").fill("pmbot");
  const toggle = page.getByRole("button", { name: /Configure Project Manager/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The fields are gone but the explanation is not — the hint moved OUT of the collapsible
  // block so a disabled Create never reads as a mystery.
  await expect(page.getByLabel("Repository path")).toHaveCount(0);
  await expect(page.getByText(HARD_GATE_HINT_COLLAPSED, { exact: true })).toBeVisible();
  await expect(createButton(page)).toBeDisabled();
});

test("filling both required answers enables Create; config_inputs ride the POST even after collapsing Configure (#2979)", async ({ page }) => {
  await openAgents(page);
  let posted = null;
  await page.route("**/api/fleet", async (route) => {
    if (route.request().method() === "POST") posted = route.request().postDataJSON();
    return route.continue();
  });
  await pickProjectManager(page);
  await page.getByLabel("Agent name").fill("pmbot");

  await page.getByLabel("Repository path").fill("/Users/me/dev/repo");
  await coderTrigger(page).click();
  await page.getByRole("menuitemradio", { name: "coder", exact: true }).click();
  await expect(createButton(page)).toBeEnabled();
  await expect(page.getByText(HARD_GATE_HINT, { exact: true })).toHaveCount(0);

  // The fill-then-collapse regression (QA panel on #2979): the answers were collected but
  // the mutation only sent config values while Configure was open → server 400.
  await page.getByRole("button", { name: /Configure Project Manager/ }).click();
  await expect(page.getByLabel("Repository path")).toHaveCount(0);
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();

  // Create navigates into the new agent; reaching the slug URL proves the POST was captured.
  await expect(page).toHaveURL(/\/app\/agent\/pmbot-ab12\//);
  expect(posted?.config_inputs).toEqual({ "project_board.repo": "/Users/me/dev/repo", "project_board.coder": "coder" });
  // The contract rides along so the member's workspace.yaml records it (ADR 0100).
  expect(posted?.requires_tools).toEqual(["github_create_issue"]);
  expect(posted?.bundle).toBe("https://github.com/protoLabsAI/project-manager-archetype");
});

test("stop a running agent flips its status dot", async ({ page }) => {
  await openAgents(page);
  const ava = page.locator(".fleet-row", { hasText: "ava" });
  // ava starts running; if a prior test already stopped it, the Start button is shown instead.
  const stop = ava.getByRole("button", { name: "Stop" });
  if (await stop.count()) {
    await stop.click();
    // Stopped agents drop the success dot and surface a Start button.
    await expect(ava.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(ava.locator(".pl-dot--success")).toHaveCount(0);
  }
});

test("topbar switcher navigates to an agent by slug", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  const trigger = page.getByTestId("fleet-switcher");
  await expect(trigger).toBeVisible(); // present because the mock fleet has agents
  await trigger.click();
  const roxy = page.getByRole("menuitem", { name: /roxy/ });
  await expect(roxy).toBeVisible();
  await roxy.click();
  // Slug routing (ADR 0042): picking an agent navigates to its own URL — each window is its
  // own agent. After the nav, the console is focused on roxy.
  await expect(page).toHaveURL(/\/app\/agent\/roxy\//);
  await expect(page.getByTestId("fleet-switcher")).toContainText("roxy");
});

test("a fleet row's name links to that agent's own window (#2240)", async ({ page }) => {
  await openAgents(page);
  // A peer's name is the click-through — a real <a href> (so cmd/middle-click opens it in a
  // new window), pointing at the SLUG: the stable id, never the editable display name.
  const roxy = page.locator(".fleet-row", { hasText: "roxy" }).locator(".fleet-name-link");
  await expect(roxy).toHaveAttribute("href", /\/agent\/roxy\/$/);
  // The focused agent's own row stays plain text — a link there is just a reload.
  await expect(page.locator(".fleet-row.active .fleet-name-link")).toHaveCount(0);
  await roxy.click();
  await expect(page).toHaveURL(/\/app\/agent\/roxy\//);
});

test("a member that IS a delegate can be unlinked from its row (#2266)", async ({ page }) => {
  // Stub the slug-scoped registry so ava reads as an existing delegate, and capture the
  // removal. Stateful on purpose: after the DELETE the list comes back empty, and the row
  // flipping to the add button is the ONLY success feedback the panel gives (no toast).
  let delegates = [{ name: "ava", type: "a2a", url: "http://127.0.0.1:7890/a2a" }];
  let deleted = null;
  await page.route("**/api/delegates", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { delegates } });
  });
  await page.route("**/api/delegates/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    delegates = [];
    return route.fulfill({ json: { ok: true, message: "Removed.", delegates } });
  });

  await openAgents(page);
  const ava = page.locator(".fleet-row", { hasText: "ava" });
  await expect(ava.getByText("delegate")).toBeVisible(); // the state badge
  await ava.getByRole("button", { name: "Remove as a delegate of this agent (delegate_to)" }).click();

  await expect.poll(() => deleted).toBe("ava"); // removal lands on the FOCUSED agent's registry
  await expect(ava.getByText("delegate")).toHaveCount(0);
  // ...and the add button is back, so the gesture is symmetric rather than one-way.
  await expect(ava.getByRole("button", { name: "Add as a delegate of this agent (delegate_to)" })).toBeVisible();
});

test("host without delegates: add → 404 → Enable delegates → retried add succeeds (#797)", async ({ page }) => {
  // The focused agent (host) doesn't serve /api/delegates until the plugin is enabled;
  // enabling goes through the dedicated /api/plugins/{id}/enabled endpoint and the reload
  // hot-mounts the routes, so the retry lands without a restart.
  let enabled = false;
  let delegatePosts = 0;
  let enablePosts = 0;
  await page.route("**/api/fleet", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const a of json.agents) if (!a.host) a.a2a = `http://127.0.0.1:${a.port}/a2a`;
    await route.fulfill({ json });
  });
  await page.route("**/api/delegates", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    delegatePosts += 1;
    if (!enabled) return route.fulfill({ status: 404, json: { detail: "Not Found" } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/plugins/*/enabled", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    enablePosts += 1;
    enabled = true;
    return route.fulfill({ json: { ok: true, enabled: true, reloaded: true, restart_recommended: false } });
  });

  await openAgents(page);
  await page
    .locator(".fleet-row", { hasText: "ava" })
    .getByRole("button", { name: "Add as a delegate of this agent (delegate_to)" })
    .click();

  const error = page.locator(".pl-alert--error");
  await expect(error).toContainText("can't hold delegates");
  await page.getByTestId("enable-delegates").click();

  await expect.poll(() => enablePosts).toBe(1); // delegates enabled via the dedicated endpoint
  await expect.poll(() => delegatePosts).toBe(2); // the 404'd attempt + the post-enable retry
  await expect(error).toHaveCount(0); // retry succeeded -> error cleared
});

test("rename edits the display name; the id/slug stays", async ({ page }) => {
  await openAgents(page);
  const row = page.locator(".fleet-row", { hasText: "ava" });
  await row.getByRole("button", { name: /Rename/ }).click();
  const input = page.getByLabel("New agent name");
  await input.fill("nova");
  await input.press("Enter");

  const renamed = page.locator(".fleet-row", { hasText: "nova" });
  await expect(renamed).toBeVisible();
  // The slug (stable id) is untouched: switching to the renamed agent still
  // navigates to its original id URL.
  await closeOverlay(page);
  await page.getByTestId("fleet-switcher").click();
  await page.getByRole("menuitem", { name: /nova/ }).click();
  await expect(page).toHaveURL(/\/app\/agent\/ava\//);
});

test("discover → add to fleet → switch into the remote member (ADR 0042 §I)", async ({ page }) => {
  await openAgents(page);
  await page.getByRole("button", { name: /Discover agents/ }).click();
  // Address the two lists by their OWN selectors: a discovery result is `--found`, a member
  // is not. They share the row shape, so a bare `.fleet-row` matched both the instant the
  // add landed and strict-mode-flaked under load.
  const found = page.locator(".fleet-row--found", { hasText: "remy" });
  await expect(found).toBeVisible();

  await found.getByRole("button", { name: "Add to this fleet (a switchable remote member)" }).click();

  // …and it leaves the found list: an agent that's already a member must not keep offering
  // "Add to this fleet", which would 400. (The re-scan satisfies this too — the point of the
  // contract is the end state, not which of the two paths got there first.)
  await expect(page.locator(".fleet-row--found", { hasText: "remy" })).toHaveCount(0);

  // Now a fleet member: remote tag + its URL, no start/stop controls.
  const member = page.locator(".fleet-row:not(.fleet-row--found)", { hasText: "http://192.168.5.50:7871" });
  await expect(member).toBeVisible();
  await expect(member.getByText("remote", { exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Stop" })).toHaveCount(0);

  // And switchable: the topbar switcher navigates to its slug window, where the hub
  // proxies the console (the mock strips /agents/<slug>/ — the app boots normally).
  await closeOverlay(page);
  await page.getByTestId("fleet-switcher").click();
  await page.getByRole("menuitem", { name: /remy/ }).click();
  await expect(page).toHaveURL(/\/app\/agent\/remy-re01\//);
  await expect(page.getByTestId("fleet-switcher")).toContainText("remy");

  // Unregister from the fleet manager (the remote agent itself is untouched). Fleet is a
  // host-console-only Box section now (2026-06 settings consolidation), so return to the host
  // console first — the member window we navigated into doesn't carry the Box group.
  await openAgents(page);
  await page.locator(".fleet-row", { hasText: "remy" })
    .getByRole("button", { name: /Remove from this fleet/ }).click();
  await expect(page.locator(".fleet-row", { hasText: "remy" })).toHaveCount(0);
});

// ── Folded-in fleet controls (#1733 quick-chat + #1769 toggle → the Fleet Room) ─────
// The per-member root commands and the `Toggle Fleet Agent ▸` submorph are gone: member
// names ride the Fleet Room command's keywords, and the roster row carries DM / open /
// start / stop. These tests pin the fold — the old flows keep working, one hop away.

test("⌘K root: member names surface the Fleet Room; the old per-member commands are gone", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.locator(".pl-cmdk__panel")).toBeVisible();
  const input = page.locator(".pl-cmdk__panel .pl-cmdk-commands__input");
  // The toggle submorph is folded away.
  await input.fill("Toggle Fleet Agent");
  await expect(page.getByRole("option", { name: "Toggle Fleet Agent" })).toHaveCount(0);
  // Typing a member's name routes to the room (roster keywords), not a per-member row.
  await input.fill("ava");
  await expect(page.getByRole("option", { name: "Fleet Room" })).toBeVisible();
  await expect(page.getByRole("option", { name: /^ava\b/ })).toHaveCount(0);
  await page.getByRole("option", { name: "Fleet Room" }).click();
  await expect(page.locator(".flr")).toBeVisible();
});

test("Fleet Room roster: stop a running member, start a stopped one (folded #1769)", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");

  // Stop ava (running in baseline) straight from her roster row; the dot flips on the
  // invalidated poll. The host (main) never gets a toggle — it serves this console.
  await expect(room.locator(".flr__member", { hasText: "main" }).getByRole("button", { name: /^(Stop|Start) main$/ })).toHaveCount(0);
  await room.locator(".flr__member", { hasText: "ava" }).getByRole("button", { name: "Stop ava" }).click();
  await expect(page.locator(".pl-toast", { hasText: "Stopping ava" })).toBeVisible();
  await expect(room.locator(".flr__member", { hasText: "ava" }).locator(".flr__dot--stopped")).toBeVisible();

  // Start roxy (stopped in baseline).
  await room.locator(".flr__member", { hasText: "roxy" }).getByRole("button", { name: "Start roxy" }).click();
  await expect(page.locator(".pl-toast", { hasText: "Starting roxy" })).toBeVisible();
  await expect(room.locator(".flr__member", { hasText: "roxy" }).locator(".flr__dot--online")).toBeVisible();
});

test("Fleet Room: a parked member turn shows 'needs approval', then hands back (#2132)", async ({ page }, testInfo) => {
  // setExtraHTTPHeaders REPLACES the set — re-carry the fleet scope alongside the HITL gate.
  await page.setExtraHTTPHeaders({
    "x-e2e-fleet": `fleet-spec-${testInfo.parallelIndex}`,
    "x-e2e-hitl": "ava",
  });
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");
  const ava = room.locator(".flr__member", { hasText: "ava" });

  // ava's stream emits turn.input_required → attention pill + the actionable feed row.
  await expect(ava.locator(".flr__pill--attn")).toBeVisible();
  await expect(room.locator(".flr-feed__event", { hasText: "needs your approval" }).first()).toBeVisible();

  // The answer lands (turn.resumed) — needs-approval hands back to a live "running" pill…
  await expect(ava.locator(".flr__pill--run")).toBeVisible();
  await expect(room.locator(".flr-feed__event", { hasText: "resumed — input received" }).first()).toBeVisible();

  // …and the terminal turn.usage clears it.
  await expect(ava.locator(".flr__pill--run")).toHaveCount(0, { timeout: 6000 });
  await expect(ava.locator(".flr__pill--attn")).toHaveCount(0);
});

async function openFleetRoom(page) {
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(page.locator(".pl-cmdk__panel")).toBeVisible();
  await page.locator(".pl-cmdk__panel .pl-cmdk-commands__input").fill("Fleet Room");
  await page.getByRole("option", { name: "Fleet Room" }).click();
  await expect(page.locator(".pl-cmdk__title")).toHaveText("Fleet"); // morphed into the room
}

test("⌘K → Fleet Room: presence, DM a member (the wired chat), broadcast", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");

  // Roster with presence: the host is tagged "this instance"; a running member and a
  // stopped one both appear, encoded in the dot class (success vs the stopped default).
  await expect(room.locator(".flr__member", { hasText: "main" }).locator(".flr__tag--host")).toBeVisible();
  await expect(room.locator(".flr__member", { hasText: "ava" }).locator(".flr__dot--online")).toBeVisible();
  await expect(room.locator(".flr__member", { hasText: "roxy" }).locator(".flr__dot--stopped")).toBeVisible();

  // DM a running member — clicking it morphs into the wired chat, pointed at that member
  // (placeholder names them). Back returns to the roster.
  await room.locator(".flr__member", { hasText: "ava" }).locator(".flr__who").click();
  await expect(page.getByPlaceholder(/Message ava/i)).toBeVisible();
  // The DM header names the member (DmTitle store) — not the old generic "Direct message".
  await expect(page.locator(".pl-cmdk__title")).toHaveText("@ava");
  await page.locator(".pl-cmdk__back").click();
  await expect(room.locator(".flr__composer")).toBeVisible();

  // The bottom bar broadcasts to everyone online → a success toast.
  await room.locator(".flr__input").fill("standup in 5");
  await room.locator(".flr__send").click();
  await expect(page.locator(".pl-toast", { hasText: /Broadcast to \d+ member/ })).toBeVisible();
});

test("⌘K → Fleet Room uses the canonical backend without broadcasting", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "native-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.keyboard.press("ControlOrMeta+Shift+k");
  const palette = page.locator(".pl-cmdk__panel");
  await palette.locator(".pl-cmdk-commands__input").fill("Fleet Room");
  const command = palette.getByRole("option", { name: "Fleet Room" });
  await expect(command).not.toContainText(/broadcast/);
  await command.click();
  await expect(page.locator(".pl-cmdk__title")).toHaveText("Fleet");
  const room = page.locator(".flr");

  await expect(room.getByRole("heading", { name: "Agent Organization" })).toBeVisible();
  const paletteRoomBounds = await room.boundingBox();
  expect(paletteRoomBounds).not.toBeNull();
  await expect(room).not.toHaveClass(/flr--full-height/);
  expect(paletteRoomBounds!.height).toBeLessThanOrEqual(480);
  await expect(room).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByText(/DM a member/)).toHaveCount(0);
  await expect(page.getByText(/address in composer/)).toHaveCount(0);
  await expect(page.getByText(/broadcast/)).toHaveCount(0);
  await expect(room.getByText("Welcome to the shared room", { exact: true })).toBeVisible();
  await expect(room.getByRole("list", { name: "Room members" }).getByText("Dennis", { exact: true })).toBeVisible();
  await expect(room.getByRole("list", { name: "Room members" }).getByText("PC1", { exact: true })).toBeVisible();

  await room.getByRole("textbox", { name: "Room message" }).fill("Status update");
  await room.getByRole("button", { name: "Post message" }).click();

  await expect(room.getByText("Status update", { exact: true })).toBeVisible();
  await expect(page.locator(".pl-toast", { hasText: /Broadcast to/ })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Message (ava|roxy)/i)).toHaveCount(0);
});

test("Rooms rail icon opens the canonical Room without the command palette", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "native-room" });
  await page.goto("/app/", { waitUntil: "load" });

  const rooms = page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true });
  await expect(rooms).toBeVisible();
  await rooms.click();

  await expect(page.locator(".pl-cmdk-overlay")).toHaveCount(0);
  const room = page.locator(".flr");
  await expect(room.getByRole("heading", { name: "Agent Organization" })).toBeVisible();
  await expect(room.getByText("Welcome to the shared room", { exact: true })).toBeVisible();

  const columns = await room.locator(".flr__cols").boundingBox();
  const roster = await room.locator(".flr__roster").boundingBox();
  const conversation = await room.locator(".flr-room").boundingBox();
  expect(columns).not.toBeNull();
  expect(roster).not.toBeNull();
  expect(conversation).not.toBeNull();
  expect(roster!.width / columns!.width).toBeLessThanOrEqual(0.251);
  expect(conversation!.width / columns!.width).toBeGreaterThanOrEqual(0.749);

  const roomBounds = await room.boundingBox();
  const panelBounds = await page.locator(".pl-appshell__col--left").boundingBox();
  expect(roomBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(roomBounds!.height / panelBounds!.height).toBeGreaterThanOrEqual(0.95);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect(room.locator(".flr__roster .flr__count")).toBeHidden();
  await expect(room.getByRole("list", { name: "Room members" }).getByText("Dennis", { exact: true })).toBeVisible();
});

test("Rooms rail surface fails closed when no Room backend is installed", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });

  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();

  const unavailable = page.getByRole("alert");
  await expect(unavailable).toContainText("Rooms unavailable");
  await expect(unavailable).toContainText("Install and enable an Agent Room backend");
  await expect(page.locator(".flr__composer")).toHaveCount(0);
});

test("PC1 client Room shows canonical history and durable offline pending posts without owner controls", async ({ page }) => {
  await page.route("**/api/plugins/agent-room/rooms?status=all", (route) => route.fulfill({ json: {
    contract_version: "1",
    rooms: [{ id: "ao", name: "Agent Organization", created_at: "", latest_sequence: 15, status: "active", client_mode: true, owner_online: false }],
  } }));
  await page.route("**/api/plugins/agent-room/rooms/ao/messages?*", (route) => route.fulfill({ json: {
    contract_version: "1", operation: "room.sync", result: {
      messages: [{ id: "canonical-15", room_id: "ao", sequence: 15, client_message_id: "s1-15", author_principal: "pc1", author_kind: "human", body: "Canonical from S1", thread_id: "canonical-15", reply_to_message_id: null, created_at: "2026-08-22T00:00:00Z" }],
      mentions: [], next_sequence: 15, has_more: false, has_older: false, oldest_sequence: 15, active_from_sequence: 1, history_available: false,
      owner_online: false,
      pending_posts: [{ room_id: "ao", client_message_id: "pending-1", body: "Queued while S1 is offline", created_at: "2026-08-22T00:01:00Z", status: "pending" }],
    },
  } }));
  await page.route("**/api/plugins/agent-room/rooms/ao/members", (route) => route.fulfill({ json: { contract_version: "1", operation: "room.members", result: { members: [{ principal: "pc1", kind: "host", display_name: "PC1", role: "member", mention_token: "@PC1", host: "pc1", can_post: true, can_mention: false, mentionable: false }] } } }));
  await page.route("**/api/plugins/agent-room/rooms/ao/ack", (route) => route.fulfill({ json: { contract_version: "1", operation: "room.ack", result: { room_id: "ao", principal: "pc1", last_sequence: 15 } } }));
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();

  const room = page.locator(".flr--agent-room");
  await expect(room.getByText("Canonical from S1", { exact: true })).toBeVisible();
  await expect(room.getByText("Queued while S1 is offline", { exact: true })).toBeVisible();
  await expect(room.getByRole("status", { name: "Room owner status" })).toContainText("S1 Room owner offline");
  await expect(room.getByText("Pending — will send when S1 reconnects", { exact: true })).toBeVisible();
  await expect(room.getByRole("button", { name: "Room actions" })).toHaveCount(0);
  await expect(room.getByRole("button", { name: "Search rooms" })).toHaveCount(0);
});

test("⌘K → an installed backend with no canonical room pauses messaging", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "empty-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);

  await expect(page.getByRole("alert")).toContainText("Room backend unavailable");
  await expect(page.locator(".flr__composer")).toHaveCount(0);
  await expect(page.getByText(/Shared room unavailable · messaging paused/)).toBeVisible();
});

test("⌘K → canonical Room loads recent messages first and older history on demand", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "paged-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);

  const room = page.locator(".flr");
  await expect(room.getByText("page message 105", { exact: true })).toBeVisible();
  await expect(room.locator(".flr-room__message")).toHaveCount(50);
  const anchor = room.getByText("page message 56", { exact: true });
  await page.waitForTimeout(300);
  const beforeAnchor = await anchor.boundingBox();
  await room.getByRole("button", { name: "Load older messages" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(room.locator(".flr-room__message")).toHaveCount(100);
  await page.waitForTimeout(300);
  const afterAnchor = await anchor.boundingBox();
  expect(beforeAnchor).not.toBeNull();
  expect(afterAnchor).not.toBeNull();
  expect(Math.abs(afterAnchor!.y - beforeAnchor!.y)).toBeLessThanOrEqual(2);
  await room.getByRole("button", { name: "Load older messages" }).click();
  await expect(room.locator(".flr-room__message")).toHaveCount(105);
  await expect(room.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
});

test("⌘K → canonical Room shows mention delivery and blocked cycle state", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "mention-status-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");

  const messages = room.locator(".flr-room__message");
  const humanSource = messages.filter({ hasText: "@Hermes start" });
  const hermesReply = messages.filter({ hasText: "handoff @Headroom" });
  const headroomReply = messages.filter({ hasText: "done @Hermes" });

  await expect(humanSource.getByText("Hermes · completed", { exact: true })).toBeVisible();
  await expect(hermesReply.getByText("Headroom · completed", { exact: true })).toBeVisible();
  await expect(headroomReply.getByText("Hermes · blocked · mention cycle blocked", { exact: true })).toBeVisible();
});

test("Rooms profile expands and its wake action inserts an exact mention without posting", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "mention-status-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");
  const composer = room.getByRole("textbox", { name: "Room message" });

  await expect(room.getByText("Post to room only — no agents notified", { exact: true })).toBeVisible();
  await expect(room.getByRole("heading", { name: "Wakeable agents" })).toBeVisible();
  await expect(room.getByRole("heading", { name: "Other members" })).toBeVisible();
  const hermesProfile = room.locator(".flr-room__member-profile").filter({ hasText: "Hermes" });
  await hermesProfile.locator("summary").click();
  await expect(hermesProfile.getByText("Routes work and coordinates the Room.", { exact: true })).toBeVisible();
  await expect(hermesProfile.getByText("Owner routing", { exact: true })).toBeVisible();
  await expect(hermesProfile.getByText("Profile data grants no additional authority", { exact: true })).toBeVisible();
  await expect(hermesProfile.getByText("Ask the operator for a decision.", { exact: true })).toBeVisible();
  await expect(hermesProfile.getByText("Configured to wake as @Hermes", { exact: true })).toBeVisible();
  await hermesProfile.getByRole("button", { name: "Wake @Hermes" }).click();

  await expect(composer).toHaveValue("@Hermes ");
  await expect(composer).toBeFocused();
  await expect(room.getByText("Will notify Hermes", { exact: true })).toBeVisible();
  await expect(room.locator(".flr__roster .flr__dot")).toHaveCount(0);
  const pla = room.getByRole("listitem").filter({ hasText: "protoLabs Agent" });
  await expect(pla.getByText("@PLA", { exact: true })).toBeVisible();
  await expect(pla.getByText("Configured to wake as @PLA", { exact: true })).toBeVisible();
  const dennis = room.getByRole("listitem").filter({ hasText: "Dennis" });
  await expect(dennis.locator(".flr-room__member-state")).toHaveText("Not configured for wake-up");

  await composer.fill("@all suggestions?");
  await expect(room.getByText("Will notify Hermes, Headroom, protoLabs Agent", { exact: true })).toBeVisible();

  await composer.fill("Unknown @all.foo");
  await expect(room.getByRole("alert")).toContainText("Unknown agent @all.foo");
  await expect(room.getByText(/Will notify/)).toHaveCount(0);
});

test("Rooms composer offers accessible multi-mention suggestions and blocks unknown names", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "mention-status-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");
  const composer = room.getByRole("textbox", { name: "Room message" });

  await composer.fill("@");
  const suggestions = room.getByRole("listbox", { name: "Mention an agent" });
  await expect(suggestions.getByRole("option", { name: "All wakeable agents" })).toBeVisible();
  await expect(suggestions.getByRole("option", { name: "Hermes" })).toBeVisible();
  await expect(suggestions.getByRole("option", { name: "Headroom" })).toBeVisible();

  await composer.press("ArrowUp");
  await composer.fill("@hea");
  await expect(room.getByRole("heading", { name: "Agent Organization" })).toBeVisible();
  await expect(suggestions.getByRole("option", { name: "Headroom" })).toBeVisible();
  await composer.fill("@");

  await composer.press("ArrowDown");
  await composer.press("Enter");
  await expect(composer).toHaveValue("@Hermes ");

  await composer.fill("@Hermes @Hea");
  await expect(suggestions.getByRole("option", { name: "Headroom" })).toBeVisible();
  await expect(suggestions.getByRole("option", { name: "Hermes" })).toHaveCount(0);
  await composer.press("Tab");
  await expect(composer).toHaveValue("@Hermes @Headroom ");
  await expect(room.getByText("Will notify Hermes, Headroom", { exact: true })).toBeVisible();

  await composer.fill("@Headroom @Hermes reverse order");
  await expect(room.getByText("Will notify Headroom, Hermes", { exact: true })).toBeVisible();

  await composer.fill("@Unknown status?");
  await expect(room.getByRole("alert")).toContainText("Unknown agent @Unknown");
  await expect(room.getByRole("button", { name: "Post message" })).toBeDisabled();
  const messageCount = await room.locator(".flr-room__message").count();
  const postRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/plugins/agent-room/rooms/ao/post")) {
      postRequests.push(request.url());
    }
  });
  await composer.press("Enter");
  await page.waitForTimeout(100);
  expect(postRequests).toHaveLength(0);
  await expect(composer).toHaveValue("@Unknown status?");
  await expect(room.locator(".flr-room__message")).toHaveCount(messageCount);
});

test("Rooms creates, switches, and renames subject rooms", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "multi-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");

  await room.getByRole("button", { name: "Switch room, current: Agent Organization" }).click();
  const switcher = room.getByRole("dialog", { name: "Room switcher" });
  await switcher.getByRole("button", { name: "New room" }).click();
  await room.getByRole("dialog", { name: "Create room" }).getByLabel("Room name").fill("Release planning");
  await room.getByRole("dialog", { name: "Create room" }).getByRole("button", { name: "Create" }).click();
  await expect(room.getByRole("button", { name: "Switch room, current: Release planning" })).toBeVisible();

  await room.getByRole("button", { name: "Room actions" }).click();
  await room.getByRole("menu").getByRole("menuitem", { name: "Rename room" }).click();
  await room.getByRole("dialog", { name: "Rename room" }).getByLabel("Room name").fill("Launch planning");
  await room.getByRole("dialog", { name: "Rename room" }).getByRole("button", { name: "Save" }).click();
  await expect(room.getByRole("button", { name: "Switch room, current: Launch planning" })).toBeVisible();
  await page.reload({ waitUntil: "load" });
  await expect(room.getByRole("button", { name: "Switch room, current: Launch planning" })).toBeVisible();

  await room.getByRole("button", { name: "Switch room, current: Launch planning" }).click();
  await switcher.getByRole("button", { name: /Agent Organization/ }).click();
  await expect(room.getByRole("button", { name: "Switch room, current: Agent Organization" })).toBeVisible();
});

test("Rooms lifecycle overlays close with Escape and restore opener focus", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "multi-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");
  const switcherButton = room.getByRole("button", { name: /Switch room, current:/ });

  await switcherButton.click();
  await page.keyboard.press("Escape");
  await expect(room.getByRole("dialog", { name: "Room switcher" })).toHaveCount(0);
  await expect(switcherButton).toBeFocused();

  const searchButton = room.getByRole("button", { name: "Search rooms" });
  await searchButton.click();
  const searchDialog = room.getByRole("dialog", { name: "Search rooms" });
  await searchDialog.getByLabel("Search messages").fill("legacy");
  await page.keyboard.press("Shift+Tab");
  await expect(searchDialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(searchDialog.getByRole("button", { name: "Search", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(room.getByRole("dialog", { name: "Search rooms" })).toHaveCount(0);
  await expect(searchButton).toBeFocused();

  await switcherButton.click();
  await room.getByRole("dialog", { name: "Room switcher" }).getByRole("button", { name: "New room" }).click();
  await page.keyboard.press("Escape");
  await expect(room.getByRole("dialog", { name: "Create room" })).toHaveCount(0);
  await expect(switcherButton).toBeFocused();
});

test("Rooms all-status cache never feeds an archived room into legacy Fleet", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "multi-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");
  await room.getByRole("button", { name: /Switch room, current:/ }).click();
  await room.getByRole("dialog", { name: "Room switcher" }).getByRole("button", { name: "New room" }).click();
  await room.getByRole("dialog", { name: "Create room" }).getByLabel("Room name").fill("Active target");
  await room.getByRole("dialog", { name: "Create room" }).getByRole("button", { name: "Create" }).click();
  await room.getByRole("button", { name: /Switch room, current:/ }).click();
  await room.getByRole("dialog", { name: "Room switcher" }).getByRole("button", { name: /Agent Organization/ }).click();
  await room.getByRole("button", { name: "Room actions" }).click();
  await room.getByRole("menuitem", { name: "Archive room" }).click();
  await room.getByRole("dialog", { name: "Archive room" }).getByRole("button", { name: "Archive" }).click();

  await openFleetRoom(page);
  const fleet = page.getByLabel("Fleet");
  await expect(fleet.getByText("Archived room — restore to post", { exact: true })).toHaveCount(0);
  await expect(fleet.getByText("Post to room only — no agents notified", { exact: true })).toBeVisible();
  await page.request.post("/api/plugins/agent-room/rooms/ao/restore", {
    headers: { "x-e2e-agent-room": "multi-room" },
  });
});

test("Rooms starts fresh non-destructively and archives or restores a room", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "multi-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");

  await expect(room.getByText("legacy topic history", { exact: true })).toBeVisible();
  await room.getByRole("button", { name: "Room actions" }).click();
  await room.getByRole("menu").getByRole("menuitem", { name: "Start fresh" }).click();
  const fresh = room.getByRole("dialog", { name: "Start fresh" });
  await expect(fresh).toContainText("Earlier history remains searchable");
  await fresh.getByRole("button", { name: "Start fresh" }).click();
  await expect(room.getByText("legacy topic history", { exact: true })).toHaveCount(0);
  await room.getByRole("button", { name: "Show earlier history" }).click();
  await expect(room.getByText("legacy topic history", { exact: true })).toBeVisible();

  await room.getByRole("button", { name: "Room actions" }).click();
  await room.getByRole("menu").getByRole("menuitem", { name: "Archive room" }).click();
  await room.getByRole("dialog", { name: "Archive room" }).getByRole("button", { name: "Archive" }).click();
  await expect(room.getByText("Archived room — restore to post", { exact: true })).toBeVisible();
  await expect(room.getByRole("textbox", { name: "Room message" })).toHaveCount(0);
  const archivedHermes = room.getByRole("listitem").filter({ hasText: "Hermes" });
  await expect(archivedHermes.locator(".flr-room__member-state")).toHaveText("Room archived — wake-up unavailable");
  await expect(room.getByRole("button", { name: "Wake @Hermes" })).toHaveCount(0);

  await room.getByRole("button", { name: /Switch room, current:/ }).click();
  await room.getByRole("dialog", { name: "Room switcher" }).getByRole("button", { name: "Archived" }).click();
  await room.getByRole("button", { name: "Restore Agent Organization" }).click();
  await expect(room.getByText("Post to room only — no agents notified", { exact: true })).toBeVisible();
});

test("Rooms search active, earlier, and archived history then opens bounded context", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-e2e-agent-room": "multi-room" });
  await page.goto("/app/", { waitUntil: "load" });
  await page.locator(".pl-rail").getByRole("button", { name: "Rooms", exact: true }).click();
  const room = page.locator(".flr");

  await room.getByRole("button", { name: "Search rooms" }).click();
  const search = room.getByRole("dialog", { name: "Search rooms" });
  await search.getByLabel("Search messages").fill("legacy");
  await search.getByLabel("Search scope").selectOption("all");
  await search.getByLabel("Include earlier history").check();
  await search.getByRole("button", { name: "Search" }).click();
  const result = search.getByRole("button", { name: /Agent Organization.*legacy topic history/i });
  await expect(result).toBeVisible();
  await result.click();
  await expect(room.getByText("Search result context", { exact: true })).toBeVisible();
  const matchedMessage = room.locator(".flr-room__message", { hasText: "legacy topic history" });
  await expect(matchedMessage).toBeVisible();
  await expect(matchedMessage).toBeFocused();
  await room.getByRole("button", { name: "Return to latest" }).click();
});

test("⌘K → Fleet Room shows the roster + live activity feed side by side", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");
  // Two columns inside the dialog: roster on the left, the activity feed on the right.
  await expect(room.locator(".flr__roster")).toBeVisible();
  await expect(room.locator(".flr__activity")).toBeVisible();
  await expect(room.getByText("Fleet activity", { exact: true })).toBeVisible();
  // The feed streams each online member's event bus (/agents/<slug>/api/events) — the mock
  // pushes activity/inbox/goal frames, so a mapped event lands in the column.
  await expect(room.locator(".flr-feed__event").first()).toBeVisible({ timeout: 6000 });
});

test("⌘K → Fleet Room: @-address a member in the composer, then send opens its DM", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");
  // Typing "@" opens a member picker; picking sets the address chip.
  await room.locator(".flr__input").fill("@ava");
  await room.locator(".flr__mention", { hasText: "ava" }).click();
  await expect(room.locator(".flr__target")).toContainText("@ava");
  // Type a message and send → morphs into ava's DM (the wired chat), message pre-sent.
  await room.locator(".flr__input").fill("ship it");
  await room.locator(".flr__send").click();
  await expect(page.getByPlaceholder(/Message ava/i)).toBeVisible();
});

test("⌘K → Fleet Room: a TYPED @name addresses that member without using the picker", async ({ page }) => {
  await page.goto("/app/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");
  // Never touch the picker — just type "@ava <message>" and send, the way people actually
  // type. It must address ava (open its DM), NOT broadcast the literal text.
  await room.locator(".flr__input").fill("@ava ship it");
  await room.locator(".flr__send").click();
  await expect(page.getByPlaceholder(/Message ava/i)).toBeVisible();
  await expect(page.locator(".pl-toast", { hasText: /Broadcast to/ })).toHaveCount(0);
});

// ── Sister agents get the fleet surfaces too (#1708/#1999 revisited) ───────────────────
// The three affordances used to be host-console-only, on the theory that a member window
// would be managing a fleet-of-one and could only nest. That's false for a slug window:
// /api/fleet + /api/archetypes are HUB paths (lib/api.ts `isHubPath`), so a sister agent's
// console drives the SAME fleet the host does. These pin that it stays reachable there —
// and that the window can't act on the agent serving it.

// Assert by ACTING, not by reading an aria-disabled attribute: a disabled DS MenuItem is
// pointer-events:none, so a click that lands is proof the item is live — and it also proves
// the deep-link RESOLVES, which is the half that was actually broken (the Box group was
// dropped wholesale off the host, so "Fleet settings" fell back to some other section).
test("a sister agent's window: Fleet settings opens the fleet panel from the switcher", async ({ page }) => {
  await page.goto("/app/agent/ava/", { waitUntil: "load" });
  await page.getByTestId("fleet-switcher").click();
  await page.getByRole("menuitem", { name: "Fleet settings" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
});

test("a sister agent's window: New agent opens the archetype picker from the switcher", async ({ page }) => {
  await page.goto("/app/agent/ava/", { waitUntil: "load" });
  await page.getByTestId("fleet-switcher").click();
  await page.getByRole("menuitem", { name: "New agent" }).click();
  await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
});

test("a sister agent's window: the ⌘K Fleet Room opens on the hub's roster", async ({ page }) => {
  await page.goto("/app/agent/ava/", { waitUntil: "load" });
  await openFleetRoom(page);
  const room = page.locator(".flr");
  // The hub's real roster — its siblings are here, not an empty fleet-of-one.
  await expect(room.locator(".flr__member", { hasText: "main" })).toBeVisible();
  await expect(room.locator(".flr__member", { hasText: "roxy" })).toBeVisible();
  // But no Stop on its OWN row: that button would kill the agent serving this window.
  await expect(
    room.locator(".flr__member", { hasText: "ava" }).getByRole("button", { name: /^(Stop|Start) ava$/ }),
  ).toHaveCount(0);
  // A sibling still toggles normally.
  await expect(room.locator(".flr__member", { hasText: "roxy" }).getByRole("button", { name: "Start roxy" })).toBeVisible();
});

test("a sister agent's window: the fleet panel won't stop or remove the agent serving it", async ({ page }) => {
  await page.goto("/app/agent/ava/", { waitUntil: "load" });
  await page.getByTestId("header-menu").click();
  await page.getByTestId("app-drawer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-overlay .pl-sidenav").getByRole("tab", { name: "Fleet", exact: true }).click();
  const self = page.locator(".fleet-row", { hasText: "ava" });
  await expect(self).toBeVisible();
  await expect(self.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(self.getByRole("button", { name: "Remove" })).toHaveCount(0);
  // A sibling keeps its controls — the guard is about SELF, not about being a member window.
  await expect(page.locator(".fleet-row", { hasText: "roxy" }).getByRole("button", { name: "Start" })).toBeVisible();
});
