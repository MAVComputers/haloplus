# Changelog

## 1.3.2

### Critical fix
- **Side panel was broken on the v1.3.0 Chrome Web Store build.** The released zip did not include the `templates/` folder, so `panel.js` 404'd on `templates/templates.json` during `init()`. The error threw before any `setupXxx()` event-wiring ran, so the panel rendered with the right HTML but no click handlers attached — every tab, button, and toggle appeared dead. v1.3.0 and v1.3.1 zips both had this defect; this release bundles `templates/` correctly.
- **`init()` is now resilient to missing bundle resources.** New `safeLoadJSON(path, fallback)` helper in [panel.js](sidepanel/panel.js) wraps every static JSON load with try/catch — a single missing/broken file can no longer abort the setup chain. Same for the chrome.storage loaders. Defends against any future packing-list mistake.

### Quality-of-life
- **"Read the full manual" button** added to **Settings → Help & About → Getting started**. Opens [gethaloplus.com/manual.html](https://www.gethaloplus.com/manual.html) in a new browser tab. Previously the manual was only reachable from the website footer / release notes.

### Notes
- v1.3.1 (Multi-Tab compatibility + right-click context menu) was tagged on GitHub but never shipped to the Chrome Web Store; users updating from v1.2.1 or v1.3.0 see the v1.3.1 changes for the first time as part of this release.

## 1.3.1

### Halo Multi-Tab mode compatibility
- **Palette navigation no longer wipes your tab strip.** Fixes [#3](https://github.com/alexwennekes212/haloplus/issues/3). Every HaloPlus navigation used to do a hard `window.location.assign`, which reloads the whole React app and collapses Halo's Multi-Tab tab strip to a single tab. The palette and side-panel record clicks now route through a new main-world bridge that calls Halo's React Router `history.push()` directly — the SPA stays alive and other open tabs survive.
- **Optional "Open palette navigation in a new Halo tab" preference.** New toggle under **Settings → Preferences → In-page tools**. When on AND Halo's Multi-Tab mode is enabled (detected via the `haloTabState` localStorage key), palette navigations dispatch Halo's own `ADD_NEW_TAB` Redux action instead of replacing the active tab. URL is normalised to Halo's singular detail format (`/ticket?id=N&showmenu=true`) so the new tab renders the detail view, not the list view. Falls back to history.push when Multi-Tab is off — no surprise behaviour.
- **Ticket 360 button now injects into every open ticket tab.** The toolbar button used a `getElementById` + `querySelector` pair that returned only the first match, so in Multi-Tab mode only one open ticket got the button. Now uses `querySelectorAll` and a per-container duplicate-check, so every visible ticket-toolbar gets it.
- **In-360 client / site / user / KB anchors no longer trigger a full reload.** The four `<a href>` tags inside Ticket 360 were plain HTML anchors that the browser interpreted as full navigations. Tagged them with `hu-spa-link` and added a delegated click interceptor that routes them through the same SPA-friendly path; modifier-key clicks (ctrl/middle/shift) keep native open-in-new-tab semantics.

### Right-click context menu
- **Four new entries on Halo pages:** Open Ticket 360, View audit log for this ticket, Open JSON inspector, Toggle field API names overlay. Each item only appears on Halo domains (`*.halopsa.com`, `*.haloitsm.com`, `*.haloservicedesk.com`).
- **Ticket-only items hide on non-ticket pages.** The 360 and audit items disappear when the active tab isn't a ticket page; JSON inspector and field-name overlay stay visible everywhere on Halo. Service worker listens to `tabs.onUpdated` and `tabs.onActivated` and toggles `chrome.contextMenus.update({ visible })` for each.

### Architecture
- **`content/main-world-bridge.js`** — new content script registered with `world: "MAIN"` in the manifest. Runs in the page's main world so it can read React's `_reactRootContainer` expando and Halo's Redux store — both invisible from the isolated content-script world. Exposes two cross-world bridges via CustomEvent:
  - `haloplus:navigate` → walks the React fiber tree to find React Router's `history`, calls `history.push()`. Falls back to a bare `history.pushState` + popstate dispatch if React Router isn't reachable.
  - `haloplus:open-new-tab` → finds Halo's Redux store and dispatches `ADD_NEW_TAB` with `{ pathname, search }` after running the URL through a plural→singular normaliser. Falls back to history.push if the store isn't reachable.

### Fixes
- **Cross-world CustomEvent fallback bug.** Chrome structured-clones the `detail` object when a CustomEvent crosses worlds, so a `detail.handled = true` write from the bridge never propagated back to the dispatcher. The isolated-world `navigateTo()` was reading the original (unmutated) detail and ALWAYS falling through to `window.location.assign(href)` — every same-origin nav was secretly doing a hard reload after the bridge had already navigated. The dispatcher now trusts the bridge for same-origin URLs and only falls back to a hard nav for cross-origin URLs or URL-parse failures.
- **Knock-on 429 rate limits.** With the hard-reload bug fixed, Halo no longer re-fires its full SPA bootstrap (`/api/Tickets`, `/api/Notifications`, lookups, etc.) on every palette navigation, so the per-IP rate limit isn't being hammered during normal use.

## 1.3.0

### Tenant environment labels
- **Auto-detected environment chip injected into the Halo page.** `detectEnvironment(hostname)` classifies any Halo URL as `live`, `sandbox`, `dev`, `staging`, `uat`, or `unknown` based on subdomain patterns (`*sandbox*`, `*dev*`, `*staging*`, etc.). The chip is colour-coded per environment (red for live, amber for sandbox, blue for dev) and labels the current tenant so you instantly see whether you're about to change PROD data.
- **Draggable chip, snaps to corners.** The chip is positioned in any of the four screen corners (top-left, top-right, bottom-left, bottom-right). Drag to reposition; on release it snaps to the nearest corner and persists the choice in `chrome.storage.local` under `huEnvChipCorner`. Defaults to bottom-right so it doesn't overlap Halo's top-bar buttons. Side panel also renders a matching `#envPill` so the environment is visible even when Halo is in the background.

### Custom Halo domains, rebuilt
- **Per-tenant `{ host, env, label }` records.** Replaces the flat hostname list with structured entries persisted under `huCustomDomainsMeta`. Each tenant carries an explicit environment classification (used for the env chip override) and an optional custom label (e.g. "ACME LIVE", "Pink Sandbox") that surfaces in the chip and palette.
- **Manual add only.** The add-tenant dialog used to auto-open when the panel rendered with no custom domains; it now only appears when the user clicks **+ Add tenant**. The hostname input pre-fills from the page the user is currently on, so adding the current tenant is one click + Enter. Env defaults from auto-detection.
- **Editable inline.** Each tenant row shows host, env dropdown, and label input directly in the list. Edits save on blur with a "Saved" status line, no separate edit mode.

### Ticket 360
- **Popup notes surfaced in the 360 drawer.** Reads `/api/PopupNote` and renders matching notes as a banner above the ticket summary. Honours the per-note settings: `displaymodal` shows a blocking modal variant, `dismissable` adds an X to close, `displayhtml` renders the body as HTML (sanitised), and `limitdaterange` hides the note outside its `daterangefrom` / `daterangeto` window. Useful for tenants that use popup notes for VIP / contract warnings.
- **"Viewed by" chip.** Pulls `includeseenby=true` from `/api/tickets/{id}` and shows the agents who have looked at the ticket in the last hour as a small chip in the 360 header. Click for the full `/api/FaultViewLog` trail — when each agent last opened the ticket, sorted newest first.
- **Audit log drawer.** New "View audit log" link in the 360 footer opens a side drawer with the ticket's full change history. Events are grouped by transaction (same agent + datetime + table) so a single save shows as one block instead of N rows. Each change shows a human-readable field label (`AUDIT_FIELD_LABELS` maps slot names like `cfaffectedservice` → "Affected service") and a resolved value when the raw audit row carries an ID — agent IDs, status IDs, priority IDs, team IDs, workflow IDs, ticket types, impact, and urgency are all resolved client-side via the existing `cache_*` lookups, with on-demand `/api/Workflow` / `/api/Priority` / `/api/Impact` / `/api/Urgency` fetches for fields without a localStorage cache. Free-text "structured" audit values (`Outcome: X\nNotes: Y`) are parsed into key/value pairs with a 2-pair minimum so prose body isn't false-positive matched. Filter input narrows by field name with a live count; chip row at the top shows the most-changed fields for quick scanning.
- **Appointment chip.** Includes `includelastappointment=true&includenextappointment=true` on the 360 ticket fetch and renders `Next appointment: DD/MM/YYYY HH.MM` (24h, Dutch format) in the badge strip when set, falling back to last appointment. Tooltip shows the appointment subject.

### Data Viewer
- **Saved queries per table.** New star-button menu in the Data Viewer trigger row. Save the current SQL + filters under a name, recall later from the dropdown, delete from the same menu. Queries are scoped per table and persisted in `chrome.storage.local` under `huSavedQueries`. Counter chip on the star shows how many saved queries exist for the current table.
- **Column profiles from `/api/ViewColumns`.** New column picker offers HaloPlus-curated profiles (`Recommended (top 12)`, `All columns`) plus the tenant's own saved views per entity (Tickets, Customers, Sites, Users, Assets). Per-view profiles fetch the column list lazily via `/api/ViewColumns/{id}?includedetails=true` (the list endpoint doesn't include columns even with `includedetails=true` — a quirk worked around per-view).
- **Custom-field-aware SQL generation.** When a view profile references a column that maps to a custom-field-backed name (`CFAffectedService`, `CFLastTicket`), the generated SELECT uses the SQL form when known, falls back to a virtual placeholder when unknown. `sqlQueryableColumns()` filters out API-only columns (from `mergeApiFieldKeys`) so they're never added to the generated SQL — they used to leak in and break the query.
- **Schema perspective toggle.** New Both / SQL / API switch above the schema list. SQL hides API-only fields (good for report writing); API hides SQL-only columns (good for integration work); Both keeps everything visible (default).

### Schema explorer
- **List-grid labels from saved views.** Calls `/api/ViewColumns?type=N&showall=true` per entity (ticket, customer, site, user, asset, supplier) and stitches the resulting `column_name → column_title_override` pairs into the explorer. Columns the user already knew about pick up a small italic chip showing the tenant's friendly title (e.g. SQL `Symptom` → "Summary"). Columns we didn't know about — but that appear in any saved view — are added as new API-only rows so the explorer surface grows automatically with the tenant's config. Cached in `chrome.storage.local` under `huViewColumnLabels` with a non-empty safety net so transient auth failures don't wipe the cache. The filter input now matches against `viewLabel` too, so typing the tenant's friendly column header lands on the right row.
- **Clickable foreign-key chips.** `FK -> table.column` chips in the schema explorer are now interactive when the referenced table is present. Hover shows a dotted underline, click jumps to the target table, expands it, scrolls it into view, and flashes the destination column in yellow for 1.4s. Chips pointing to tables not present in our schema (e.g. legacy `xtype`, `faqlisthead`) stay as plain badges so there's no broken-link affordance.

### API reference (/api)
- **Rebuilt on a 244-endpoint catalog generated from Halo's swagger.** The hand-curated 40-endpoint list is replaced by `content/api-catalog.json`, a filtered extract of Halo's OpenAPI spec covering tickets, actions, people, knowledge, assets, communication, finance, catalogue, projects, CRM, reports & views, and setup. Each entry carries its path, HTTP methods, summary, raw swagger tag, friendly category, and the full list of path + query parameters.
- **Search, filter, and per-endpoint details.** New sticky toolbar above the catalog: a search box that matches paths, summaries, swagger tags, category names, and parameter names (so typing `client_id` lands on every endpoint that accepts it); multi-select method chips (GET / POST / PUT / DELETE / PATCH) with persistent visual state; and a live "X of Y" count. Each endpoint row is collapsible — click to expand and see the path parameters and query parameters as monospace chips. The Copy button still copies just the path so it's paste-ready.

### Diagnostics
- **Extended endpoint probes.** A new "Run extended probes" button next to "Run diagnostics" tests 10 candidate endpoints (`/api/Agent/me`, `/api/Search`, `/api/ViewColumns`, `/api/tickets?includecolumns=true`, `/api/PopupNote`, `/api/FaultViewLog`, `/api/Notifications`, `/api/Feed`, `/api/HaloField`, `/api/Field`) and reports each one's HTTP status, latency in ms, and a top-level response shape hint (array length or top keys). Lets you see at a glance what features your tenant + role can support. Results are included in the "Copy diagnostics" output.
- **Friendlier impersonation banner.** The diagnostics card no longer prints "Acting as agent X (real: Y)" when the "real" agent ID resolves to a customer record (i.e. doesn't exist in `cache_agent`). Impersonation is only reported when both the parent and current agent IDs exist as real agents.

### Preferences UX
- **Cards reordered and renamed.** "Display preferences" → **Ticket 360**, "Form field helpers" → **In-page tools**, "Custom Halo domains" moved to the bottom under an **Advanced** eyebrow. The uppercase kicker labels were replaced with a one-line helper paragraph so the headings carry the information.
- **Sub-prefs stay visible when their parent is off.** The three Ticket 360 sub-toggles used to vanish when "Enable Ticket 360" was unchecked. They now stay on screen but grey out, with a left accent line connecting them to the parent — so the user can see what they'd unlock by re-enabling.
- **Bigger, more comfortable toggles.** Toggle switches grew from 32×18 to 36×20 with a tighter focus ring for keyboard accessibility. Rows now have a hover background and small rounded corners.

### API behaviour
- **Removed `halo-app-name` and `x-halo-service` headers.** Both `haloApiRequest()` and `runHaloReport()` previously sent `halo-app-name: halo-agent-app` and `x-halo-service` markers to look like first-party requests. Halo's dev team flagged that third parties shouldn't use those headers (they identify Halo's own UI) and they're adding server-side checks. HaloPlus now identifies as a plain authenticated API caller via the bearer token. No functional change today; future-proofs against the server-side filter.

### Side panel diagnostics bridge
- **`HU_PANEL_LOG` forwarder.** The side panel now broadcasts diagnostics-style log entries through the service worker to the active content script, which writes them to the Halo page's DevTools console. Previously the side panel had its own console nobody could open while a Halo tab was active.

### Fixes
- **Data Viewer columns now match the header row.** `renderRecordRows` used to build cells from `Object.keys(rows[0])` while the header was built from `getViewerColumns()`. Result: when a column profile was applied the header showed 10 columns and the body still showed 6. Both now go through `getViewerColumns()`.
- **Sticky API toolbar no longer leaks text.** A 10px padding-top on the shared drawer body let scrolled content show through above the sticky search toolbar in the API reference. Padding is now zeroed on the API drawer specifically; the results pane inherits the spacing from its own inset.
- **API path text readable in dark mode.** The path chip used to inherit a bright background from Halo's host-page `code {}` rule. Explicit `background: transparent` on `.hu-api-path` plus a muted slate `#cbd5e1` foreground replaces the previous near-white and earlier orange variant.

## 1.2.1

### Palette
- **Open-count chip is now clickable.** Click the orange `12 open` badge on a ticket-scoped command to drop straight into that command's scope, filtered to just the open tickets (newest first). Equivalent to typing the command and the trailing space, but with `open_only=true` and an explicit `id desc` order applied to the API call. Scope clears as soon as you switch to a different command.
- **Chip drill-down also works on `/cfg` and on individual config sections.** Clicking the `33 ›` chip on the `/cfg` row drills into the section list; clicking the count chip on a section (e.g. `Tickets · 27 ›`) drills into that section's subsections. Same destination as ArrowRight, faster with the mouse.
- **Ticket type rendered as its own pill** in result rows, sitting alongside the status pill. The subtitle now shows just end-user + client, so the ticket type stands out instead of being buried in the dot-separated tail.

### Ticket 360
- **Status and priority pills now show a small caret** to telegraph that they're clickable (status / priority picker). Caret stays attached even after the pill relabels itself on a status change.
- **Priority pill colour now comes from `cache_priority`** so it matches the tenant's actual Halo palette in Settings → Priorities (same treatment the status pill already had). Falls back to the regex-derived class when the cache is empty or the colour isn't a valid hex/rgb.
- **Timeline dot colours now come from `cache_actionoutcome`** (with `cache_outcome` as a secondary fallback). Matches by `outcome_id` first, then case-insensitive outcome name. When no tenant colour is configured, the existing semantic regex (status / email / note / time) still applies. Applied to both the 360 inline timeline and the dedicated Action Timeline.
- **Adjusted time on actions is now surfaced.** Halo's `timetaken_adjusted` field (set by supervisors to override the agent-logged time for billing) wins over the raw `timetaken` whenever it's set. The 360 pill turns indigo with a dotted underline when adjusted differs from raw, and the tooltip shows both values (`Adjusted 30m (raw 45m)`).
- **SLA bars + donut: side-by-side 40/60 split.** Respond takes 40% of the row / arc, Fix takes 60%. Single-SLA tickets get the full width / full arc. The donut keeps an 8% gap between its two slices so the boundary stays visually distinct.
- **Used vs spare on met SLAs.** Closed-and-met SLAs now show how much of the window was consumed — full-colour band for the used portion, 30%-opacity overlay of the same colour for the remaining headroom. A Fix closed at 63% of its window reads as a strong 63% band with a faint 37% tail. Breached and live SLAs still render as a single solid fill.
- **Status icons on SLA bars + donut.** Met-on-time renders a green check (replacing the "Met" text). Breached SLAs (met-late or live past-due) render a red filled-circle X badge followed by the overshoot duration. The donut centre shows the verdict for closed tickets: `✓ All met` or `✗ Fix 30s over`. Plain countdown states (`3h left`, `Closed`) stay as text.
- **Closed-ticket SLA donut shows a verdict.** Instead of arbitrarily surfacing one finished SLA, a closed ticket renders either `✓ All met` (green) or `✗ <name> <overshoot>` (red, worst breach by overshoot duration). Open tickets keep the "most critical active SLA" behaviour.
- **Donut caption moved below the arc.** Long verdicts overlapped the curve. The caption now sits 8px under the donut with the full 140px width to work with. Container height grew from 48px to 72px; the meta-row aligns vertically so neighbouring chips stay centred.

### Fixes
- **Double-click to show field API names** no longer triggers while editing inside Halo forms. The handler now also ignores clicks on `<form>` descendants, native form widgets without a wrapping form (Halo's React app omits it in places), and ARIA `button` / `combobox` / `listbox` / `textbox` / `searchbox` / `checkbox` / `radio` / `option` roles.
- **Logged time now renders correctly in the timeline.** Halo's `actions.timetaken` field is stored as decimal hours, not minutes. The previous code treated it as raw minutes, so a 15-minute log (stored as `0.25`) rounded to `0m` and the pill never rendered. Both the Ticket 360 amber pill and the dedicated Action Timeline (per-row and total) now convert hours → minutes before formatting. The inline "Log time" editor also now POSTs `timetaken: minutes / 60` so newly-logged entries are saved with the right magnitude in Halo. (Older entries written by HaloPlus 1.2.0 stored their minute value in the hours column — check those manually if you used the inline time editor before this fix.)
- **Respond SLA met-vs-breached now reads from `responsedate`.** The actual response timestamp is the source of truth for met-on-time vs met-late — the dashboard compares it to `respondbydate` and shows the icon + overshoot accordingly. `slaresponsestate === 'O'` short-circuits any "completed" fallback so a closed ticket with a late response no longer renders green. Closed-and-met-on-time stays green; closed-and-met-late shows the red cross + overshoot.
- **Sub-minute overshoots now show in seconds.** `formatDurationShort` used to round anything below a minute to "0m". A response 30 seconds late now reads "30s over" rather than "0m over".
- **Halo timestamps now parse as UTC.** Halo's entity APIs return ISO datetimes without a `Z` suffix (e.g. `2026-05-13T18:01:50.347`), which JavaScript interprets as local time per ECMA-262. The result was every date being skewed by the user's timezone offset — CEST agents saw "Opened" times 2h early, SLA percentages drifted, and "open Xd" badges could be off by a day. A new `parseHaloDate()` helper appends `Z` to any Halo datetime missing a timezone indicator so all downstream math (`formatDateTime`, SLA donut, SLA bars, aging badges, average-close, timeline ordering, recent records sort) runs in UTC and renders in the user's local zone.

## 1.2.0

### Non-admin agents can now use HaloPlus
Until 1.2.0, almost every feature funnelled through `/api/Report` (Halo's SQL passthrough endpoint). That endpoint is typically restricted to admins and roles with explicit report-running claims (`Can_Use_DataSources` / `Can_Use_Reports`), which most help-desk agents don't have. The result for non-admins: 403 floods on every keystroke and empty results everywhere. v1.2.0 rewrites the foundation so non-admin agents get a working experience that matches what their Halo role actually allows.

- **Entity-API rewrite for the command palette.** All palette searches (`/t`, `/i`, `/prob`, `/chg`, `/req`, `/hr`, `/fac`, `/dft`, `/mw`, `/mi`, `/prj`, `/c`, `/a`, `/u`, `/asset`, `/kb`, `/inv`, `/q`, `/po`, `/s`, `/team`) now hit Halo's permission-respecting entity endpoints (`/api/tickets`, `/api/client`, `/api/agent`, `/api/users`, `/api/asset`, `/api/KBArticle`, `/api/invoice`, `/api/quotation`, `/api/purchaseorder`, `/api/site`, `/api/team`) instead of `/api/Report`.
- **Ticket 360, Action Timeline, and Inspect Record JSON** migrated to `/api/tickets/{id}` + `/api/actions?ticket_id=` so they work for agents who can view tickets in Halo's UI.
- **Impersonation agent search** now uses `/api/agent?search=` with `/api/agent/{id}` for exact-id lookups. SQL is the fallback only.
- **`/api/Report` probe gates remaining SQL paths.** When the probe returns 403, the open-ended cross-record palette search, Data Viewer, and Schema tabs are skipped/hidden instead of firing guaranteed-failure POSTs every keystroke.
- **Live access-token rotation.** `haloApiRequest` now reads the `access_token` cookie on every call. Halo rotates this token mid-session; the previous code used a cached `localStorage` token and 401'd until refresh.

### Ticket 360 — editable dashboard
Ticket 360 has been rebuilt as a working dashboard. Most ticket fields can be edited inline without leaving the panel; the dashboard auto-refreshes after each change with no re-animation, and the slide-out / slide-in is skipped on in-place refresh so scroll position is preserved.

- **Inline summary edit.** Click the ticket title to edit it in place. Enter saves via `POST /api/tickets`, Escape cancels, paste strips formatting, empty input reverts.
- **Customer picker.** Click the Customer row (whole row, no separate button — profile-link clicks still navigate normally) to open a debounced `/api/users?search=` picker. Picking a user patches `user_id` (plus `client_id` / `site_id` when present) and refreshes the dashboard.
- **Assignee picker.** Click the Assigned-to row to open `/api/agent?count=500&includedetails=true` — cached client-side, results grouped by team with a sticky team header. Filtering matches agent name, email, AND team name. Picking patches both `agent_id` and `team_id` + `team` name so Halo doesn't fall back to the agent's default team.
- **Status picker uses Halo's own scoped endpoint.** `/api/Status?type=ticket&tickettype_id=X&workflow_id=Y&workflow_step=Z` mirrors what the OOTB ticket form requests, so only the statuses the ticket can transition to from its current workflow step appear. Statuses with an empty/missing `used_in_ticket_types` array are hidden. Falls back to `cache_status` if the call fails.
- **Status pill takes its colour from `cache_status.colour`** (sanitised to hex/rgb) so it matches Halo's per-status palette in both themes. The chip re-skins live when the user picks a new status.
- **Drawer header shows the ticket label** (e.g. `[IN-0003112]`) instead of the generic "Ticket 360" — saves space and gives the agent the most useful identifier up front.
- **Quick actions.** Note and Time editors are inline and toggleable (re-clicking the button closes the editor), Flag toggles directly, and a new **Copy link** button copies the ticket URL with a 1.5s "Copied" flash. Native Clipboard API with a `textarea + execCommand('copy')` fallback for non-secure contexts.

### People section
- **Real avatars.** Agent photos come from `/api/agent/{id}?includedetails=true&isagentconfig=true` — either `agentphotodata` (base64 data URI, rendered with zero extra requests) or `agentphotopath` (relative path, resolved to same origin). Customer photos try `ticket.user` first, then `/api/users/{id}`. Falls back to initials on 404. Both endpoints are cached per session.
- **VIP / Key contact badge** uses `vertical-align: middle` for clean baseline alignment, and the light-mode palette is now a bright alerting orange (`#9a3412` on `#ffedd5` with a `#fb923c` border) instead of the previous brown-on-cream that was hard to read. The "Key contact at this client" banner uses the same palette so the two read as a set.

### SLA donut
- A new **half-donut visualisation** sits next to the chip row in the hero. It shows the **most critical** SLA — ranked by worst state class (danger > warn > ok), tiebreaking by highest percent used. Time-remaining (`2h left` / `15m over`) renders inside the bowl in the matching colour. Auto-hides on tickets with no SLA dates set.
- Hovering the donut shows a native tooltip with all SLAs (`Respond: 92% (15m left) / Fix: 67% (2d left)`); the full per-SLA bars still appear in the Workflow & SLA card below.

### Workflow & timeline
- **The active workflow step pulses slowly** (4-second cycle, opacity 100% → 10% → 100%) while the ticket is open and hasn't reached the final stage. Stops on the final stage or once `dateclosed` lands. Respects `prefers-reduced-motion`.
- **Time-logged actions show the duration** as a small amber pill next to the action title in the timeline (e.g. `15m`, `1h 30m`).
- The "Opened" event is now detected by chronologically-earliest timestamp instead of regex-matching the outcome name — custom outcomes containing the word "logged" no longer hijack the slot.

### Custom ticket types
- Tenant-defined ticket types ("Laptop Request", "Peripherals Request", etc.) are now auto-discovered and added to the palette as `/laptop-request`, `/peripherals-request`, etc. Multiple fallbacks ensure they load: SQL → `/api/TicketType?count=200&includedetails=true` → `localStorage.cache_tickettype` → static schema.
- Custom types appear in the **default palette view** and in **text-search results** (typing "laptop" matches `/laptop-request`).
- **Open-ticket counter** appears in the kind chip (e.g. `12 open`) for every ticket-scoped command — both custom types and built-ins like `/t`, `/i`, `/prob`, `/chg`. Counts resolve via name-match against `cache_tickettype`, summed per command. Refreshed once per palette open, cached 5 min.
- **Email tag prefix pre-fetch** — for non-admin agents who can't run SQL, HaloPlus fetches `/api/TicketType/{id}?includedetails=true` per type on first palette open to learn the `email_start_tag_override` (`[SR-`, `[INC-`, etc.) so ticket titles render as `[SR-0003135] Laptop Request - Standard` instead of an auto-generated `[LR-…]` prefix.
- Clicking `/laptop-request` navigates to Halo's "All Ticket Types" view with `selid={typeId}` — the only Halo URL pattern that filters to a single ticket type across areas.
- Server-side ticket-type filter uses Halo's actual parameter `requesttype=` (`tickettype_ids` is silently ignored by Halo). Verified by direct probing.

### Palette UX
- **Entity-API access probe on init**: each entity endpoint is probed once; commands whose endpoint returned 401/403 are greyed out (45% opacity, "No access" chip, tooltip) and sorted to the bottom of the result list.
- **Admin-only commands hidden for non-admins**: `/cfg` (configuration), `/imp` (impersonate), `/xi` (exit impersonation) are filtered out entirely for users whose claims don't permit them, rather than greyed out — they're action commands, not search commands.
- **ArrowRight autocomplete** for slash commands: type `/peri` → ArrowRight → input becomes `/peripherals-request `, ready for a scope search.
- **Loading spinner row** while entity API calls are in flight (typically 1–2s for ticket/KB lookups).
- **Ticket results show a coloured status pill** (e.g. green "Resolved", yellow "On Hold") drawn from Halo's per-status colour in `cache_status`. Pill colour is sanitised to hex/rgb before injection so a malformed cache entry can't break out into other styles.
- **Partial numeric ID search** in scoped ticket commands: `/i 30` now surfaces ticket #3079 (recent-tickets fetch + client-side ID-contains filter + always-attempt exact `/api/tickets/30` lookup as a top hit).
- **Ticket titles use the format `[IN-0003079]`** (2-letter prefix, dash, zero-padded 7-digit ID). Subtitles show ticket type + end-user + client (de-duped).
- **`/i` filters to Incidents only**, `/t` remains an all-tickets catch-all.
- New aliases: `/client`, `/clients`, `/org`, `/orgs`, `/organisation`, `/organisations` (already in 1.1.1).

### KB results
- KB subtitles now include the article **category** (FAQ list / KB category / category_1, etc.) alongside the description snippet.
- `/kb` now hits the correct Halo endpoint `/api/KBArticle` (was `/api/kbentry`, which doesn't exist — kbentry is the underlying SQL table name).

### Side panel & icon
- **Extension icon is greyed out** on non-Halo tabs and lights up on real Halo tenants (built-in `*.halopsa.com`, `*.haloitsm.com`, `*.haloservicedesk.com` patterns and any user-added custom domain with Chrome host permission actually granted). Greyscale is computed once via `OffscreenCanvas` from the bundled PNG and cached for the service-worker lifetime — no extra image assets bundled.
- **Adding/removing a custom domain** in Settings refreshes all open tab icons immediately; no reload needed for the affected tabs to light up.
- **"HaloPlus needs a tab refresh" notice** in the side panel for the case where the active tab is a Halo URL but the content script didn't respond — typical post-CWS-update state on an already-open Halo tab. Includes a one-click Refresh button.
- **`/api/Report` access notice** rewritten in plain language — no longer references the endpoint path or the `Can_Use_DataSources` / `Can_Use_Reports` role codenames.
- **Command palette utility icon** changed to a clean diagonal slash, matching the `/` keystroke that opens it.
- **Ticket 360 utility icon** now uses the same panel-outline shape as the in-page injected button so the visual identity is consistent.

### Diagnostics
- The Settings → Diagnostics card now reports the agent's Halo role (admin flag, impersonation state, total claims, key permissions), the `/api/Report` probe result, per-entity API access for all 10 endpoints, and ticket type loading status. Makes "why isn't this working for me?" a one-click answer.

### Fixes
- **Custom domain save no longer fails on the first attempt.** Chrome's permission prompt steals focus from the side-panel popup and closes it, killing the save handler mid-await. The save now writes to storage before requesting permission, and a service-worker `chrome.permissions.onAdded` listener completes the content-script registration even if the popup died. Explicit denial rolls back the eager save. Saved domains without an active Chrome permission no longer light up the icon — they fall through to the existing "Re-grant access" banner.
- **Halo's public docs site (`haloitsm.com`, etc.) no longer counts as a Halo tenant.** The host pattern now requires at least one subdomain segment, matching what `*.haloitsm.com/*` already required at the manifest level.
- `/q` (quotes) now correctly unwraps the response envelope (Halo's `/api/quotation` returns `{quotes: [...]}`, not `{quotations: [...]}`).
- `/api/agent` and `/api/asset` are accepted both as bare arrays and as named-array envelopes (some Halo versions wrap, others don't).
- Halo's "no value" date sentinel (1900-01-01) is filtered out of Ticket 360 / Timeline so empty fields render blank instead of "Jan 01, 1900".
- Out-of-order `datecleared` (before `dateoccurred`) is treated as unset so the SLA arc and time card stay consistent.
- Agent picker grouping de-duplicates by team id OR name. Halo's `/api/agent` can return the same agent under multiple team records (with one carrying `id: null`); the picker now sorts id-bearing entries first so the dedup keeps the usable copy.
- Sticky team header in the agent picker no longer bleeds — `z-index` + flush-top positioning prevents items from peeking above it.
- Linked records section auto-hides when nothing's linked, instead of rendering an orphan section header.

## 1.1.1

### Fixes
- `/client`, `/clients`, `/org`, `/orgs`, `/organisation`, `/organisations` (and US-spelling variants) now resolve to the customer search. Previously only `/c` worked, so users typing the full word saw no command.
- After upgrading the extension, custom Halo domains saved in Settings were appearing as configured but Chrome had revoked the host permission — silently breaking page detection. The "Halo page not detected" banner now detects this state, names the affected domains, and offers a **Re-grant access** button that re-requests Chrome's permission and re-registers the dynamic content script in one click.
- `chrome.scripting.registerContentScripts` errors used to be swallowed silently when permission was missing. The service worker now records the last registration error to `chrome.storage.local` (`huCustomDomainLastError`) so the panel can surface it.
- Adding a custom Halo domain with a port (`halo.example.com:8080`) used to silently strip the port and save a pattern that never matched. The Settings form now refuses domains with ports and explains that Chrome's permission system covers the host on any port.

### Diagnostics
- Added a **Diagnostics** card to Settings → Help & About. **Run diagnostics** runs a live check of Chrome permission status per saved domain, whether the dynamic content script is registered for each match, the active tab's URL, and whether the content script responds on it. **Copy diagnostics** puts a plain-text summary on the clipboard so users can share their state with support without using DevTools.

## 1.1.0

### Preferences
- Added a master **Enable Ticket 360** toggle. Disabling it hides the Ticket 360 button, stops auto-open, and hides the related sub-options.
- Changed Ticket 360 auto-open default to **on** and "Hide Halo sidebars" default to **off**.
- Added a **Double-click to show field API names** preference (default on) that gates the page-wide double-click handler.
- Added a GitHub link to the About card in Settings.

### Configuration palette (`/cfg`)
- `/cfg` (and `/config`) is now a scoped command: shows all Halo configuration sections, filters as you type, supports deep links like `/cfg tickets tickettype` → `/config/tickets/tickettype`.
- **Right Arrow** on a highlighted result drills into that section or activates a deep-link result.
- Sections with available subsections show an orange count badge so it's obvious which ones are drillable.
- Subsections are learned dynamically: a one-time iframe-based sweep on first install builds the cache, and every visit to `/config/{section}` refreshes that section's subsections in the background.
- A loading pill in the bottom-right of the palette indicates when discovery is running (`Indexing Tickets (6/33)` during the sweep, `Indexing Tickets…` for single-section backfills).
- Right Arrow on the top-level `/cfg` entry (e.g. when typed via `/c`) drills into the config sections list.

### Email-template variable picker
- Type `$` in any Halo email-template body, subject input, or Froala link/image dialog input to open a searchable picker of all 828 Halo template variables.
- Typing after the `$` filters by name or description; ↑ ↓ navigate, Enter / Tab insert, Esc dismiss.
- Category dropdown lets you narrow by entity (Ticket, Agent, Action, Invoices, Custom fields, etc.). Resets to All on each open.
- Buttons (variables that render as clickable buttons in Halo emails — `{$AGENTEMAIL}`, `{$LINKTOWEBAPP}`, etc.) are tagged in the picker and inserted with the correct `{$NAME}` syntax.
- On first use on an email-template page, HaloPlus queries Halo's schema for `CF*` columns on `faults` / `area` / `users` / `device` / `site` / `uname` and adds tenant-specific custom fields to the picker (cached for 7 days).
- Picker survives Froala's input quirks via an 80ms poll loop on the active field, so filtering stays in sync even when Froala swallows native input events.

### Palette UX polish
- Added a polite review prompt: after 5 days of palette use the user sees a one-time banner inviting a Chrome Web Store review (with snooze and dismiss). Hides the toolbar while the banner is up to avoid overlap.
- **Up Arrow** at the top of the result list now recalls the previous typed command (shell-style history). Repeated presses walk further back through history (stored in `chrome.storage.local`).
- Mouse hover no longer hijacks keyboard navigation — moving the cursor over a row used to snap the selection back; now `mousemove` is required so arrow keys win when the cursor is stationary.

### Fixes
- `/config/tickets/tickettype?id=1` no longer triggers Ticket 360 auto-open. The page-classification check now puts `/config` ahead of `/ticket` so configuration pages with "ticket" in the path don't pose as tickets.
- Variable picker popup uses `z-index: 2147483647` + `isolation: isolate` and attaches to `document.documentElement`, so Froala's link / image dialogs can't render on top of it.
- Variable picker docks alongside the Froala popup (right, left, or below) instead of overlapping the popup's other inputs.
- Removed the inline view-detection script from `panel.html` (it was unused; this kills the related CSP warning for anyone still running a cached copy).
- Dark-mode hover state on the orange "Leave a review" button stays orange instead of falling back to the generic dark hover.

## 1.0.3

- Hardened palette navigation against `javascript:` and other non-http(s) schemes in saved custom commands.
- Validated user-entered URLs in the custom commands form (only paths and http(s) URLs accepted).
- Escaped table, column, and meta-tag values in the side panel where dynamic data was rendered into HTML.
- Tightened recent-records drawer navigation to reject non-http(s) URLs.
- Fixed `/s` scoped site search to use the actual `SSitenum` / `SArea` columns.
- Combined `/c` and `/u` into a single customer search that returns both organisations and end-users.
- Scoped `/hr` and `/fac` by the ticket `Sectio_` field so they catch all HR / Facilities tickets regardless of underlying request type.
- Cleaned up the `/asset` and `/kb` entity definitions to stop referencing columns that aren't always present.
- Added a hover-revealed palette toolbar (top-right of the palette) with:
    - Placement chooser (top-left / center / top-right; center is wider, side variants are narrower).
    - Light/dark theme toggle.
    - Font size + / - controls.
    - Shortcut to open the HaloPlus settings page.
- Palette placement and font scale are now persisted in `chrome.storage.local` and stay in sync across open Halo tabs.

## 1.0.2

- Initial public source release.
- Added custom Halo domain support through optional host permissions.
- Added settings for saving custom Halo URLs or hostnames.
- Removed the Halo lookup builder tools.
- Limited Ticket 360 and Action Timeline to active ticket pages.
- Improved Ticket 360 sidebar hiding on slow-loading ticket pages.
- Added source-available project documentation and contribution guidelines.
- Added `homepage_url` metadata.
- Added the Monaco bridge to extension web-accessible resources.
