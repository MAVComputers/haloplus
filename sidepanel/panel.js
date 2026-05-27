/**
 * HaloPlus - Side Panel Logic
 */

let TABLES = {};
let JOINS = [];
let VARIABLES = {};
let TEMPLATES = {};
let pageContext = null;
let isHaloTab = false;
let currentTheme = 'light';

const THEME_KEY = 'huTheme';
const SETTINGS_KEY = 'huSettings';
const CUSTOM_DOMAINS_KEY = 'huCustomHaloDomains';
// HALO_HOST_PATTERN is provided by shared/constants.js (loaded before this script).
const RELEASES_URL = 'https://www.gethaloplus.com/releases.html';
const MANUAL_URL = 'https://www.gethaloplus.com/manual.html';
const LAST_SEEN_VERSION_KEY = 'huLastSeenVersion';

// Per-version highlights shown in the "What's new" banner after an update.
// Keep entries short + end-user focused — implementation/admin internals
// belong in CHANGELOG.md. Only the entries for the current manifest version
// are surfaced.
const RELEASE_HIGHLIGHTS = {
  '1.3.2': {
    title: 'What\'s new in HaloPlus 1.3.2',
    items: [
      ['Critical fix for v1.3.0 update', 'If you updated from v1.2.1 to v1.3.0 today, the side panel rendered but no buttons or tabs reacted to clicks. The cause: the v1.3.0 zip we published to the Chrome Web Store accidentally omitted a bundled folder. This release packs everything correctly AND hardens the panel\'s startup so a single missing file can never break it like that again.'],
      ['Includes everything from v1.3.1', 'Multi-Tab compatibility (palette no longer closes your other Halo tabs), optional "open palette navigation in a new Halo tab" preference, the right-click context menu (Open Ticket 360 / View audit log / Open JSON inspector / Toggle field overlay), and the Ticket 360 button injecting into every open ticket. v1.3.1 was tagged but never reached the Chrome Web Store.'],
      ['"Read the full manual" button', 'New button in Settings → Help & About → Getting started, opens the full chapter-by-chapter manual at gethaloplus.com/manual in a new tab.']
    ]
  },
  '1.3.1': {
    title: 'What\'s new in HaloPlus 1.3.1',
    items: [
      ['Plays nicely with Halo\'s Multi-Tab mode', 'If you use Halo\'s "Multiple Halo tabs per browser tab" setting, palette navigation no longer closes your other tabs. HaloPlus now talks to Halo\'s React Router directly via a main-world bridge instead of doing a full page reload. Reported as issue #3.'],
      ['Optional: open palette navigation in a new Halo tab', 'New toggle under Settings → Preferences → In-page tools. When on, every palette navigation opens in a new Halo tab instead of replacing the active one. Auto-detects whether Multi-Tab mode is actually enabled and falls back to replacing the current tab when it isn\'t.'],
      ['Ticket 360 button now appears on every open ticket tab', 'In Multi-Tab mode the toolbar button used to inject into only the first open ticket. Fixed — every open ticket\'s toolbar gets it.'],
      ['Right-click context menu on Halo pages', 'Four new entries: Open Ticket 360, View audit log for this ticket, Open JSON inspector, Toggle field API names overlay. The ticket-specific items hide when you\'re not on a ticket page.'],
      ['Faster, fewer 429 rate limits', 'Same-origin clicks inside Ticket 360 (client / site / user / KB links) used to do a full page reload, which re-fires every API call Halo makes on boot. Heavy palette + 360 use was burning through the per-IP rate limit. Both fixed — those clicks now SPA-navigate, and Halo stops re-bootstrapping on every navigation.']
    ]
  },
  '1.3.0': {
    title: 'What\'s new in HaloPlus 1.3.0',
    items: [
      ['Tenant environment label', 'A colour-coded chip on every Halo page tells you which tenant and which environment you\'re on — red for live, amber for sandbox, blue for dev. Drag the chip anywhere along the screen edge and it snaps to the corner you let go of. Stops you from changing PROD when you meant to test in sandbox.'],
      ['Custom Halo domains, rebuilt', 'The custom-domains card now lets you label each tenant ("ACME LIVE", "Pink Sandbox") and pick its environment, so the chip is meaningful for tenants on custom URLs. The add dialog stays hidden until you click "+ Add tenant" and pre-fills the hostname from the page you\'re on.'],
      ['Audit log in Ticket 360', 'New "View audit log" link in the 360 footer opens a side drawer with the ticket\'s full change history, grouped by transaction. Field names are translated to friendly labels, and ID-backed values (status, priority, agent, team, workflow, impact, urgency, ticket type) are resolved to real names. Filter by field with a live counter and most-changed chips at the top.'],
      ['Popup notes, viewed-by and appointments in 360', 'Halo popup notes (VIP / contract warnings) now show as banners above the ticket summary, honouring their dismissable / modal / HTML / date-range settings. A "viewed by" chip shows other agents who recently opened the ticket. A next/last appointment chip appears in the badge strip when one is set.'],
      ['Data Viewer: saved queries + column profiles', 'Save the current SQL + filters under a name, recall from the new star menu on any table. Column picker now offers HaloPlus presets plus your tenant\'s own saved views (Tickets, Customers, Sites, Users, Assets) — pick one and the table renders the same columns you\'d see in Halo\'s list view. Toggle between SQL / API / Both perspectives on the schema explorer.'],
      ['244-endpoint API reference', '/api was rebuilt from Halo\'s swagger. The drawer ships 244 endpoints across 13 categories with a sticky search box, multi-select method chips (GET / POST / PUT / DELETE / PATCH), and a live "X of Y" count. Each row expands to show path and query parameters. Search matches param names too — type "client_id" to find every endpoint that takes one.'],
      ['Schema labels from saved views + clickable FKs', 'The schema explorer reads /api/ViewColumns and stitches your tenant\'s friendly column titles onto matching API rows. Columns that only appear in saved views are added as new rows. FK chips (e.g. FK -> site.SSitenum) are now interactive — click to jump to the referenced table and flash the destination column.'],
      ['Extended endpoint probes', 'Diagnostics has a new "Run extended probes" button that tests 10 candidate endpoints — /api/Agent/me, /api/Search, /api/ViewColumns, /api/PopupNote, /api/FaultViewLog and more — reporting HTTP status, latency, and response shape. Use it to see what your role unlocks.'],
      ['Preferences UX rework', 'Cards reordered and renamed (Ticket 360 → In-page tools → Advanced), labels rewritten, sub-prefs stay visible (greyed out) when their parent is off so you can see what re-enabling unlocks. Toggles a touch larger with cleaner hover and focus states.']
    ]
  },
  '1.2.1': {
    title: 'What\'s new in HaloPlus 1.2.1',
    items: [
      ['Reworked SLA visualisation', 'Respond and Fix sit side-by-side as separate bars (40/60 split) with the same split on the hero donut. Closed-and-met SLAs now show how much of the window was used — dark band for consumed, lighter band for the headroom. A green check marks met SLAs, a red badge marks breaches, and the donut centre shows the closing verdict ("All met" or "Fix 2h over").'],
      ['Click the open-count chip to drill in', 'Clicking the orange "12 open" badge on a ticket-scoped command drops you straight into that scope, filtered to open tickets (newest first). The /cfg chip and individual section chips drill into their submenus the same way.'],
      ['Ticket type pill in palette results', 'Each result now has a dedicated ticket-type pill next to the status pill, with the end user and client moved into the subtitle.'],
      ['Tenant-matched colours', 'Priority pill uses your tenant\'s configured Halo priority colour, and action timeline dots use your configured outcome colours. Both fall back to the previous palette when no colour is set.'],
      ['Adjusted action time shown', 'When a supervisor adjusts the billable time on an action, the timeline pill now shows the adjusted figure (indigo + dotted underline) with the raw value in the tooltip.'],
      ['Halo timestamps fixed', 'Ticket 360, SLA bars, aging badges, and the timeline now render in your local timezone correctly. Halo\'s API returns datetimes without a timezone marker — HaloPlus now treats them as UTC instead of local, eliminating multi-hour skew for agents outside UTC.'],
      ['Logged time unit fix', 'The inline "Log time" editor was writing minutes into Halo\'s hours field, and timeline pills were showing 0m for sub-hour entries. New entries now save and render correctly. Older entries written by 1.2.0 may need a manual review in Halo (they\'ll show inflated totals).'],
      ['Caret icons on Ticket 360 pills', 'Status and priority pills show a small caret so it\'s clear they\'re clickable pickers. The caret stays put when the pill relabels after a status change.'],
      ['Double-click in forms no longer triggers field names', 'The "show technical field names" double-click handler now ignores Halo form widgets so it won\'t fire while you\'re editing.']
    ]
  },
  '1.2.0': {
    title: 'What\'s new in HaloPlus 1.2.0',
    items: [
      ['Works for non-admin agents', 'Palette searches, Ticket 360, and Action Timeline now use Halo\'s permission-respecting entity APIs instead of /api/Report SQL — admin-level access is no longer required for everyday features.'],
      ['Custom ticket types in the palette', 'Tenant ticket types (Laptop Request, Peripherals Request, etc.) get their own /slug command with live open-ticket counters and the correct [SR-…] prefix.'],
      ['Smarter command palette', 'ArrowRight autocompletes a slash command (e.g. /peri → /peripherals-request), partial numeric search surfaces ticket #3079 when you type /i 30, and ticket titles render as [IN-0003079] Summary.'],
      ['Coloured status pills', 'Ticket results, Ticket 360, and the action timeline show status in your tenant\'s actual Halo colours.'],
      ['Reworked the Ticket 360 dashboard', 'Edit the summary, customer, assignee, status, priority, notes, time, and flag in place. New SLA donut in the hero, agent/customer profile photos, and a pulsing workflow step while the ticket is in progress.'],
      ['Better KB results', '/kb hits the correct Halo endpoint and now shows the article category alongside the snippet.'],
      ['Greyed-out toolbar icon', 'The HaloPlus icon turns grey on non-Halo tabs and lights up on real Halo tenants — easy at-a-glance status.'],
      ['Diagnostics card', 'Settings → Help & About now reports your Halo role, /api/Report access, per-endpoint API access, and ticket-type loading. Makes "why isn\'t this working for me?" a one-click answer.'],
      ['Side panel polish', 'Data Viewer and Schema hide gracefully when your role can\'t use them, a one-click Refresh handles post-update stale tabs, and the "features hidden" notice is now plain language.']
    ]
  }
};

const PAGE_RELEVANT_TABLES = {
  ticket:       ['faults', 'actions', 'slahead', 'policy', 'requesttype', 'tstatus', 'flowheader'],
  organisation: ['area', 'users', 'site', 'company'],
  asset:        ['device', 'assettype'],
  agent:        ['uname', 'team'],
  lookup:       ['faults', 'actions'],
};

let viewerState = {
  tableId: '',
  filters: [],
  lookupOptions: {},
  lastRows: [],
  lastSql: '',
  pageSize: 20,
  currentPage: 1,
  // Column view selection. Values:
  //   'default'      → top-N scored heuristic (legacy behaviour)
  //   'all'          → every SQL-queryable column on the table
  //   'profile:<id>' → Halo's saved column profile from /api/ViewColumns
  columnView: 'default',
  // Cached Halo column profiles for the current table (loaded lazily).
  // null = not yet attempted, [] = loaded but empty, else array of profiles.
  cachedProfiles: null
};

// Tables we can fetch Halo column profiles for. Halo's /api/ViewColumns
// covers ticket / customer / site / user / asset / supplier — agents and
// other entities have no profile endpoint, so we just don't offer the
// dropdown for those tables.
const TABLE_TO_VIEWCOLUMN_ENTITY = {
  faults:  'ticket',
  users:   'user',
  area:    'customer',
  site:    'site',
  device:  'asset',
  company: 'supplier'
};

async function loadColumnProfilesForCurrentTable() {
  const tableId = viewerState.tableId;
  const entity = TABLE_TO_VIEWCOLUMN_ENTITY[tableId];
  if (!entity) return [];
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'HU_GET_COLUMN_PROFILES', data: { entity } }, response => {
      if (chrome.runtime.lastError || !response?.ok) { resolve([]); return; }
      resolve(Array.isArray(response.profiles) ? response.profiles : []);
    });
  });
}

// Resolve one ViewColumns `column_name` (API field name) to the actual
// SQL column we can SELECT in our query. Returns null when the column
// can't be mapped to SQL.
//
// Resolution order (most specific → fuzziest):
//   1. Direct case-sensitive match on the SQL column name.
//   2. Curated API_TO_SQL_NAME mapping for this table.
//   3. Case-insensitive direct match.
//   4. `col.apiAlias` annotation populated by mergeApiFieldKeys when the
//      schema's API-record harvest matched this API name to an SQL column.
function resolveProfileColumnToSql(tableId, apiName) {
  const table = TABLES[tableId];
  if (!table || !apiName) return null;
  const lookup = String(apiName).trim();
  if (!lookup) return null;
  const lowered = lookup.toLowerCase();

  // 1. Direct case-sensitive match
  const direct = table.columns[lookup];
  if (direct && direct.type !== 'api') return { name: lookup, col: direct };

  // 2. Curated mapping (e.g. summary → Symptom on faults)
  const mapping = (typeof API_TO_SQL_NAME === 'object' && API_TO_SQL_NAME[tableId]) || {};
  const sqlName = mapping[lookup];
  if (sqlName && table.columns[sqlName] && table.columns[sqlName].type !== 'api') {
    return { name: sqlName, col: table.columns[sqlName] };
  }

  // 3. Case-insensitive direct match — Halo often returns lowercase names
  //    while our SQL schema uses PascalCase (UUsername, UEmail, etc.).
  for (const [name, col] of Object.entries(table.columns)) {
    if (col.type === 'api') continue;
    if (name.toLowerCase() === lowered) return { name, col };
  }

  // 4. apiAlias match — set when the schema harvest matched this API
  //    name to an SQL column. Works for tables we never put in the
  //    curated map.
  for (const [name, col] of Object.entries(table.columns)) {
    if (col.type === 'api') continue;
    const alias = col.apiAlias;
    if (alias && String(alias).toLowerCase() === lowered) return { name, col };
  }
  return null;
}

let customHaloMatches = [];

const TABLE_ROUTES = {
  faults:  id => `/tickets?id=${encodeURIComponent(id)}`,
  area:    id => `/customers?clientid=${encodeURIComponent(id)}`,
  uname:   id => `/config/agents/agents?agentid=${encodeURIComponent(id)}`,
  users:   id => `/customers?mainview=user&userid=${encodeURIComponent(id)}`,
  device:  id => `/assets?id=${encodeURIComponent(id)}`,
  kbentry: id => `/knowledgebase?id=${encodeURIComponent(id)}`,
};

const LOOKUP_LABEL_COLUMNS = {
  tstatus: 'TStatusDesc',
  policy: 'PDesc',
  users: 'UUsername',
  site: 'SDesc',
  area: 'AAreaDesc',
  requesttype: 'RTDesc',
  servsite: 'STDesc',
  slahead: 'SLDesc',
  device: 'DInvNo',
  uname: 'UName',
  flowheader: 'FHName',
  company: 'CDesc',
  sectiondetail: 'SDSectionName',
  xtype: 'TDesc',
  generic: 'GDesc',
  tree: 'TreeDesc',
  servicecategory: 'SvcDesc',
  stdrequest: 'STDid',
  item: 'IDesc',
  kbentry: 'Abstract'
};

async function init() {
  await initTheme();
  syncManifestVersion();
  // Each async load is wrapped so a single missing/broken bundle resource
  // (e.g. an icon-or-script-only zip that forgot a JSON folder) can't crash
  // init() before the setupXxx() event-wiring runs. Symptom of the original
  // bug: panel rendered but nothing reacted to clicks.
  TABLES = await safeLoadJSON('../schema/tables.json', {});
  await loadCustomSchema().catch(err => console.error('[HaloPlus] loadCustomSchema failed', err));
  await loadCachedFieldInfoCFs().catch(err => console.error('[HaloPlus] loadCachedFieldInfoCFs failed', err));
  await loadCachedApiFieldKeys().catch(err => console.error('[HaloPlus] loadCachedApiFieldKeys failed', err));
  await loadCachedViewColumnLabels().catch(err => console.error('[HaloPlus] loadCachedViewColumnLabels failed', err));
  await loadCustomHaloDomains().catch(err => console.error('[HaloPlus] loadCustomHaloDomains failed', err));
  const joinsData = await safeLoadJSON('../schema/joins.json', { joins: {} });
  JOINS = joinsData.joins || {};
  const varsData = await safeLoadJSON('../schema/variables.json', { variables: {} });
  VARIABLES = varsData.variables || {};
  const tplData = await safeLoadJSON('../templates/templates.json', { categories: [] });
  TEMPLATES = tplData.categories || [];

  setupTabs();
  renderSchemaExplorer();
  renderDataViewer();
  setupSearch();
  setupViewerEvents();
  setupUtilityEvents();
  setupRegrantButton();
  setupDiagnostics();
  setupManualButton();
  listenForContext();
  await refreshActiveTabState();
  showReleaseHighlightsIfNew();

  // Auto-refresh schema silently on load (requires an active Halo tab)
  if (isHaloTab) autoRefreshSchema();
}

async function showReleaseHighlightsIfNew() {
  let manifestVersion = '';
  try { manifestVersion = chrome?.runtime?.getManifest?.()?.version || ''; } catch (_) {}
  if (!manifestVersion) return;

  const data = await new Promise(r => chrome.storage.local.get([LAST_SEEN_VERSION_KEY], r));
  const lastSeen = data[LAST_SEEN_VERSION_KEY] || '';

  // Fresh install: don't show the banner (would be confusing on first run).
  // Just record the current version so the next update is detected.
  if (!lastSeen) {
    chrome.storage.local.set({ [LAST_SEEN_VERSION_KEY]: manifestVersion });
    return;
  }

  if (lastSeen === manifestVersion) return;
  const highlights = RELEASE_HIGHLIGHTS[manifestVersion];
  if (!highlights || !highlights.items?.length) {
    // No highlights for this version — bump the marker silently.
    chrome.storage.local.set({ [LAST_SEEN_VERSION_KEY]: manifestVersion });
    return;
  }

  renderReleaseHighlightsBanner(highlights, manifestVersion);
}

function renderReleaseHighlightsBanner(highlights, version) {
  if (document.getElementById('releaseHighlightsBanner')) return;

  const banner = document.createElement('section');
  banner.id = 'releaseHighlightsBanner';
  banner.className = 'surface-notice release-highlights';

  const itemsHtml = highlights.items.map(([title, detail]) => `
    <li>
      <strong>${escapeHtml(title)}</strong>
      <span class="release-detail">${escapeHtml(detail)}</span>
    </li>
  `).join('');

  banner.innerHTML = `
    <div class="release-header">
      <strong>${escapeHtml(highlights.title)}</strong>
      <button class="release-dismiss" id="releaseDismissBtn" type="button" aria-label="Dismiss">&#x2715;</button>
    </div>
    <ul class="release-list">${itemsHtml}</ul>
    <div class="release-footer">
      <a href="${escapeHtml(RELEASES_URL)}" target="_blank" rel="noreferrer">View full changelog</a>
      <button class="btn-primary" id="releaseGotItBtn" type="button">Got it</button>
    </div>
  `;

  // Insert as the very first child of the main panel so the banner sits at
  // the top of every tab (doesn't compete with the non-Halo or SQL-gated
  // notices, which live just below).
  const firstNotice = document.getElementById('nonHaloNotice');
  if (firstNotice?.parentNode) {
    firstNotice.parentNode.insertBefore(banner, firstNotice);
  } else {
    document.body.appendChild(banner);
  }

  const dismiss = () => {
    chrome.storage.local.set({ [LAST_SEEN_VERSION_KEY]: version });
    banner.remove();
  };
  document.getElementById('releaseDismissBtn')?.addEventListener('click', dismiss);
  document.getElementById('releaseGotItBtn')?.addEventListener('click', dismiss);
}

function autoRefreshSchema() {
  refreshSchema().then(result => {
    if (!result) return;
    populateTablePicker();
    renderSchemaExplorer();
  }).catch(() => {});

  // Independent of the SQL-based schema refresh — FieldInfo may work where
  // /api/Report doesn't, and vice versa. Both populate the explorer.
  refreshFieldInfoCFs().then(payload => {
    if (!payload) return;
    populateTablePicker();
    renderSchemaExplorer();
  }).catch(() => {});

  // Harvest API field names from sample records — works for non-admins,
  // doesn't depend on /api/Report. This is what makes `workflow_id`,
  // `dateoccurred`, etc. (API canonical names) findable in the schema
  // explorer alongside their SQL counterparts.
  refreshApiFieldKeys().then(payload => {
    if (!payload) return;
    populateTablePicker();
    renderSchemaExplorer();
  }).catch(() => {});

  // Harvest list-grid column labels from saved views. Provides the
  // friendly "Last Updated"-style overrides that the sample-record path
  // can't surface (the sample only carries field names, no labels).
  refreshViewColumnLabels().then(payload => {
    if (!payload) return;
    populateTablePicker();
    renderSchemaExplorer();
  }).catch(() => {});
}

async function loadJSON(path) {
  const resp = await fetch(path);
  return resp.json();
}

// Same as loadJSON but returns a fallback on any failure (404, parse error,
// permission denied) instead of throwing. Use this in init() so a missing
// bundled resource can't crash the whole panel boot sequence.
async function safeLoadJSON(path, fallback) {
  try {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch (err) {
    console.warn('[HaloPlus] safeLoadJSON failed for', path, '— using fallback. Error:', err.message);
    return fallback;
  }
}

async function initTheme() {
  const data = await new Promise(resolve => chrome.storage.local.get([THEME_KEY], resolve));
  currentTheme = data?.[THEME_KEY] === 'dark' ? 'dark' : 'light';
  applyTheme(currentTheme);
}

function syncManifestVersion() {
  try {
    const version = chrome?.runtime?.getManifest?.()?.version;
    if (!version) return;
    const footer = document.getElementById('footerVersion');
    if (footer) {
      footer.textContent = `v${version}`;
      footer.addEventListener('click', () => {
        chrome.tabs.create({ url: RELEASES_URL });
      });
    }
  } catch (error) {
    // Ignore in non-extension contexts
  }
}

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = currentTheme;
  document.documentElement.style.colorScheme = currentTheme;
}

async function toggleTheme() {
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  await new Promise(resolve => chrome.storage.local.set({ [THEME_KEY]: nextTheme }, resolve));
  return nextTheme;
}

function switchToTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const content = document.getElementById(`tab-${tabName}`);
  if (content) content.classList.add('active');
  document.getElementById('headerSettingsBtn')?.classList.toggle('active', tabName === 'settings');
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchToTab(tab.dataset.tab);
      if (tab.dataset.tab !== 'sql-helper') {
        document.getElementById('sqlOutput').style.display = 'none';
      }
    });
  });

  document.querySelectorAll('.subtab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.helper-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`helper-${tab.dataset.helperTab}`).classList.add('active');
    });
  });
}

// Schema perspective. Three modes:
//   'both' — show everything as-is (default).
//   'sql'  — for report writers; show SQL columns, hide API-only fields,
//            API alias appears as a small `API: x` chip.
//   'api'  — for API integrators; show API field names as primary, hide
//            SQL-only columns, SQL column appears as a small `SQL: X` chip.
let schemaPerspective = 'both';

// Should the column be visible in the current perspective?
function columnVisibleInPerspective(col) {
  if (schemaPerspective === 'both') return true;
  if (schemaPerspective === 'sql') {
    // SQL view: hide API-only fields (no underlying SQL column to query).
    return col.type !== 'api';
  }
  if (schemaPerspective === 'api') {
    // API view: hide SQL columns that have no API equivalent.
    return col.api === true || col.type === 'api';
  }
  return true;
}

// Return what to display in each slot for the current perspective.
// In API mode we swap primary/alias so the API name reads first.
function getColumnDisplay(colName, col) {
  if (schemaPerspective === 'api' && col.apiAlias) {
    return {
      primary: col.apiAlias,
      alias: colName,                       // SQL column shown as the "see also" chip
      aliasLabel: 'SQL column name'
    };
  }
  return {
    primary: colName,
    alias: (col.apiAlias && col.apiAlias !== colName) ? col.apiAlias : '',
    aliasLabel: 'API field name'
  };
}

function columnMatchesFilter(colName, col, lowerFilter) {
  if (!lowerFilter) return true;
  if (colName.toLowerCase().includes(lowerFilter)) return true;
  if (col.label && col.label.toLowerCase().includes(lowerFilter)) return true;
  if (col.viewLabel && col.viewLabel.toLowerCase().includes(lowerFilter)) return true;
  if (col.apiAlias && col.apiAlias.toLowerCase().includes(lowerFilter)) return true;
  // CF-only fields exposed to search so "/$SYMPTOM" or "/$CFmobile" lands
  // on the right row directly.
  if (col.cfVariable && col.cfVariable.toLowerCase().includes(lowerFilter)) return true;
  if (col.cfHint && col.cfHint.toLowerCase().includes(lowerFilter)) return true;
  // Picklist option matching — "/in progress" finds status_id even though
  // the column name doesn't contain those words.
  if (Array.isArray(col.cfValues) && col.cfValues.some(v => (v.name || '').toLowerCase().includes(lowerFilter))) return true;
  // Tickettype binding matching — "/incident" finds CFs only used on
  // Incident-type tickets.
  if (Array.isArray(col.cfTickettypes) && col.cfTickettypes.some(t => (t.name || '').toLowerCase().includes(lowerFilter))) return true;
  return false;
}

function renderSchemaExplorer(filter = '') {
  const container = document.getElementById('schemaList');
  container.innerHTML = '';
  const lowerFilter = filter.toLowerCase();

  Object.entries(TABLES).forEach(([tableId, table]) => {
    // Perspective filter — apply first so we don't show table headers with
    // no visible columns when the user flips to SQL or API mode.
    const visibleCols = Object.entries(table.columns).filter(([, c]) => columnVisibleInPerspective(c));
    if (visibleCols.length === 0) return;

    const cols = visibleCols;
    const tableTextMatches = lowerFilter && (
      tableId.includes(lowerFilter) || table.label.toLowerCase().includes(lowerFilter)
    );
    const hasMatchingCol = cols.some(([cn, cd]) => columnMatchesFilter(cn, cd, lowerFilter));
    // Show table if nothing's filtering, the table itself text-matches, or
    // at least one of its columns matches the combined text + type filter.
    const tableMatches = !lowerFilter || tableTextMatches || hasMatchingCol;

    if (!tableMatches) return;

    const wrapper = el('div', { class: 'schema-table' });

    const header = el('div', { class: 'schema-table-header' });
    header.innerHTML = `
      <div>
        <span class="st-name">${escapeHtml(tableId)}</span>
        <span class="st-label">${escapeHtml(table.label)}</span>
      </div>
      <div class="st-actions">
        <button class="st-query-btn" type="button" title="Open this table in the Data Viewer">Query &rarr;</button>
        <span class="st-arrow">&#9654;</span>
      </div>
    `;
    header.addEventListener('click', () => wrapper.classList.toggle('open'));
    const queryBtn = header.querySelector('.st-query-btn');
    if (queryBtn) {
      queryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTableInDataViewer(tableId);
      });
    }

    const colsDiv = el('div', { class: 'schema-cols' });
    cols.forEach(([colName, col]) => {
      // Skip non-matching rows when there's an active text filter and the
      // table itself didn't text-match. Tables matched by name show all
      // their columns.
      if (lowerFilter && !tableId.includes(lowerFilter) && !table.label.toLowerCase().includes(lowerFilter)
          && !columnMatchesFilter(colName, col, lowerFilter)) return;

      const hasExpand = !!(col.cf && ((col.cfValues && col.cfValues.length) || (col.cfTickettypes && col.cfTickettypes.length)));

      const row = el('div', { class: 'schema-col' + (hasExpand ? ' has-expand' : '') });
      let badges = '';
      if (col.pk) badges += '<span class="sc-pk">PK</span> ';
      if (col.fk) {
        const fkTarget = String(col.fk).split('.')[0];
        const clickable = TABLES[fkTarget];
        const fkAttrs = clickable
          ? ` data-fk="${escapeHtml(col.fk)}" title="Jump to ${escapeHtml(col.fk)}"`
          : '';
        const fkClass = clickable ? 'sc-fk sc-fk-clickable' : 'sc-fk';
        badges += `<span class="${fkClass}"${fkAttrs}>FK -> ${escapeHtml(col.fk)}</span> `;
      }
      if (col.cf) {
        const tooltipBits = [];
        if (col.cfHint) tooltipBits.push(col.cfHint);
        if (col.cfVariable) tooltipBits.push(`Variable: ${col.cfVariable}`);
        if (col.cfTab) tooltipBits.push(`Tab: ${col.cfTab}`);
        if (col.cfGroup) tooltipBits.push(`Group: ${col.cfGroup}`);
        const tip = tooltipBits.join('\n');
        badges += `<span class="sc-cf"${tip ? ` title="${escapeHtml(tip)}"` : ''}>CF</span> `;
      }
      if (col.api) {
        badges += '<span class="sc-api" title="API field name (from /api/&lt;entity&gt; response). May map to a different SQL column.">API</span> ';
      }
      const expandArrow = hasExpand ? '<span class="sc-expand" aria-label="Expand">&#9654;</span> ' : '';
      // Primary name + alias chip depend on perspective. In API mode the
      // API name reads first; the SQL column appears as a `SQL: X` chip on
      // rows that have a curated mapping. Both/SQL modes show SQL column
      // first with the API alias as the chip.
      const disp = getColumnDisplay(colName, col);
      const aliasMarkup = disp.alias
        ? `<span class="sc-alias" title="${escapeHtml(disp.aliasLabel)}">${escapeHtml(disp.alias)}</span>`
        : '';
      // When ViewColumns gave us a list-grid label that differs from the
      // static schema's label, surface it as a small chip so the user sees
      // the tenant's tenant-customised header text.
      const viewLabelMarkup = (col.viewLabel && col.viewLabel !== col.label)
        ? `<span class="sc-view-label" title="List-grid label from a saved view (/api/ViewColumns)">${escapeHtml(col.viewLabel)}</span>`
        : '';
      row.innerHTML = `
        ${expandArrow}
        <span class="sc-name">${escapeHtml(disp.primary)}</span>
        ${aliasMarkup}
        <span class="sc-label">${escapeHtml(col.label)}</span>
        ${viewLabelMarkup}
        <span class="sc-type">${escapeHtml(col.type)}</span>
        ${badges}
      `;
      colsDiv.appendChild(row);

      if (hasExpand) {
        const detail = el('div', { class: 'schema-col-detail' });
        detail.innerHTML = renderCfDetail(col);
        colsDiv.appendChild(detail);

        const toggle = () => {
          const open = row.classList.toggle('open');
          detail.classList.toggle('open', open);
        };
        row.addEventListener('click', toggle);

        // Auto-expand when the filter matched something inside the detail
        // (a picklist value or tickettype name).
        if (lowerFilter && !colName.toLowerCase().includes(lowerFilter) && !col.label.toLowerCase().includes(lowerFilter)) {
          const inDetail =
            (col.cfValues || []).some(v => (v.name || '').toLowerCase().includes(lowerFilter)) ||
            (col.cfTickettypes || []).some(t => (t.name || '').toLowerCase().includes(lowerFilter));
          if (inDetail) {
            row.classList.add('open');
            detail.classList.add('open');
          }
        }
      }
    });

    wrapper.appendChild(header);
    wrapper.appendChild(colsDiv);
    container.appendChild(wrapper);

    // Auto-open if searching
    if (lowerFilter) wrapper.classList.add('open');
  });
}

function renderCfDetail(col) {
  const parts = [];
  const tickettypes = col.cfTickettypes || [];
  const values = col.cfValues || [];

  if (tickettypes.length) {
    const pills = tickettypes
      .map(t => `<span class="cf-pill cf-pill-tt">${escapeHtml(t.name)}</span>`)
      .join('');
    parts.push(`<div class="cf-section"><div class="cf-section-title">On ${tickettypes.length} ticket type${tickettypes.length === 1 ? '' : 's'}</div><div class="cf-pill-row">${pills}</div></div>`);
  }

  if (values.length) {
    const rows = values
      .map(v => {
        const idText = (v.id != null && v.id !== '') ? `<span class="cf-value-id">${escapeHtml(String(v.id))}</span>` : '';
        return `<div class="cf-value-row">${idText}<span class="cf-value-name">${escapeHtml(v.name)}</span></div>`;
      })
      .join('');
    const capNote = values.length === 100 ? '<div class="cf-cap-note">(first 100 shown)</div>' : '';
    parts.push(`<div class="cf-section"><div class="cf-section-title">${values.length} option${values.length === 1 ? '' : 's'}</div><div class="cf-value-list">${rows}</div>${capNote}</div>`);
  }

  return parts.join('');
}

let TABLE_PICKER_CUSTOM_TABLES = new Set();

function renderDataViewer() {
  populateTablePicker();
  renderSavedQueriesBar();

  if (!viewerState.tableId) {
    document.getElementById('recordHeader').innerHTML = `
      <div class="empty-state compact">
        <div class="es-text">Choose a table to build a record view</div>
      </div>
    `;
    document.getElementById('filterPanel').style.display = 'none';
    document.getElementById('recordTableWrap').innerHTML = '';
    const ribEl = document.getElementById('resultsInfoBar');
    if (ribEl) ribEl.style.display = 'none';
    const pg = document.getElementById('viewerPagination');
    if (pg) pg.style.display = 'none';
    return;
  }

  renderRecordViewer();
}

// ── Saved Data Viewer queries ───────────────────────────────────────────
// Persists per-user under chrome.storage.local. Each entry stores the
// table the user was on, the active filter rows, and the quick-filter
// text — enough to restore the exact view next time.
const SAVED_QUERIES_KEY = 'huSavedQueries';

async function loadSavedQueries() {
  return new Promise(resolve => {
    chrome.storage.local.get([SAVED_QUERIES_KEY], data => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      const list = Array.isArray(data && data[SAVED_QUERIES_KEY]) ? data[SAVED_QUERIES_KEY] : [];
      resolve(list);
    });
  });
}

async function persistSavedQueries(list) {
  await new Promise(r => chrome.storage.local.set({ [SAVED_QUERIES_KEY]: list }, r));
}

async function saveCurrentQuery() {
  const tableId = viewerState.tableId;
  if (!tableId) return;
  const quickFilter = (document.getElementById('viewerQuickFilter') || {}).value || '';
  // Default name suggests the table + filter count for a sensible starting point.
  const filterCount = (viewerState.filters || []).length;
  const defaultName = `${TABLES[tableId]?.label || tableId}${filterCount ? ' · ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's') : ''}`;
  const name = prompt('Save this query as:', defaultName);
  if (!name || !name.trim()) return;

  const list = await loadSavedQueries();
  list.push({
    id: 'sq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim().slice(0, 60),
    tableId,
    filters: JSON.parse(JSON.stringify(viewerState.filters || [])),
    quickFilter,
    columnView: viewerState.columnView || 'default',
    savedAt: new Date().toISOString()
  });
  // Sort by savedAt desc so newest appears first.
  list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  await persistSavedQueries(list);
  renderSavedQueriesBar();
}

async function loadQueryById(id) {
  const list = await loadSavedQueries();
  const entry = list.find(e => e.id === id);
  if (!entry || !TABLES[entry.tableId]) return;
  viewerState.tableId = entry.tableId;
  viewerState.filters = Array.isArray(entry.filters) ? JSON.parse(JSON.stringify(entry.filters)) : [];
  viewerState.lookupOptions = {};
  viewerState.lastRows = [];
  viewerState.currentPage = 1;
  viewerState.columnView = entry.columnView || 'default';
  viewerState.cachedProfiles = null;
  // Sync the picker label + quick filter input.
  const displayEl = document.getElementById('tablePickerValue');
  if (displayEl) {
    displayEl.textContent = entry.tableId;
    displayEl.classList.remove('placeholder');
  }
  const qf = document.getElementById('viewerQuickFilter');
  if (qf) qf.value = entry.quickFilter || '';
  const clearBtn = document.getElementById('clearTableBtn');
  if (clearBtn) clearBtn.style.display = entry.tableId ? '' : 'none';

  renderDataViewer();
  // Auto-run so the user sees results immediately.
  if (typeof buildViewerSQL === 'function') buildViewerSQL({ run: true });
}

async function deleteQueryById(id) {
  const list = await loadSavedQueries();
  const next = list.filter(e => e.id !== id);
  await persistSavedQueries(next);
  renderSavedQueriesBar();
}

async function renderSavedQueriesBar() {
  const wrap = document.getElementById('savedQueriesWrap');
  const listHost = document.getElementById('savedQueriesList');
  const saveBtn = document.getElementById('saveQueryBtn');
  const countEl = document.getElementById('sqCount');
  if (!wrap || !listHost) return;

  const list = await loadSavedQueries();

  // Show the control whenever we have either a table to save OR at least
  // one saved query. Hide entirely when neither is true so the toolbar
  // stays clean for first-time users.
  if (!list.length && !viewerState.tableId) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (saveBtn) saveBtn.disabled = !viewerState.tableId;
  if (countEl) countEl.textContent = list.length ? `(${list.length})` : '';

  listHost.innerHTML = '';
  if (!list.length) {
    const hint = document.createElement('div');
    hint.className = 'sq-empty';
    hint.textContent = 'No saved queries yet.';
    listHost.appendChild(hint);
    return;
  }

  list.forEach(entry => {
    const tableLabel = TABLES[entry.tableId]?.label || entry.tableId;
    const filterCount = Array.isArray(entry.filters) ? entry.filters.length : 0;
    const sub = `${tableLabel}${filterCount ? ' · ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's') : ''}`;
    const item = document.createElement('div');
    item.className = 'sq-item';
    item.innerHTML = `
      <button type="button" class="sq-item-load" title="Load this query">
        <span class="sq-item-name">${escapeHtml(entry.name)}</span>
        <span class="sq-item-sub">${escapeHtml(sub)}</span>
      </button>
      <button type="button" class="sq-item-del" title="Delete this query" aria-label="Delete">&times;</button>
    `;
    item.querySelector('.sq-item-load').addEventListener('click', () => {
      closeSavedMenu();
      loadQueryById(entry.id);
    });
    item.querySelector('.sq-item-del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete saved query "${entry.name}"?`)) deleteQueryById(entry.id);
    });
    listHost.appendChild(item);
  });
}

function openSavedMenu() {
  const menu = document.getElementById('sqMenu');
  const trigger = document.getElementById('sqTriggerBtn');
  if (!menu) return;
  menu.hidden = false;
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
}
function closeSavedMenu() {
  const menu = document.getElementById('sqMenu');
  const trigger = document.getElementById('sqTriggerBtn');
  if (!menu) return;
  menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}
function toggleSavedMenu() {
  const menu = document.getElementById('sqMenu');
  if (!menu) return;
  if (menu.hidden) openSavedMenu(); else closeSavedMenu();
}

function getTablePickerEntries(searchTerm, includeCustom) {
  const lower = searchTerm.toLowerCase();
  return Object.entries(TABLES)
    .filter(([tableId, table]) => {
      const isCustom = TABLE_PICKER_CUSTOM_TABLES.has(tableId);
      if (isCustom && !includeCustom) return false;
      if (!lower) return true;
      return tableId.includes(lower) || table.label.toLowerCase().includes(lower);
    })
    .sort(([aId, a], [bId, b]) => {
      const ac = TABLE_PICKER_CUSTOM_TABLES.has(aId) ? 1 : 0;
      const bc = TABLE_PICKER_CUSTOM_TABLES.has(bId) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return a.label.localeCompare(b.label);
    });
}

function populateTablePicker(searchTerm = '') {
  const list = document.getElementById('tablePickerList');
  if (!list) return;

  const includeCustom = document.getElementById('showCustomTables')?.checked ?? false;
  const entries = getTablePickerEntries(searchTerm, includeCustom);

  list.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'csd-empty';
    empty.textContent = searchTerm ? 'No tables match.' : 'No tables available.';
    list.appendChild(empty);
    return;
  }

  entries.slice(0, 80).forEach(([tableId, table]) => {
    const isCustom = TABLE_PICKER_CUSTOM_TABLES.has(tableId);
    const item = document.createElement('div');
    item.className = `csd-item${tableId === viewerState.tableId ? ' active' : ''}`;
    item.dataset.tableId = tableId;
    item.innerHTML = `
      <span class="csd-item-name">${escapeHtml(tableId)}</span>
      <span class="csd-item-label">${escapeHtml(table.label)}</span>
      ${isCustom ? '<span class="csd-item-badge">Custom</span>' : ''}
    `;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      selectViewerTable(tableId);
    });
    list.appendChild(item);
  });
}

function selectViewerTable(tableId) {
  viewerState.tableId = tableId;
  viewerState.filters = [];
  viewerState.lookupOptions = {};
  viewerState.lastRows = [];
  viewerState.currentPage = 1;
  viewerState.columnView = 'default';
  viewerState.cachedProfiles = null;
  document.getElementById('viewerQuickFilter').value = '';
  const ribEl = document.getElementById('resultsInfoBar');
  if (ribEl) ribEl.style.display = 'none';
  const rowsBox = document.getElementById('filterRowsBox');
  if (rowsBox) rowsBox.style.display = 'none';

  const displayEl = document.getElementById('tablePickerValue');
  const wrapEl    = document.getElementById('tablePickerWrap');
  const searchEl  = document.getElementById('viewerTableSearch');
  const clearBtn  = document.getElementById('clearTableBtn');
  if (displayEl) { displayEl.textContent = tableId; displayEl.classList.remove('placeholder'); }
  if (searchEl) searchEl.value = '';
  if (wrapEl) wrapEl.classList.remove('open');
  if (clearBtn) clearBtn.style.display = tableId ? '' : 'none';

  renderDataViewer();
}

function renderRecordViewer() {
  const tableId = viewerState.tableId;
  const table = TABLES[tableId];
  const columns = getViewerColumns(tableId);
  const pkColumns = Object.entries(table.columns).filter(([, col]) => col.pk).map(([name]) => name);
  const totalCols = sqlQueryableColumns(table).length;
  const view = viewerState.columnView || 'default';
  const profiles = Array.isArray(viewerState.cachedProfiles) ? viewerState.cachedProfiles : [];
  const supportsProfiles = !!TABLE_TO_VIEWCOLUMN_ENTITY[tableId];

  // Column view picker — replaces the old "Show all" toggle. Lists the
  // built-in views (Recommended top-N, All columns) and any Halo profiles
  // for this table's entity. Built-in options use distinct names so they
  // don't collide with Halo's own "Default Columns" profile.
  const buildPickerHtml = () => {
    const opts = [];
    opts.push('<optgroup label="HaloPlus">');
    opts.push(`<option value="default"${view === 'default' ? ' selected' : ''}>Recommended (top ${Math.min(VIEWER_DEFAULT_COLUMN_CAP, totalCols)})</option>`);
    if (totalCols > VIEWER_DEFAULT_COLUMN_CAP) {
      opts.push(`<option value="all"${view === 'all' ? ' selected' : ''}>All ${totalCols} columns</option>`);
    }
    opts.push('</optgroup>');
    if (profiles.length) {
      opts.push('<optgroup label="Halo column profiles">');
      profiles.forEach(p => {
        const val = 'profile:' + p.id;
        opts.push(`<option value="${escapeHtml(val)}"${view === val ? ' selected' : ''}>${escapeHtml(p.name)}</option>`);
      });
      opts.push('</optgroup>');
    } else if (supportsProfiles && viewerState.cachedProfiles === null) {
      opts.push('<optgroup label="Halo column profiles"><option value="" disabled>Loading…</option></optgroup>');
    }
    return `<select class="record-cols-select" id="recordColsSelect" title="Column view">${opts.join('')}</select>`;
  };

  document.getElementById('recordHeader').innerHTML = `
    <div>
      <div class="record-title-row">
        <span class="record-title">${escapeHtml(table.label)}</span>
        <button class="record-schema-link" type="button" id="recordViewSchemaBtn" title="Open this table in the Schema explorer">View schema &rarr;</button>
      </div>
      <div class="record-subtitle">${escapeHtml(tableId)}${table.description ? ` - ${escapeHtml(table.description)}` : ''}</div>
    </div>
    <div class="record-header-right">
      ${buildPickerHtml()}
      <div class="record-count">${columns.length} of ${totalCols}</div>
    </div>
  `;

  const colsSelect = document.getElementById('recordColsSelect');
  if (colsSelect) {
    colsSelect.addEventListener('change', () => {
      const hadResults = viewerState.lastRows && viewerState.lastRows.length;
      viewerState.columnView = colsSelect.value;
      // Verbose diagnostic — built in the panel, but forwarded to the
      // content script so it logs in the Halo page console (which the
      // user has open). The side panel's own console is hidden behind
      // chrome://extensions → Inspect views: panel.html, which is
      // awkward to find.
      try {
        if (colsSelect.value.startsWith('profile:')) {
          const id = colsSelect.value.slice(8);
          const p = (viewerState.cachedProfiles || []).find(x => String(x.id) === id);
          const tbl = TABLES[viewerState.tableId];
          const lines = [];
          lines.push('========== [HaloPlus] profile selection diagnostic ==========');
          lines.push('tableId: ' + viewerState.tableId);
          lines.push('profile picked: ' + (p ? p.name : '(NOT FOUND in cache)'));
          lines.push('profile id: ' + id);
          lines.push('cachedProfiles count: ' + (viewerState.cachedProfiles || []).length);
          if (p) {
            lines.push('profile columns:');
            p.columns.forEach(pc => {
              const r = resolveProfileColumnToSql(viewerState.tableId, pc.name);
              lines.push('  ' + pc.name + ' -> ' +
                (r ? (r.name + ' (' + (r.col.apiAlias === pc.name ? 'apiAlias' : 'direct/curated') + ')') : 'UNRESOLVED') +
                ' | label: ' + (pc.label || '(none)'));
            });
          }
          if (tbl) {
            const sqlCols = Object.entries(tbl.columns).filter(([, c]) => c.type !== 'api');
            const apiCols = Object.entries(tbl.columns).filter(([, c]) => c.type === 'api');
            lines.push('SQL columns: ' + sqlCols.length);
            lines.push('SQL sample: ' + JSON.stringify(sqlCols.slice(0, 20).map(([n, c]) => ({ sql: n, apiAlias: c.apiAlias || '' }))));
            lines.push('API-only rows: ' + apiCols.length + ' — ' + JSON.stringify(apiCols.slice(0, 30).map(([n]) => n)));
            lines.push('Curated API->SQL map: ' + JSON.stringify((typeof API_TO_SQL_NAME === 'object' && API_TO_SQL_NAME[viewerState.tableId]) || null));
          }
          lines.push('=============================================================');
          const text = lines.join('\n');
          // Send to content script so it logs to the Halo page console.
          try { chrome.runtime.sendMessage({ type: 'HU_PANEL_LOG', data: { text } }); } catch (_) {}
        }
      } catch (e) {
        try { chrome.runtime.sendMessage({ type: 'HU_PANEL_LOG', data: { text: '[HaloPlus] diagnostic threw: ' + (e && e.message || e) } }); } catch (_) {}
      }
      renderRecordViewer();
      if (hadResults) buildViewerSQL({ run: true });
    });
  }

  // Lazy-load Halo profiles on first render of a supported table.
  if (supportsProfiles && viewerState.cachedProfiles === null) {
    loadColumnProfilesForCurrentTable().then(list => {
      // Guard against the user having switched tables while the request
      // was in flight.
      if (viewerState.tableId !== tableId) return;
      viewerState.cachedProfiles = list;
      renderRecordViewer();
    });
  }
  const viewSchemaBtn = document.getElementById('recordViewSchemaBtn');
  if (viewSchemaBtn) {
    viewSchemaBtn.addEventListener('click', () => {
      switchToTab('sql-helper');
      // jumpToSchemaTarget already clears any active filter, opens the
      // table block, and scrolls it into view; passing no column means
      // no per-column flash, just the table-level focus.
      jumpToSchemaTarget(tableId);
    });
  }

  document.getElementById('filterPanel').style.display = '';
  const ribEl = document.getElementById('resultsInfoBar');
  if (ribEl) ribEl.style.display = 'none';
  renderViewerFilters();

  const tableEl = el('table', { class: 'record-table' });
  const thead = el('thead');
  const headRow = el('tr');
  columns.forEach(({ name, col, virtual }) => {
    const th = el('th');
    if (virtual) {
      th.classList.add('record-th-virtual');
      th.title = 'Computed display column in Halo — not available via SQL.';
      th.innerHTML = `
        <span class="rt-label">${escapeHtml(col.label)}</span>
        <span class="rt-name">computed</span>
      `;
    } else {
      th.innerHTML = `
        <span class="rt-label">${escapeHtml(col.label)}</span>
        <span class="rt-name">${escapeHtml(name)}${pkColumns.includes(name) ? ' PK' : ''}</span>
      `;
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = el('tbody');
  const placeholder = el('tr', { class: 'placeholder-row' });
  const td = el('td', { colspan: String(columns.length) });
  td.textContent = 'Generate and run the SQL to load live records from Halo.';
  placeholder.appendChild(td);
  tbody.appendChild(placeholder);

  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);

  const wrap = document.getElementById('recordTableWrap');
  wrap.innerHTML = '';
  wrap.appendChild(tableEl);

  buildViewerSQL();
}

// API-only rows (from the sample-record harvest or /api/ViewColumns) carry
// `type: 'api'` and don't correspond to real SQL columns. Every Data Viewer
// path that builds or filters SQL has to skip them — otherwise the
// generated query references non-existent columns like `id` or `summary`
// (which only exist on the API side) and Halo returns no rows.
function sqlQueryableColumns(table) {
  if (!table || !table.columns) return [];
  return Object.entries(table.columns).filter(([, col]) => col && col.type !== 'api');
}

// Cap how many columns we show by default. Some tables (faults) have 100+
// queryable columns and rendering all of them makes the table unreadable
// in the side panel's narrow column. The user can flip the
// `showAllColumns` toggle in the record header to see every column.
const VIEWER_DEFAULT_COLUMN_CAP = 8;

function getViewerColumns(tableId) {
  const table = TABLES[tableId];
  const entries = sqlQueryableColumns(table);
  const view = viewerState.columnView || 'default';

  if (view === 'all') {
    return entries.map(([name, col], index) => ({ name, col, index }));
  }

  // Halo profile selection: 'profile:<id>'. Map each profile column from
  // its API name to the actual SQL column we can SELECT. Columns that
  // can't be mapped (computed display fields Halo synthesises in its
  // UI: Flags, Viewing, SLA Time Left, Status Icon, etc.) are rendered
  // as virtual columns with empty cells so the profile's structure
  // still matches what the user sees in Halo's own list view.
  if (view.startsWith('profile:') && Array.isArray(viewerState.cachedProfiles)) {
    const profileId = view.slice('profile:'.length);
    const profile = viewerState.cachedProfiles.find(p => String(p.id) === profileId);
    if (profile && profile.columns.length) {
      const ordered = profile.columns.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const allOut = [];
      ordered.forEach((pc, i) => {
        const r = resolveProfileColumnToSql(tableId, pc.name);
        if (r) {
          allOut.push({ name: r.name, col: r.col, index: i });
        } else {
          // Virtual placeholder — not in SQL SELECT, but mirrors Halo's profile layout.
          allOut.push({
            name: pc.name,
            col: {
              type: 'computed',
              label: pc.label || pc.name,
              virtual: true
            },
            index: i,
            virtual: true
          });
        }
      });
      if (allOut.length) return allOut;
    }
  }

  // Default heuristic: pick the top-N most useful columns by score.
  const scored = entries.map(([name, col], index) => ({
    name,
    col,
    index,
    score: scoreViewerColumn(name, col)
  }));
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, VIEWER_DEFAULT_COLUMN_CAP)
    .sort((a, b) => a.index - b.index);
}

function scoreViewerColumn(name, col) {
  const haystack = `${name} ${col.label}`.toLowerCase();
  let score = 0;
  if (col.pk) score += 100;
  if (/(id|num|number)$/.test(name.toLowerCase())) score += 25;
  if (/(name|desc|title|summary|email|status|type|date|who|user|client|site)/.test(haystack)) score += 60;
  if (/(memo|note|body|resolution|clearance|description)/.test(haystack)) score -= 35;
  if (String(col.type).includes('ntext') || String(col.type).includes('4000')) score -= 45;
  return score;
}


// CF discovery via /api/FieldInfo (admin-gated, content-script proxies the call).
// Each entity's typeid maps to the SQL table where the CFs effectively appear
// in queries — Halo stores them either as columns on the main entity table or
// in a join table depending on `new_storage_method`, but the schema explorer
// shows them as if attached to the entity's main table.
const CF_ENTITY_TO_TABLE = {
  ticket:   'faults',
  user:     'users',
  customer: 'area',
  site:     'site',
  asset:    'device',
  supplier: 'company'
};

async function loadCachedFieldInfoCFs() {
  return new Promise(resolve => {
    chrome.storage.local.get(['huFieldInfoCFs'], data => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const payload = data.huFieldInfoCFs;
      if (payload && payload.byEntity) mergeFieldInfoCFs(payload.byEntity);
      resolve(payload || null);
    });
  });
}

async function refreshFieldInfoCFs() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'HU_GET_FIELDINFO' }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      const byEntity = response.data || {};
      const payload = { byEntity, fetchedAt: new Date().toISOString() };
      chrome.storage.local.set({ huFieldInfoCFs: payload });
      mergeFieldInfoCFs(byEntity);
      resolve(payload);
    });
  });
}

function mergeFieldInfoCFs(byEntity) {
  if (!byEntity || typeof byEntity !== 'object') return;
  Object.entries(byEntity).forEach(([entity, cfs]) => {
    const tableId = CF_ENTITY_TO_TABLE[entity];
    if (!tableId || !TABLES[tableId] || !Array.isArray(cfs)) return;
    cfs.forEach(cf => {
      if (!cf || !cf.name) return;
      // Standard column wins on collision — don't overwrite the canonical
      // definition with the CF version.
      if (TABLES[tableId].columns[cf.name]) return;
      TABLES[tableId].columns[cf.name] = {
        type: 'cf',
        label: cf.label || cf.name,
        cf: true,
        cfHint: cf.hint || '',
        cfVariable: cf.variable_name || '',
        cfTab: cf.tab_name || '',
        cfGroup: cf.groupname || '',
        cfValues: Array.isArray(cf.values) ? cf.values : [],
        cfTickettypes: Array.isArray(cf.tickettypes) ? cf.tickettypes : []
      };
    });
  });
}

// Curated API-name → SQL-column mapping. Halo's REST API translates many
// legacy SQL columns to friendlier names (`Symptom` → `summary`, `FFlowID`
// → `workflow_id`, etc.). There's no endpoint that exposes this mapping;
// it's compiled into Halo's frontend. We mirror the common ones here so the
// schema explorer merges the two naming worlds into a single row instead
// of showing them as duplicates.
//
// If a mapping turns out wrong, fix the entry here — failure mode is a
// dud cross-link, not a crash.
const API_TO_SQL_NAME = {
  faults: {
    'id': 'Faultid',
    'summary': 'Symptom',
    'details': 'Symptom2',
    'status_id': 'Status',
    'priority_id': 'Seriousness',
    'dateoccurred': 'DateOccured',
    'datecreated': 'DateCreated',
    'dateclosed': 'DateCleared',
    'datecleared': 'DateCleared',
    'fixbydate': 'FixByDate',
    'user_id': 'UserID',
    'user_name': 'Username',
    'client_id': 'Areaint',
    'site_id': 'SiteNumber',
    'agent_id': 'AssignedToInt',
    'team_id': 'Sectio_',
    'tickettype_id': 'RequestTypeNew',
    'category_1': 'Category2',
    'category_2': 'Category3',
    'category_3': 'Category4',
    'category_4': 'Category5',
    'workflow_id': 'FFlowID',
    'phonenumber': 'PhoneNumber',
    'sla_id': 'SLAID',
    'slastate': 'SLAState',
    'showforusers': 'ShowOnWeb',
    'supplier': 'Supplier'
  },
  users: {
    'id':           'uid',
    'name':         'UUsername',
    'firstname':    'Ufirstname',
    'surname':      'Usurname',
    'initials':     'Uinitials',
    'emailaddress': 'UEmail',
    'mobile':       'UMobile',
    'phonenumber':  'Uextn',
    'extn':         'Uextn',
    'site_id':      'Usite',
    'client_id':    'UArea',
    'jobtitle':     'UJobtitle',
    'login':        'ULogin',
    'notes':        'UNotes',
    'isinactive':   'UInactive',
    'inactive':     'UInactive',
    'other1':       'Uother1',
    'other2':       'Uother2',
    'other3':       'Uother3',
    'other4':       'Uother4',
    'other5':       'Uother5'
  }
};

// API-record harvest — fetches one sample record per entity via the content
// script and adds the response's top-level keys as columns in the schema
// explorer. Bridges the SQL/API naming gap: SQL might have `FFlowID` while
// the API exposes `workflow_id` — both end up findable.
const ENTITY_SAMPLE_TO_TABLE = {
  ticket:   'faults',
  user:     'users',
  customer: 'area',
  site:     'site',
  asset:    'device',
  supplier: 'company',
  agent:    'uname'
};

async function loadCachedApiFieldKeys() {
  return new Promise(resolve => {
    chrome.storage.local.get(['huApiFieldKeys'], data => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const payload = data.huApiFieldKeys;
      if (payload && payload.byEntity) mergeApiFieldKeys(payload.byEntity);
      resolve(payload || null);
    });
  });
}

async function refreshApiFieldKeys() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'HU_GET_ENTITY_SAMPLES' }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      const byEntity = response.data || {};
      // Don't overwrite cache with empty data — if every entity returned []
      // (e.g. transient auth failure), keep the previous good snapshot.
      const total = Object.values(byEntity).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
      if (total === 0) { resolve(null); return; }
      const payload = { byEntity, fetchedAt: new Date().toISOString() };
      chrome.storage.local.set({ huApiFieldKeys: payload });
      mergeApiFieldKeys(byEntity);
      resolve(payload);
    });
  });
}

function mergeApiFieldKeys(byEntity) {
  if (!byEntity || typeof byEntity !== 'object') return;
  Object.entries(byEntity).forEach(([entity, keys]) => {
    const tableId = ENTITY_SAMPLE_TO_TABLE[entity];
    if (!tableId || !TABLES[tableId] || !Array.isArray(keys)) return;
    const mapping = API_TO_SQL_NAME[tableId] || {};
    keys.forEach(key => {
      if (!key) return;
      // Same name on both sides — annotate, don't duplicate.
      if (TABLES[tableId].columns[key]) {
        if (!TABLES[tableId].columns[key].apiAlias) {
          TABLES[tableId].columns[key].apiAlias = key;
        }
        TABLES[tableId].columns[key].api = true;
        return;
      }
      // Curated mapping says this API name corresponds to an existing SQL
      // column — annotate the SQL column with the API alias.
      const sqlName = mapping[key];
      if (sqlName && TABLES[tableId].columns[sqlName]) {
        TABLES[tableId].columns[sqlName].apiAlias = key;
        TABLES[tableId].columns[sqlName].api = true;
        return;
      }
      // No mapping and no collision — this is an API-only field. Add it as
      // a new row with the API badge.
      TABLES[tableId].columns[key] = {
        type: 'api',
        label: key,
        api: true
      };
    });
  });
}

// ViewColumns harvest — fetches saved-view column metadata so the schema
// explorer can label API fields with their list-grid titles. Closes the
// long-standing gap where API field names like `last_update` showed up
// without their friendly "Last Updated" label.
async function loadCachedViewColumnLabels() {
  return new Promise(resolve => {
    chrome.storage.local.get(['huViewColumnLabels'], data => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const payload = data.huViewColumnLabels;
      if (payload && payload.byEntity) mergeViewColumnLabels(payload.byEntity);
      resolve(payload || null);
    });
  });
}

async function refreshViewColumnLabels() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'HU_GET_VIEW_COLUMNS' }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
        return;
      }
      const byEntity = response.data || {};
      // Don't overwrite cache with empty data (transient auth blip etc).
      const total = Object.values(byEntity).reduce((n, m) => n + (m && typeof m === 'object' ? Object.keys(m).length : 0), 0);
      if (total === 0) { resolve(null); return; }
      const payload = { byEntity, fetchedAt: new Date().toISOString() };
      chrome.storage.local.set({ huViewColumnLabels: payload });
      mergeViewColumnLabels(byEntity);
      resolve(payload);
    });
  });
}

function mergeViewColumnLabels(byEntity) {
  if (!byEntity || typeof byEntity !== 'object') return;
  Object.entries(byEntity).forEach(([entity, labels]) => {
    const tableId = ENTITY_SAMPLE_TO_TABLE[entity];
    if (!tableId || !TABLES[tableId] || !labels) return;
    const mapping = API_TO_SQL_NAME[tableId] || {};
    Object.entries(labels).forEach(([apiName, label]) => {
      const trimmed = (label || '').trim();
      // Existing column with the same key — annotate.
      if (TABLES[tableId].columns[apiName]) {
        const col = TABLES[tableId].columns[apiName];
        if (trimmed && !col.viewLabel) col.viewLabel = trimmed;
        if (!col.apiAlias) col.apiAlias = apiName;
        col.api = true;
        return;
      }
      // Curated mapping puts this API name on a SQL column.
      const sqlName = mapping[apiName];
      if (sqlName && TABLES[tableId].columns[sqlName]) {
        const col = TABLES[tableId].columns[sqlName];
        if (trimmed && !col.viewLabel) col.viewLabel = trimmed;
        col.apiAlias = apiName;
        col.api = true;
        return;
      }
      // Otherwise this is a renderable API field we didn't know about. Add.
      TABLES[tableId].columns[apiName] = {
        type: 'api',
        label: trimmed || apiName,
        viewLabel: trimmed || '',
        api: true,
        apiAlias: apiName
      };
    });
  });
}

function mergeCustomSchema(customTables, extraColumns) {
  Object.entries(customTables || {}).forEach(([tableId, def]) => {
    if (!TABLES[tableId]) {
      TABLES[tableId] = def;
      TABLE_PICKER_CUSTOM_TABLES.add(tableId);
    }
  });
  Object.entries(extraColumns || {}).forEach(([tableId, cols]) => {
    if (TABLES[tableId]) {
      Object.entries(cols).forEach(([col, def]) => {
        if (!TABLES[tableId].columns[col]) TABLES[tableId].columns[col] = def;
      });
    }
  });
}

async function loadCustomSchema() {
  return new Promise(resolve => {
    chrome.storage.local.get(['huCustomSchema'], data => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const schema = data.huCustomSchema;
      if (schema) mergeCustomSchema(schema.customTables, schema.extraColumns);
      resolve(schema || null);
    });
  });
}

async function refreshSchema() {
  const sql = `SELECT TOP 10000 TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION`;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'RUN_HALO_REPORT', data: { sql, name: 'HaloPlus schema discovery' } }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        reject(new Error(response?.error || chrome.runtime.lastError?.message || 'No Halo tab found'));
        return;
      }
      const rows = extractReportRows(response.data);
      const customTables = {};
      const extraColumns = {};

      rows.forEach(row => {
        const getVal = key => { const k = Object.keys(row).find(k2 => k2.toLowerCase() === key); return k ? String(row[k] ?? '') : ''; };
        const tableName = getVal('table_name').toLowerCase();
        const colName   = getVal('column_name');
        const dataType  = getVal('data_type') || 'nvarchar';
        if (!tableName || !colName) return;

        if (!TABLES[tableName]) {
          if (!customTables[tableName]) customTables[tableName] = { label: tableName, description: 'Custom table (discovered)', columns: {} };
          customTables[tableName].columns[colName] = { type: dataType, label: colName };
        } else if (!TABLES[tableName].columns[colName]) {
          if (!extraColumns[tableName]) extraColumns[tableName] = {};
          extraColumns[tableName][colName] = { type: dataType, label: colName };
        }
      });

      const extraColumnsCount = Object.values(extraColumns).reduce((n, c) => n + Object.keys(c).length, 0);
      const customTablesCount = Object.keys(customTables).length;

      // Empty-result safety net: if Halo's /api/Report restricts
      // INFORMATION_SCHEMA on this tenant (returns 0 rows), don't clobber
      // a previously-good cache with empty data. Only persist when there's
      // actual discovery.
      if (extraColumnsCount > 0 || customTablesCount > 0) {
        const payload = { customTables, extraColumns, lastRefreshed: new Date().toISOString() };
        chrome.storage.local.set({ huCustomSchema: payload });
        mergeCustomSchema(customTables, extraColumns);
      }

      resolve({
        customTablesCount,
        extraColumnsCount,
        totalRows: rows.length
      });
    });
  });
}

function setupViewerEvents() {
  const pickerWrap    = document.getElementById('tablePickerWrap');
  const triggerBtn    = document.getElementById('tablePickerTrigger');
  const searchEl      = document.getElementById('viewerTableSearch');
  const clearTableBtn = document.getElementById('clearTableBtn');
  const customToggle  = document.getElementById('showCustomTables');

  function openPicker() {
    pickerWrap.classList.add('open');
    searchEl.focus();
    populateTablePicker(searchEl.value.trim());
  }

  function closePicker() {
    pickerWrap.classList.remove('open');
  }

  triggerBtn.addEventListener('click', e => {
    e.stopPropagation();
    pickerWrap.classList.contains('open') ? closePicker() : openPicker();
  });

  searchEl.addEventListener('input', () => populateTablePicker(searchEl.value.trim()));
  searchEl.addEventListener('click', e => e.stopPropagation());

  customToggle.addEventListener('change', () => populateTablePicker(searchEl.value.trim()));

  clearTableBtn.addEventListener('click', e => {
    e.stopPropagation();
    viewerState.tableId = '';
    viewerState.filters = [];
    viewerState.lookupOptions = {};
    viewerState.lastRows = [];
    viewerState.currentPage = 1;
    const displayEl = document.getElementById('tablePickerValue');
    if (displayEl) { displayEl.textContent = 'Select a table...'; displayEl.classList.add('placeholder'); }
    clearTableBtn.style.display = 'none';
    searchEl.value = '';
    closePicker();
    const pg = document.getElementById('viewerPagination');
    if (pg) pg.style.display = 'none';
    const rib = document.getElementById('resultsInfoBar');
    if (rib) rib.style.display = 'none';
    renderDataViewer();
  });

  const saveBtn = document.getElementById('saveQueryBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    closeSavedMenu();
    saveCurrentQuery();
  });
  const sqTrigger = document.getElementById('sqTriggerBtn');
  if (sqTrigger) sqTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSavedMenu();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#tablePickerWrap')) closePicker();
    if (!e.target.closest('#exportWrap')) {
      const ew = document.getElementById('exportWrap');
      if (ew) ew.classList.remove('open');
    }
  });
  // Saved-menu outside-click — uses `mousedown` so it fires before any
  // sibling `click` handler can stopPropagation (the table picker trigger
  // and clear button both stop propagation on click, which would
  // otherwise prevent the saved menu from closing when the user clicks
  // them).
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('.viewer-saved-section')) closeSavedMenu();
  });

  document.getElementById('addViewerFilterBtn').addEventListener('click', () => {
    if (!viewerState.tableId) return;
    const firstColumn = sqlQueryableColumns(TABLES[viewerState.tableId])[0]?.[0];
    if (!firstColumn) return;
    viewerState.filters.push({ connector: 'AND', column: firstColumn, operator: '=', value: '' });
    renderViewerFilters();
  });

  document.getElementById('viewerQuickFilter').addEventListener('input', () => {
    if (viewerState.tableId) buildViewerSQL();
  });

  document.getElementById('runViewerBtn').addEventListener('click', () => buildViewerSQL({ run: true }));

  document.getElementById('pagePrevBtn').addEventListener('click', () => {
    if (viewerState.currentPage > 1) { viewerState.currentPage--; displayPagedRows(); }
  });
  document.getElementById('pageNextBtn').addEventListener('click', () => {
    const totalPages = Math.ceil(viewerState.lastRows.length / viewerState.pageSize);
    if (viewerState.currentPage < totalPages) { viewerState.currentPage++; displayPagedRows(); }
  });
  document.getElementById('pageSizeSelect').addEventListener('change', e => {
    viewerState.pageSize = parseInt(e.target.value, 10);
    viewerState.currentPage = 1;
    displayPagedRows();
  });

  const exportTrigger = document.getElementById('exportTriggerBtn');
  const exportWrapEl  = document.getElementById('exportWrap');
  if (exportTrigger && exportWrapEl) {
    exportTrigger.addEventListener('click', e => {
      e.stopPropagation();
      exportWrapEl.classList.toggle('open');
    });
  }
  document.getElementById('exportCsvBtn').addEventListener('click', () => { exportRows('csv'); exportWrapEl?.classList.remove('open'); });
  document.getElementById('exportXlsxBtn').addEventListener('click', () => { exportRows('xlsx'); exportWrapEl?.classList.remove('open'); });
  document.getElementById('exportJsonBtn').addEventListener('click', () => { exportRows('json'); exportWrapEl?.classList.remove('open'); });
}

function setupUtilityEvents() {
  setupThemeToggle();
  setupHeaderSettingsButton();
  bindUtilityButton('openPaletteBtn', 'HU_OPEN_PALETTE');
  bindUtilityButton('showRecentBtn', 'HU_SHOW_RECENT');
  bindUtilityButton('openJsonBtn', 'HU_OPEN_JSON');
  bindUtilityButton('openTicket360Btn', 'HU_OPEN_TICKET360');
  bindUtilityButton('openTimelineBtn', 'HU_OPEN_TIMELINE');
  setupFieldToggleButton();
  setupCommandsSection();
  setupPreferences();
  setupCustomDomainSettings();
}

function setupThemeToggle() {
  const btn = document.getElementById('headerThemeBtn');
  if (!btn) return;

  const updateBtn = (theme) => {
    const isDark = theme === 'dark';
    btn.dataset.theme = isDark ? 'dark' : 'light';
    btn.dataset.active = isDark ? '1' : '';
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  };

  updateBtn(currentTheme);

  btn.addEventListener('click', async () => {
    const status = document.getElementById('utilityStatus');
    if (status) status.textContent = 'Updating theme...';
    try {
      const nextTheme = await toggleTheme();
      updateBtn(nextTheme);
      if (status) status.textContent = nextTheme === 'dark' ? 'Dark mode enabled.' : 'Light mode enabled.';
    } catch (e) {
      if (status) status.textContent = 'Could not update the theme preference.';
    }
  });
}

function setupHeaderSettingsButton() {
  const btn = document.getElementById('headerSettingsBtn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    switchToTab('settings');
    document.getElementById('sqlOutput').style.display = 'none';
  });
}

function setupFieldToggleButton() {
  const btn = document.getElementById('toggleFieldsBtn');
  const status = document.getElementById('utilityStatus');

  function updateBtn(on) {
    const title = btn.querySelector('.utility-title');
    const copy = btn.querySelector('.utility-copy');
    if (title) title.textContent = on ? 'Field API names: ON' : 'Field API names';
    if (copy) copy.textContent = on ? 'Click or double-click page to hide.' : 'Toggle internal field names on form labels.';
    btn.dataset.fieldsOn = on ? '1' : '';
  }

  btn.addEventListener('click', () => {
    status.textContent = 'Sending command...';
    try {
      chrome.runtime.sendMessage({ type: 'HU_TOGGLE_FIELDS' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          status.textContent = chrome.runtime.lastError?.message || 'Open and refresh a Halo tab first.';
          return;
        }
        updateBtn(response.on);
        status.textContent = response.on ? 'Field names visible.' : 'Field names hidden.';
      });
    } catch (e) {
      status.textContent = 'Open Halo in Chrome, then try again.';
    }
  });
}

function bindUtilityButton(id, type, data = {}) {
  document.getElementById(id).addEventListener('click', () => {
    const status = document.getElementById('utilityStatus');
    status.textContent = 'Sending command to active Halo tab...';
    try {
      chrome.runtime.sendMessage({ type, data }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          status.textContent = response?.error || chrome.runtime.lastError?.message || 'Open and refresh a Halo tab first.';
          return;
        }
        status.textContent = 'Command sent.';
      });
    } catch (e) {
      status.textContent = 'Open Halo in Chrome, then try again.';
    }
  });
}

function renderViewerFilters() {
  const container = document.getElementById('viewerFilters');
  container.innerHTML = '';
  const rowsBox = document.getElementById('filterRowsBox');
  if (rowsBox) rowsBox.style.display = viewerState.filters.length > 0 ? '' : 'none';

  viewerState.filters.forEach((filter, index) => {
    const row = el('div', { class: 'sn-filter-row' });

    // AND/OR connector \u2014 hidden (visibility:hidden) on first row to preserve grid alignment
    const connectorSelect = el('select', { class: 'sn-connector' });
    ['AND', 'OR'].forEach(c => connectorSelect.appendChild(el('option', { value: c }, c)));
    connectorSelect.value = filter.connector || 'AND';
    if (index === 0) connectorSelect.style.visibility = 'hidden';

    const columnSelect = el('select', { class: 'sn-field' });
    sqlQueryableColumns(TABLES[viewerState.tableId]).forEach(([name, col]) => {
      const opt = el('option', { value: name }, `${col.label} (${name})`);
      if (name === filter.column) opt.selected = true;
      columnSelect.appendChild(opt);
    });

    const opSelect = el('select', { class: 'sn-op' });
    ['=', '!=', '>', '<', '>=', '<=', 'contains', 'starts with', 'is empty', 'is not empty'].forEach(op => {
      const opt = el('option', { value: op }, op);
      if (op === filter.operator) opt.selected = true;
      opSelect.appendChild(opt);
    });

    const lookupMeta = getLookupMeta(viewerState.tableId, filter.column);
    let valControl;
    if (lookupMeta) {
      valControl = el('select', { class: 'sn-value' });
      valControl.appendChild(el('option', { value: '' }, 'Loading\u2026'));
      valControl.style.display = operatorNeedsValue(filter.operator) ? '' : 'none';
      hydrateLookupSelect(lookupMeta, valControl, filter.value);
    } else {
      valControl = el('input', { type: 'text', class: 'sn-value', placeholder: 'Value' });
      valControl.value = filter.value || '';
      valControl.style.display = operatorNeedsValue(filter.operator) ? '' : 'none';
    }

    const removeBtn = el('button', { class: 'sn-remove', title: 'Remove' }, '\u00d7');

    const update = () => {
      viewerState.filters[index] = {
        connector: connectorSelect.value,
        column: columnSelect.value,
        operator: opSelect.value,
        value: valControl.value || ''
      };
      valControl.style.display = operatorNeedsValue(opSelect.value) ? '' : 'none';
    };

    connectorSelect.addEventListener('change', update);
    columnSelect.addEventListener('change', () => { update(); renderViewerFilters(); });
    opSelect.addEventListener('change', () => { update(); buildViewerSQL(); });
    if (lookupMeta) {
      valControl.addEventListener('change', () => { update(); buildViewerSQL(); });
    } else {
      valControl.addEventListener('input', update);
    }
    removeBtn.addEventListener('click', () => {
      viewerState.filters.splice(index, 1);
      renderViewerFilters();
      buildViewerSQL();
    });

    row.appendChild(connectorSelect);
    row.appendChild(columnSelect);
    row.appendChild(opSelect);
    row.appendChild(valControl);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function hydrateLookupSelect(meta, selectEl, currentValue) {
  const cacheKey = `${meta.table}.${meta.keyColumn}.${meta.labelColumn}`;
  const cached = viewerState.lookupOptions[cacheKey];
  if (cached) {
    renderSelectOptions(selectEl, cached, currentValue);
    return;
  }

  const baseAlias = 'B';
  const lookupAlias = 'L';
  const sql = `
SELECT TOP 200
  ${baseAlias}.${meta.baseColumn} AS [value],
  ${lookupAlias}.${meta.labelColumn} AS [label],
  COUNT(*) AS [usage_count]
FROM
  ${meta.baseTable} ${baseAlias}
  LEFT JOIN ${meta.table} ${lookupAlias} ON ${baseAlias}.${meta.baseColumn} = ${lookupAlias}.${meta.keyColumn}
WHERE
  ${baseAlias}.${meta.baseColumn} IS NOT NULL
  AND ${lookupAlias}.${meta.labelColumn} IS NOT NULL
GROUP BY
  ${baseAlias}.${meta.baseColumn},
  ${lookupAlias}.${meta.labelColumn}
ORDER BY
  ${lookupAlias}.${meta.labelColumn} ASC,
  COUNT(*) DESC
`.trim();

  chrome.runtime.sendMessage({
    type: 'RUN_HALO_REPORT',
    data: { sql, name: `HaloPlus ${meta.table} lookup` }
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      selectEl.innerHTML = '';
      selectEl.appendChild(el('option', { value: '' }, '\u2014 any \u2014'));
      return;
    }
    const rows = normalizeLookupRows(extractReportRows(response.data)
      .map(row => ({ value: row.value, label: row.label, usageCount: Number(row.usage_count) || 0 }))
      .filter(row => row.value !== undefined && row.label !== undefined));
    viewerState.lookupOptions[cacheKey] = rows;
    renderSelectOptions(selectEl, rows, currentValue);
  });
}

function renderSelectOptions(selectEl, rows, currentValue) {
  selectEl.innerHTML = '';
  selectEl.appendChild(el('option', { value: '' }, '\u2014 any \u2014'));
  rows.forEach(row => {
    selectEl.appendChild(el('option', { value: String(row.value) }, row.label));
  });
  if (currentValue !== undefined && currentValue !== '') {
    selectEl.value = String(currentValue);
  }
}

function getLookupMeta(tableId, columnName) {
  const fk = TABLES[tableId]?.columns?.[columnName]?.fk;
  if (!fk || !fk.includes('.')) return null;

  const [lookupTable, keyColumn] = fk.split('.');
  const lookupDef = TABLES[lookupTable];
  if (!lookupDef) return null;

  const labelColumn = LOOKUP_LABEL_COLUMNS[lookupTable] ||
    Object.entries(lookupDef.columns).find(([name, col]) => {
      const haystack = `${name} ${col.label}`.toLowerCase();
      return /(name|desc|title|email|summary)/.test(haystack) && name !== keyColumn;
    })?.[0];

  if (!labelColumn || !lookupDef.columns[labelColumn]) return null;
  return { table: lookupTable, keyColumn, labelColumn, baseTable: tableId, baseColumn: columnName };
}

function hydrateLookupDatalist(meta, datalist) {
  const cacheKey = `${meta.table}.${meta.keyColumn}.${meta.labelColumn}`;
  const cached = viewerState.lookupOptions[cacheKey];
  if (cached) {
    renderLookupOptions(datalist, cached);
    return;
  }

  const baseAlias = 'B';
  const lookupAlias = 'L';
  const sql = `
SELECT TOP 200
  ${baseAlias}.${meta.baseColumn} AS [value],
  ${lookupAlias}.${meta.labelColumn} AS [label],
  COUNT(*) AS [usage_count]
FROM
  ${meta.baseTable} ${baseAlias}
  LEFT JOIN ${meta.table} ${lookupAlias} ON ${baseAlias}.${meta.baseColumn} = ${lookupAlias}.${meta.keyColumn}
WHERE
  ${baseAlias}.${meta.baseColumn} IS NOT NULL
  AND ${lookupAlias}.${meta.labelColumn} IS NOT NULL
GROUP BY
  ${baseAlias}.${meta.baseColumn},
  ${lookupAlias}.${meta.labelColumn}
ORDER BY
  ${lookupAlias}.${meta.labelColumn} ASC,
  COUNT(*) DESC
`.trim();

  chrome.runtime.sendMessage({
    type: 'RUN_HALO_REPORT',
    data: { sql, name: `HaloPlus ${meta.table} lookup` }
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    const rows = normalizeLookupRows(extractReportRows(response.data)
      .map(row => ({
        value: row.value,
        label: row.label,
        usageCount: Number(row.usage_count) || 0
      }))
      .filter(row => row.value !== undefined && row.label !== undefined));
    viewerState.lookupOptions[cacheKey] = rows;
    renderLookupOptions(datalist, rows);
  });
}

function normalizeLookupRows(rows) {
  const exact = new Map();
  rows.forEach(row => {
    const key = `${String(row.label).toLowerCase()}|${String(row.value).toLowerCase()}`;
    const existing = exact.get(key);
    if (!existing || row.usageCount > existing.usageCount) exact.set(key, row);
  });

  const deduped = [...exact.values()];
  const labelCounts = deduped.reduce((acc, row) => {
    const key = String(row.label).toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return deduped.map(row => ({
    ...row,
    duplicateLabel: labelCounts[String(row.label).toLowerCase()] > 1
  }));
}

function renderLookupOptions(datalist, rows) {
  datalist.innerHTML = '';
  rows.forEach(row => {
    const value = row.duplicateLabel
      ? `${row.label} [ID ${row.value}]`
      : `${row.label} (${row.value})`;
    const label = row.usageCount
      ? `${row.usageCount} matching records`
      : String(row.value);
    datalist.appendChild(el('option', {
      value,
      label
    }));
  });
}

function buildViewerSQL(options = {}) {
  if (!viewerState.tableId) return '';

  const tableId = viewerState.tableId;
  const table = TABLES[tableId];
  const alias = table.alias || tableId;
  const columns = getViewerColumns(tableId);
  // Virtual columns (Halo's computed display fields) aren't selectable;
  // strip them before building the SELECT list.
  const sqlColumns = columns.filter(c => !c.virtual && c.col && c.col.type !== 'computed');
  const parts = ['SELECT TOP 10000'];

  parts.push(sqlColumns.map(({ name, col }, index) => {
    const comma = index < sqlColumns.length - 1 ? ',' : '';
    let expr = `${alias}.${name}`;
    if (String(col.type).includes('ntext')) {
      expr = `CONVERT(nvarchar(max), ${expr})`;
    }
    return `  ${expr} AS [${col.label}]${comma}`;
  }).join('\n'));

  parts.push('FROM');
  parts.push(`  ${tableId} ${alias}`);

  const where = buildViewerWhere(alias, table);
  if (where.length) {
    parts.push('WHERE');
    where.forEach(({ connector, clause }) => {
      parts.push(`  ${connector ? connector + ' ' : ''}${clause}`);
    });
  }

  const defaultOrder = getDefaultOrderColumn(table);
  if (defaultOrder) {
    parts.push('ORDER BY');
    parts.push(`  ${alias}.${defaultOrder} DESC`);
  }

  const sql = parts.join('\n');
  viewerState.lastSql = sql;

  const sqlBtn = document.getElementById('viewerSqlBtn');
  if (sqlBtn) {
    sqlBtn.textContent = 'Copy SQL';
    sqlBtn.classList.remove('copied');
    sqlBtn.onclick = () => {
      navigator.clipboard.writeText(sql).then(() => {
        sqlBtn.textContent = 'Copied!';
        sqlBtn.classList.add('copied');
        setTimeout(() => {
          sqlBtn.textContent = 'Copy SQL';
          sqlBtn.classList.remove('copied');
        }, 2000);
      });
    };
  }

  if (options.run) runHaloReport(sql);
  return sql;
}

function buildViewerWhere(alias, table) {
  const parts = [];

  viewerState.filters.forEach((filter, index) => {
    const col = table.columns[filter.column];
    if (!col) return;
    const clause = formatViewerFilter(`${alias}.${filter.column}`, filter.operator, filter.value, col.type, filter);
    if (!clause) return;
    parts.push({ connector: index === 0 || parts.length === 0 ? null : (filter.connector || 'AND'), clause });
  });

  const quickFilter = document.getElementById('viewerQuickFilter')?.value.trim();
  if (quickFilter) {
    const textCols = sqlQueryableColumns(table)
      .filter(([, col]) => /(char|text|varchar)/i.test(col.type))
      .slice(0, 6)
      .map(([name]) => `${alias}.${name} LIKE '%${escapeSql(quickFilter)}%'`);
    if (textCols.length) {
      parts.push({ connector: parts.length > 0 ? 'AND' : null, clause: `(${textCols.join(' OR ')})` });
    }
  }

  return parts;
}

function formatViewerFilter(columnRef, operator, value, type, filter = null) {
  if (operator === 'is empty') return `(${columnRef} IS NULL OR ${columnRef} = '')`;
  if (operator === 'is not empty') return `(${columnRef} IS NOT NULL AND ${columnRef} <> '')`;
  if (!value.trim()) return '';
  if (operator === 'contains') return `${columnRef} LIKE '%${escapeSql(value)}%'`;
  if (operator === 'starts with') return `${columnRef} LIKE '${escapeSql(value)}%'`;

  const resolvedValue = resolveFilterValue(filter, value);
  const sqlValue = isNumericType(type) && !Number.isNaN(Number(resolvedValue))
    ? resolvedValue
    : `'${escapeSql(resolvedValue)}'`;
  return `${columnRef} ${operator} ${sqlValue}`;
}

function resolveFilterValue(filter, value) {
  if (!filter) return value;

  const duplicateId = String(value).match(/\[ID\s+([^\]]+)\]\s*$/i);
  if (duplicateId) return duplicateId[1];

  const parenthesized = String(value).match(/\(([^()]+)\)\s*$/);
  if (parenthesized) return parenthesized[1];

  const lookupMeta = getLookupMeta(viewerState.tableId, filter.column);
  if (!lookupMeta) return value;

  const cacheKey = `${lookupMeta.table}.${lookupMeta.keyColumn}.${lookupMeta.labelColumn}`;
  const options = viewerState.lookupOptions[cacheKey] || [];
  const lower = String(value).trim().toLowerCase();
  const match = options.find(option =>
    String(option.label).toLowerCase() === lower ||
    String(option.value).toLowerCase() === lower
  );
  return match ? match.value : value;
}

function operatorNeedsValue(operator) {
  return operator !== 'is empty' && operator !== 'is not empty';
}

function isNumericType(type) {
  return /(int|float|decimal|numeric|money|bit|bool)/i.test(type);
}

function getDefaultOrderColumn(table) {
  const entries = sqlQueryableColumns(table);
  const dateCol = entries.find(([name, col]) => /date|time|whe_|occured|created/i.test(`${name} ${col.label}`));
  if (dateCol) return dateCol[0];
  const pkCol = entries.find(([, col]) => col.pk);
  return pkCol ? pkCol[0] : entries[0]?.[0];
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

const VAR_LABELS = {
  '$ticketid': { label: 'Ticket ID', hint: 'e.g. 2996' },
  '$agentid':  { label: 'Agent ID',  hint: 'e.g. 3' },
  '$userid':   { label: 'User ID',   hint: 'e.g. 12' },
  '$siteid':   { label: 'Site ID',   hint: 'e.g. 5' },
  '$clientid': { label: 'Client ID', hint: 'e.g. 8' },
  '$invoiceid':{ label: 'Invoice ID',hint: 'e.g. 101' }
};

function showSQL(sql, tablesUsed = [], variablesUsed = []) {
  const output = document.getElementById('sqlOutput');
  const code = document.getElementById('sqlCode');
  const meta = document.getElementById('sqlMeta');
  const varInputs = document.getElementById('varInputs');
  const copyBtn = document.getElementById('copyBtn');
  const runBtn = document.getElementById('runReportBtn');

  code.textContent = sql;
  output.style.display = '';

  // Detect variables actually present in the SQL (not just declared in template)
  const presentVars = Object.keys(VAR_LABELS).filter(v => sql.includes(v));

  if (presentVars.length) {
    varInputs.style.display = '';
    varInputs.innerHTML = '<div class="var-inputs-label">Fill in values to run this query:</div>';
    presentVars.forEach(varName => {
      const { label, hint } = VAR_LABELS[varName];
      const row = el('div', { class: 'var-input-row' });
      const lbl = el('label', { class: 'var-input-label' }, label);
      const input = el('input', { type: 'text', class: 'var-input-field', placeholder: hint, 'data-var': varName });
      input.addEventListener('input', () => {
        code.textContent = resolveVars(sql, varInputs);
      });
      row.appendChild(lbl);
      row.appendChild(input);
      varInputs.appendChild(row);
    });

    // Try to pre-fill from the active page context
    try {
      chrome.runtime.sendMessage({ type: 'HU_GET_CONTEXT' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) return;
        const vars = response.data?.vars || {};
        varInputs.querySelectorAll('.var-input-field').forEach(input => {
          const val = vars[input.dataset.var];
          if (val && !input.value) {
            input.value = val;
            input.classList.add('var-input-prefilled');
          }
        });
        code.textContent = resolveVars(sql, varInputs);
      });
    } catch (e) { /* not on a Halo tab */ }
  } else {
    varInputs.style.display = 'none';
    varInputs.innerHTML = '';
  }

  let metaHtml = '';
  if (tablesUsed.length) metaHtml += 'Tables: ' + tablesUsed.map(t => `<span class="meta-tag">${escapeHtml(t)}</span>`).join('');
  if (variablesUsed.length) metaHtml += (metaHtml ? ' - ' : '') + 'Variables: ' + variablesUsed.map(v => `<span class="meta-tag">${escapeHtml(v)}</span>`).join('');
  meta.innerHTML = metaHtml;

  copyBtn.textContent = 'Copy';
  copyBtn.classList.remove('copied');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(resolveVars(sql, varInputs)).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
    });
  };

  runBtn.textContent = 'Run';
  runBtn.classList.remove('copied');
  runBtn.onclick = () => {
    const resolved = resolveVars(sql, varInputs);
    const remaining = Object.keys(VAR_LABELS).filter(v => resolved.includes(v));
    if (remaining.length) {
      varInputs.querySelectorAll('.var-input-field').forEach(input => {
        if (!input.value.trim()) input.classList.add('var-input-error');
      });
      return;
    }
    runHaloReport(resolved);
  };

  output.scrollIntoView({ behavior: 'smooth' });
}

function resolveVars(sql, varInputsEl) {
  let resolved = sql;
  if (varInputsEl) {
    varInputsEl.querySelectorAll('.var-input-field').forEach(input => {
      const val = input.value.trim();
      if (val) {
        input.classList.remove('var-input-error');
        resolved = resolved.split(input.dataset.var).join(val);
      }
    });
  }
  return resolved;
}

function runHaloReport(sql) {
  const sqlRunBtn    = document.getElementById('runReportBtn');
  const viewerRunBtn = document.getElementById('runViewerBtn');
  if (!sql) return;

  if (sqlRunBtn) { sqlRunBtn.textContent = 'Running...'; sqlRunBtn.disabled = true; }
  if (viewerRunBtn) { viewerRunBtn.textContent = '...'; viewerRunBtn.disabled = true; }

  try {
    chrome.runtime.sendMessage({
      type: 'RUN_HALO_REPORT',
      data: {
        sql,
        name: `HaloPlus ${viewerState.tableId || 'SQL'}`
      }
    }, (response) => {
      if (sqlRunBtn) sqlRunBtn.disabled = false;
      if (viewerRunBtn) { viewerRunBtn.textContent = 'Run'; viewerRunBtn.disabled = false; }

      if (chrome.runtime.lastError) {
        showViewerError(chrome.runtime.lastError.message);
        if (sqlRunBtn) sqlRunBtn.textContent = 'Run';
        return;
      }

      if (!response?.ok) {
        showViewerError(response?.error || 'Halo did not return report data.');
        if (sqlRunBtn) sqlRunBtn.textContent = 'Run';
        return;
      }

      const rows = extractReportRows(response.data);
      renderRecordRows(rows, response.data);
      showQueryResultHeader(rows.length);
      if (sqlRunBtn) {
        sqlRunBtn.textContent = 'Loaded';
        sqlRunBtn.classList.add('copied');
        setTimeout(() => { sqlRunBtn.textContent = 'Run'; sqlRunBtn.classList.remove('copied'); }, 1800);
      }
      document.getElementById('sqlOutput').style.display = 'none';
      switchToTab('data-viewer');
      document.getElementById('recordTableWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (e) {
    if (sqlRunBtn) { sqlRunBtn.disabled = false; sqlRunBtn.textContent = 'Run'; }
    if (viewerRunBtn) { viewerRunBtn.disabled = false; viewerRunBtn.textContent = 'Run'; }
    showViewerError('Open Halo in the active tab, then run the report again.');
  }
}

function extractReportRows(payload) {
  if (!payload) return [];

  // Flat array of rows returned directly
  if (Array.isArray(payload) && looksLikeRows(payload, '')) return payload;

  // Array-wrapped report object: [{rows: [...]}, ...]
  if (Array.isArray(payload) && payload.length && typeof payload[0] === 'object') {
    const directKeys = ['rows', 'data', 'result', 'results', 'reportdata', 'report_data'];
    for (const key of directKeys) {
      if (Array.isArray(payload[0][key]) && looksLikeRows(payload[0][key], key)) return payload[0][key];
    }
  }

  const directKeys = ['rows', 'data', 'result', 'results', 'reportdata', 'report_data'];
  for (const key of directKeys) {
    if (Array.isArray(payload[key]) && looksLikeRows(payload[key], key)) return payload[key];
  }

  let best = { rows: [], score: 0 };
  const visit = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      const score = scoreReportRows(value, path);
      if (score > best.score) best = { rows: value, score };
      value.slice(0, 20).forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    Object.entries(value).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
  };
  visit(payload);
  return best.rows;
}

function looksLikeRows(value, path = '') {
  if (!Array.isArray(value) || !value.length || typeof value[0] !== 'object') return false;
  if (isMetadataPath(path)) return false;
  const keys = Object.keys(value[0]);
  if (!keys.length) return false;
  return !isMetadataRow(keys);
}

function scoreReportRows(value, path) {
  if (!looksLikeRows(value, path)) return 0;

  const keys = Object.keys(value[0]);
  const expected = getExpectedViewerResultKeys();
  const matches = keys.filter(key => expected.has(key.toLowerCase())).length;
  const dataValueCount = keys.filter(key => !/^(id|guid|name|type)$/i.test(key)).length;

  return value.length + (matches * 100) + (dataValueCount * 2);
}

function getExpectedViewerResultKeys() {
  if (!viewerState.tableId || !TABLES[viewerState.tableId]) return new Set();

  const table = TABLES[viewerState.tableId];
  const keys = getViewerColumns(viewerState.tableId).flatMap(({ name, col }) => [
    name,
    col.label,
    col.label.replace(/\s+/g, ''),
    col.label.replace(/[^a-z0-9]/gi, '')
  ]);

  Object.entries(table.columns).forEach(([name, col]) => {
    keys.push(name, col.label);
  });

  return new Set(keys.map(key => String(key).toLowerCase()));
}

function isMetadataPath(path) {
  return /(permission|filterable|available_columns|conditions|joins|series|chart|report\.permissions)/i.test(path);
}

function isMetadataRow(keys) {
  const lowerKeys = keys.map(key => key.toLowerCase());
  const metadataKeys = [
    'query',
    'sys_name',
    'table_joins',
    'data_type_group',
    'permissions_agent',
    'readonly',
    'agent_id',
    'agent_name'
  ];

  if (lowerKeys.includes('agent_id') && lowerKeys.includes('readonly')) return true;
  if (lowerKeys.includes('sys_name') && lowerKeys.includes('query')) return true;
  if (lowerKeys.includes('name') && lowerKeys.includes('data_type') && lowerKeys.includes('data_type_group')) return true;
  return metadataKeys.filter(key => lowerKeys.includes(key)).length >= 2;
}

function showQueryResultHeader(rowCount) {
  const bar = document.getElementById('resultsInfoBar');
  if (bar) bar.style.display = '';
  const sub = document.getElementById('resultsInfoSub');
  if (sub) sub.textContent = `${rowCount} row${rowCount !== 1 ? 's' : ''} returned`;
  const sqlBtn = document.getElementById('viewerSqlBtn');
  if (sqlBtn) sqlBtn.style.display = '';
  const exportWrap = document.getElementById('exportWrap');
  if (exportWrap) exportWrap.style.display = rowCount > 0 ? '' : 'none';
}

function renderRecordRows(rows, rawPayload) {
  const wrap = document.getElementById('recordTableWrap');
  wrap.innerHTML = '';
  viewerState.lastRows = rows;
  viewerState.currentPage = 1;

  const paginationEl = document.getElementById('viewerPagination');
  if (paginationEl) paginationEl.style.display = 'none';

  if (!rows.length) {
    const empty = el('div', { class: 'empty-state compact' });
    empty.innerHTML = '<div class="es-text">Halo responded, but no record rows were found.</div>';
    wrap.appendChild(empty);
    return;
  }

  // Build the header from the same column list displayPagedRows uses, so
  // header and body always have matching cell counts. This includes any
  // virtual (computed) columns from a Halo profile — they get a header
  // labelled with the profile's column name and the body renders "—".
  const viewerCols = viewerState.tableId ? getViewerColumns(viewerState.tableId) : [];
  const tableEl = el('table', { class: 'record-table live-records' });
  const thead = el('thead');
  const headRow = el('tr');
  viewerCols.forEach(vc => {
    const th = el('th');
    if (vc.virtual) {
      th.classList.add('record-th-virtual');
      th.title = 'Computed display column in Halo — not available via SQL.';
      th.innerHTML = `<span class="rt-label">${escapeHtml(vc.col.label)}</span><span class="rt-name">computed</span>`;
    } else {
      th.innerHTML = `<span class="rt-label">${escapeHtml(vc.col.label || vc.name)}</span>`;
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = el('tbody');
  tbody.id = 'recordTableBody';
  tableEl.appendChild(tbody);
  wrap.appendChild(tableEl);

  displayPagedRows();
}

function displayPagedRows() {
  const rows = viewerState.lastRows;
  if (!rows.length) return;

  const tbody = document.getElementById('recordTableBody');
  if (!tbody) return;

  const { currentPage, pageSize } = viewerState;
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, rows.length);
  const pageRows = rows.slice(start, end);

  // Iterate the viewer columns (which include virtual placeholders for
  // Halo's computed display fields). Each row's data is keyed by the
  // column label used in the SQL alias. Virtual columns get an empty
  // cell since they aren't in the SELECT.
  const viewerCols = viewerState.tableId ? getViewerColumns(viewerState.tableId) : [];
  const pkViewerCol = viewerCols.find(vc => vc.col && vc.col.pk);
  const tableRoute = TABLE_ROUTES[viewerState.tableId];
  const canNavigate = !!(pkViewerCol && tableRoute);

  tbody.innerHTML = '';
  pageRows.forEach(row => {
    const tr = el('tr');
    if (canNavigate) {
      const pkValue = row[pkViewerCol.col.label];
      if (pkValue != null && pkValue !== '') {
        tr.classList.add('clickable-row');
        tr.title = `Open record ${pkValue}`;
        tr.addEventListener('click', () => navigateHaloRecord(tableRoute(pkValue)));
      }
    }
    viewerCols.forEach(vc => {
      const td = el('td');
      if (vc.virtual) {
        td.classList.add('record-cell-virtual');
        td.textContent = '—';
        td.title = 'Computed display column in Halo — not available via SQL.';
      } else {
        td.textContent = formatCell(row[vc.col.label]);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  renderPagination(rows.length, start, end);
}

function renderPagination(total, start, end) {
  const paginationEl = document.getElementById('viewerPagination');
  if (!paginationEl) return;
  paginationEl.style.display = '';

  const { currentPage, pageSize } = viewerState;
  const totalPages = Math.ceil(total / pageSize);
  const prevBtn   = document.getElementById('pagePrevBtn');
  const nextBtn   = document.getElementById('pageNextBtn');
  const indicator = document.getElementById('pageIndicator');

  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
  if (indicator) indicator.textContent = total === 0 ? '--' : `${start + 1}-${end} of ${total}`;
}

function navigateHaloRecord(path) {
  chrome.runtime.sendMessage({ type: 'HU_NAVIGATE', data: { path } }, () => {});
}

function exportRows(format) {
  const rows = viewerState.lastRows || [];
  if (!rows.length) return;

  const baseName = `haloutils-${viewerState.tableId || 'records'}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'json') {
    downloadText(`${baseName}.json`, JSON.stringify(rows, null, 2), 'application/json');
    return;
  }
  if (format === 'csv') {
    downloadText(`${baseName}.csv`, rowsToCsv(rows), 'text/csv;charset=utf-8');
    return;
  }
  if (format === 'xlsx') {
    const xlsxData = rowsToXlsx(rows);
    const blob = new Blob([xlsxData], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${baseName}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function rowsToCsv(rows) {
  const columns = getExportColumns(rows);
  const lines = [columns.map(csvCell).join(',')];
  rows.forEach(row => {
    lines.push(columns.map(column => csvCell(row[column])).join(','));
  });
  return lines.join('\r\n');
}


const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipFiles(files) {
  const enc = new TextEncoder();
  const entries = [];
  let localOffset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    entries.push({ nameBytes, dataBytes, crc: crc32(dataBytes), offset: localOffset });
    localOffset += 30 + nameBytes.length + dataBytes.length;
  }
  const cdOffset = localOffset;
  const cdSize = entries.reduce((s, e) => s + 46 + e.nameBytes.length, 0);
  const buf = new Uint8Array(cdOffset + cdSize + 22);
  let p = 0;
  const w16 = v => { buf[p]=v&255; buf[p+1]=(v>>8)&255; p+=2; };
  const w32 = v => { buf[p]=v&255; buf[p+1]=(v>>8)&255; buf[p+2]=(v>>16)&255; buf[p+3]=(v>>24)&255; p+=4; };
  const wb  = a => { buf.set(a, p); p+=a.length; };

  for (const { nameBytes: n, dataBytes: d, crc } of entries) {
    w32(0x04034b50); w16(20); w16(0); w16(0); w16(0); w16(0);
    w32(crc); w32(d.length); w32(d.length); w16(n.length); w16(0);
    wb(n); wb(d);
  }
  for (const { nameBytes: n, dataBytes: d, crc, offset } of entries) {
    w32(0x02014b50); w16(20); w16(20); w16(0); w16(0); w16(0); w16(0);
    w32(crc); w32(d.length); w32(d.length);
    w16(n.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(offset);
    wb(n);
  }
  w32(0x06054b50); w16(0); w16(0); w16(entries.length); w16(entries.length);
  w32(cdSize); w32(cdOffset); w16(0);
  return buf;
}

function xlsxColRef(n) {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
}

function xlsxEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function buildXlsxSheet(rows, columns) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
  xml += '<row r="1">' + columns.map((col, ci) =>
    `<c r="${xlsxColRef(ci)}1" t="inlineStr"><is><t>${xlsxEsc(col)}</t></is></c>`
  ).join('') + '</row>';
  rows.forEach((row, ri) => {
    const rowNum = ri + 2;
    xml += `<row r="${rowNum}">` + columns.map((col, ci) => {
      const val = formatCell(row[col]);
      const num = Number(val);
      const ref = `${xlsxColRef(ci)}${rowNum}`;
      if (val !== '' && !isNaN(num) && isFinite(num)) return `<c r="${ref}"><v>${num}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xlsxEsc(val)}</t></is></c>`;
    }).join('') + '</row>';
  });
  return xml + '</sheetData></worksheet>';
}

function rowsToXlsx(rows) {
  const columns = getExportColumns(rows);
  return zipFiles([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', buildXlsxSheet(rows, columns)],
  ]);
}

function getExportColumns(rows) {
  return [...rows.reduce((set, row) => {
    Object.keys(row || {}).forEach(key => set.add(key));
    return set;
  }, new Set())];
}

function csvCell(value) {
  const text = formatCell(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showViewerError(message) {
  const wrap = document.getElementById('recordTableWrap');
  viewerState.lastRows = [];
  const exportWrap = document.getElementById('exportWrap');
  if (exportWrap) exportWrap.style.display = 'none';
  const pg = document.getElementById('viewerPagination');
  if (pg) pg.style.display = 'none';
  wrap.innerHTML = `
    <div class="empty-state compact error-state">
      <div class="es-text">${escapeHtml(message)}</div>
    </div>
  `;
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function isAllowedNavigationUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.startsWith('/')) return true;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function setupSearch() {
  const schemaSearch = document.getElementById('schemaSearch');
  if (schemaSearch) {
    schemaSearch.addEventListener('input', (e) => renderSchemaExplorer(e.target.value));
  }
  setupSchemaPerspective();

  // Delegated handler for FK chip clicks — jump to the referenced table.
  const schemaList = document.getElementById('schemaList');
  if (schemaList) {
    schemaList.addEventListener('click', (e) => {
      const fkChip = e.target.closest('.sc-fk-clickable');
      if (!fkChip) return;
      e.preventDefault();
      e.stopPropagation();
      const fk = fkChip.dataset.fk || '';
      const [tableId, columnName] = fk.split('.');
      jumpToSchemaTarget(tableId, columnName);
    });
  }
}

// Bridge from Schema explorer → Data Viewer. Seeds the viewer with the
// clicked table and switches tabs in one go so users don't have to pick it
// again. Falls back to a no-op when the Data Viewer is hidden by report-
// API gating; in that case the user shouldn't see the Query button either
// because both tabs hide together.
function openTableInDataViewer(tableId) {
  if (!tableId || !TABLES[tableId]) return;
  const dataTab = document.querySelector('.tab[data-tab="data-viewer"]');
  if (dataTab && dataTab.classList.contains('hidden-no-report-access')) return;
  selectViewerTable(tableId);
  switchToTab('data-viewer');
}

function jumpToSchemaTarget(tableId, columnName) {
  if (!tableId || !TABLES[tableId]) return;
  // Make sure the Schema tab is active so the user actually sees the jump.
  const schemaTabBtn = document.querySelector('[data-tab="schema"]');
  if (schemaTabBtn && !schemaTabBtn.classList.contains('active')) {
    schemaTabBtn.click();
  }
  // Clear any active filter so the target table is guaranteed visible.
  const schemaSearch = document.getElementById('schemaSearch');
  if (schemaSearch && schemaSearch.value) {
    schemaSearch.value = '';
    renderSchemaExplorer('');
  }
  // Find the rendered table block by its name span text.
  const blocks = document.querySelectorAll('#schemaList .schema-table');
  let targetBlock = null;
  blocks.forEach(block => {
    const nameEl = block.querySelector('.st-name');
    if (nameEl && nameEl.textContent.trim() === tableId) targetBlock = block;
  });
  if (!targetBlock) return;
  targetBlock.classList.add('open');
  targetBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Highlight the referenced column briefly so the user can spot it.
  if (columnName) {
    const colRows = targetBlock.querySelectorAll('.schema-col');
    colRows.forEach(row => {
      const nameEl = row.querySelector('.sc-name');
      if (nameEl && nameEl.textContent.trim() === columnName) {
        row.classList.add('sc-flash');
        setTimeout(() => row.classList.remove('sc-flash'), 1600);
      }
    });
  }
}

function setupSchemaPerspective() {
  const buttons = document.querySelectorAll('.schema-perspective-btn');
  if (!buttons.length) return;
  const search = document.getElementById('schemaSearch');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      schemaPerspective = btn.dataset.mode || 'both';
      buttons.forEach(b => { b.dataset.active = String(b.dataset.mode === schemaPerspective); });
      renderSchemaExplorer(search?.value || '');
    });
  });
}

function updateContextBadge(ctx) {
  const badge = document.getElementById('contextBadge');
  if (!badge) return;
  if (ctx?.page && ctx.page !== 'unknown') {
    badge.textContent = ctx.page;
    badge.title = `${ctx.platform || 'Halo'} - ${ctx.page} page`;
  } else if (!isHaloTab) {
    badge.textContent = 'off-site';
    badge.title = 'Active tab is not a Halo page';
  } else {
    badge.textContent = '--';
    badge.title = 'Active page context';
  }
}

function updateEnvPill(envKind, host, customLabel) {
  const pill = document.getElementById('envPill');
  if (!pill) return;
  if (!envKind) {
    pill.style.display = 'none';
    return;
  }
  const spec = (typeof HU_ENVIRONMENT_SPECS !== 'undefined' && HU_ENVIRONMENT_SPECS[envKind])
    || { label: envKind.toUpperCase(), color: '#64748b', bg: '#e2e8f0', text: '#334155' };
  pill.style.display = '';
  pill.style.background = spec.bg;
  pill.style.color = spec.text;
  pill.style.borderColor = spec.color;
  pill.textContent = (customLabel && String(customLabel).trim()) || spec.label;
  pill.title = `Environment: ${spec.label}${host ? ' · ' + host : ''}` +
               (envKind === 'prod' ? '\nChanges affect the real system.' : '');
}

function updateEnvPillForUrl(url) {
  // Show the env pill for any Halo surface where detection finds something
  // (auto-detected or user-overridden). Non-Halo hosts with no config stay
  // hidden. The pill matches the in-page banner behaviour.
  if (!url) { updateEnvPill('', ''); return; }
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { updateEnvPill('', ''); return; }
  if (!host) { updateEnvPill('', ''); return; }
  const detect = typeof huDetectEnvironment === 'function' ? huDetectEnvironment : () => 'unknown';
  chrome.storage.local.get(['huCustomDomainsMeta'], data => {
    const meta = (data && data.huCustomDomainsMeta) || {};
    const entry = meta[host.toLowerCase()] || {};
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const env = entry.env || detect(host);
    if (env === 'unknown' && !label) { updateEnvPill('', ''); return; }
    updateEnvPill(env, host, label);
  });
}

async function refreshActiveTabState() {
  let activeUrl = '';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeUrl = tabs?.[0]?.url || '';
  } catch (error) {
    activeUrl = '';
  }

  pageContext = null;

  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'HU_GET_CONTEXT' }, (response) => {
        if (!chrome.runtime.lastError && response?.ok && response.data) {
          pageContext = response.data;
        }
        resolve();
      });
    });
  } catch (error) {
    pageContext = null;
  }

  isHaloTab = Boolean(pageContext) || isHaloUrl(activeUrl);
  // True when the user IS on a Halo tab but the content script didn't respond.
  // Typical after a CWS update or fresh install on an already-open Halo tab —
  // content scripts only inject on new page loads. We tell them to refresh.
  const needsContentScriptRefresh = !pageContext && isHaloTab;

  if (!isHaloTab) {
    updateContextBadge(null);
    updateEnvPill('', '');
    applyHaloAvailability();
    applyContextRefreshNotice(false);
    return;
  }

  updateContextBadge(pageContext);
  updateEnvPillForUrl(activeUrl);
  applyHaloAvailability();
  applyContextRefreshNotice(needsContentScriptRefresh);

  // Probe /api/Report — Data Viewer + Schema both depend on it. Non-admin
  // agents 403, so we hide those tabs and surface a clear message rather
  // than silent broken queries. Fire and forget; gating updates async.
  refreshReportApiState();
}

function applyContextRefreshNotice(show) {
  let notice = document.getElementById('refreshContextNotice');
  if (show) {
    if (!notice) {
      notice = document.createElement('section');
      notice.id = 'refreshContextNotice';
      notice.className = 'surface-notice';
      notice.innerHTML = `
        <strong>HaloPlus needs a tab refresh.</strong>
        You're on a Halo page, but HaloPlus can't see it yet — this usually means
        the extension was just installed or updated. Refresh this tab so HaloPlus
        can connect.
        <div style="margin-top:8px;">
          <button class="btn-primary" id="refreshContextBtn" type="button">Refresh tab</button>
        </div>
      `;
      const nonHaloNotice = document.getElementById('nonHaloNotice');
      nonHaloNotice?.parentNode?.insertBefore(notice, nonHaloNotice.nextSibling);
      notice.querySelector('#refreshContextBtn').addEventListener('click', async () => {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs?.[0]?.id) await chrome.tabs.reload(tabs[0].id);
        } catch (_) {}
        // Re-probe after the reload so the notice disappears when the content
        // script reports in.
        setTimeout(() => refreshActiveTabState(), 1500);
      });
    }
    notice.style.display = 'block';
  } else if (notice) {
    notice.style.display = 'none';
  }
}

async function refreshReportApiState() {
  let reportApiOk = null;
  let reportApiError = '';
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'HU_GET_REPORT_STATUS' }, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });
    if (response?.ok) {
      reportApiOk = response.reportApiOk;
      reportApiError = response.reportApiError || '';
    }
  } catch (error) {
    // Stay tri-state on transient failure — gating only fires on explicit `false`.
  }
  applyReportApiAvailability(reportApiOk, reportApiError);
}

function applyReportApiAvailability(reportApiOk, reportApiError) {
  // Tri-state: true (allow), false (block + show notice), null (unknown — leave as-is).
  const sqlTabNames = ['data-viewer', 'sql-helper'];
  const blocked = reportApiOk === false;

  sqlTabNames.forEach((tabName) => {
    const tabButton = document.querySelector(`.tab[data-tab="${tabName}"]`);
    const tabPanel = document.getElementById(`tab-${tabName}`);
    tabButton?.classList.toggle('hidden-no-report-access', blocked);
    tabPanel?.classList.toggle('hidden-no-report-access', blocked);
  });

  let notice = document.getElementById('noReportAccessNotice');
  if (blocked) {
    if (!notice) {
      notice = document.createElement('section');
      notice.id = 'noReportAccessNotice';
      notice.className = 'surface-notice';
      // Only surface a reason when Halo's 403 body has actual content. Halo
      // typically returns an empty body, so we'd otherwise show "(Halo API 403:)".
      const detail = String(reportApiError || '').replace(/^Halo API \d+:\s*/i, '').trim();
      const reason = detail ? ` (${detail})` : '';
      notice.innerHTML = `<strong>Some features are hidden.</strong> Your Halo account doesn't have permission to run reports${reason}, so Data Viewer and Schema have been turned off. Ask a Halo admin to enable the report permission on your role if you need them.`;
      const nonHaloNotice = document.getElementById('nonHaloNotice');
      nonHaloNotice?.parentNode?.insertBefore(notice, nonHaloNotice.nextSibling);
    }
    notice.style.display = isHaloTab ? 'block' : 'none';
    // If the active tab has just been hidden, switch to Utilities (which works
    // without Report access).
    const activeHidden = document.querySelector('.tab.active.hidden-no-report-access');
    if (activeHidden) switchToTab('utilities');
  } else if (notice) {
    notice.style.display = 'none';
  }
}

function isHaloUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return HALO_HOST_PATTERN.test(parsed.hostname) || customMatchesIncludeUrl(customHaloMatches, parsed.href);
  } catch (error) {
    return false;
  }
}

function applyHaloAvailability() {
  const haloTabNames = ['data-viewer', 'sql-helper', 'utilities'];
  const note = document.getElementById('nonHaloNotice');
  const noteBody = document.getElementById('nonHaloNoticeBody');
  const regrantBtn = document.getElementById('regrantDomainsBtn');
  const utilityStatus = document.getElementById('utilityStatus');

  haloTabNames.forEach((tabName) => {
    const tabButton = document.querySelector(`.tab[data-tab="${tabName}"]`);
    const tabPanel = document.getElementById(`tab-${tabName}`);
    tabButton?.classList.toggle('hidden-when-no-halo', !isHaloTab);
    tabPanel?.classList.toggle('hidden-when-no-halo', !isHaloTab);
  });

  if (!isHaloTab && !document.getElementById('tab-settings')?.classList.contains('active')) {
    switchToTab('settings');
  }

  if (note) note.style.display = isHaloTab ? 'none' : 'block';
  if (utilityStatus && !isHaloTab) {
    utilityStatus.textContent = 'Open a Halo tab to use HaloPlus utilities.';
  }

  if (!isHaloTab && noteBody && regrantBtn && customHaloMatches.length) {
    checkCustomDomainPermission(customHaloMatches).then(granted => {
      const labels = customHaloMatches
        .map(m => escapeHtml(m.replace(/^https?:\/\//, '').replace(/\/\*$/, '')))
        .join(', ');
      if (granted) {
        noteBody.innerHTML = '<strong>Halo page not detected.</strong> Open one of your saved custom domains (' + labels +
          ') or a standard HaloITSM / HaloPSA tab. If your custom-domain page is already open but still not detected, refresh it once.';
        regrantBtn.style.display = 'none';
      } else {
        noteBody.innerHTML = '<strong>Custom Halo domain access was revoked.</strong> Your saved domains (' + labels +
          ') need permission re-granted after the extension update. Click below, accept the Chrome prompt, then refresh your Halo tab.';
        regrantBtn.style.display = '';
      }
    }).catch(() => {
      if (regrantBtn) regrantBtn.style.display = 'none';
    });
  } else if (regrantBtn) {
    regrantBtn.style.display = 'none';
  }
}

function checkCustomDomainPermission(matches) {
  if (!matches || !matches.length) return Promise.resolve(true);
  return new Promise(resolve => {
    try {
      chrome.permissions.contains({ origins: matches }, has => resolve(!!has));
    } catch (e) {
      resolve(true);
    }
  });
}

function setupRegrantButton() {
  const btn = document.getElementById('regrantDomainsBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!customHaloMatches.length) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Requesting access…';
    try {
      const granted = await requestHostPermissions(customHaloMatches);
      if (granted) {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'HU_REGISTER_CUSTOM_DOMAINS' }, () => resolve());
        });
        await refreshActiveTabState();
        btn.textContent = 'Access granted — refresh your Halo tab';
      } else {
        btn.textContent = 'Access not granted. Try again or check Chrome permissions.';
      }
    } catch (e) {
      btn.textContent = 'Error: ' + (e.message || 'Could not re-grant');
    } finally {
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
    }
  });
}

// --- Diagnostics card ---------------------------------------------------------

let lastDiagnostics = null;
let lastExtendedProbes = null;

function setupDiagnostics() {
  const runBtn = document.getElementById('runDiagnosticsBtn');
  const copyBtn = document.getElementById('copyDiagnosticsBtn');
  const probeBtn = document.getElementById('runExtendedProbesBtn');
  if (runBtn) runBtn.addEventListener('click', runDiagnostics);
  if (copyBtn) copyBtn.addEventListener('click', copyDiagnostics);
  if (probeBtn) probeBtn.addEventListener('click', runExtendedProbes);
}

function setupManualButton() {
  const btn = document.getElementById('openManualBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (chrome?.tabs?.create) chrome.tabs.create({ url: MANUAL_URL });
    else window.open(MANUAL_URL, '_blank', 'noopener');
  });
}

function runDiagnostics() {
  const runBtn = document.getElementById('runDiagnosticsBtn');
  const list = document.getElementById('diagList');
  if (!list) return;
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Running…'; }
  list.innerHTML = '<div class="diag-empty">Collecting diagnostics…</div>';

  chrome.runtime.sendMessage({ type: 'HU_GET_DIAGNOSTICS' }, response => {
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run diagnostics'; }
    if (chrome.runtime.lastError || !response || !response.ok) {
      const err = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Unknown error';
      list.innerHTML = '<div class="diag-empty">Diagnostics failed: ' + escapeHtml(err) + '</div>';
      return;
    }
    lastDiagnostics = response.data;
    renderDiagnostics(response.data);
    const copyBtn = document.getElementById('copyDiagnosticsBtn');
    if (copyBtn) copyBtn.disabled = false;
  });
}

// Friendly labels for the /api/<route> palette-search probes. Falls back to
// a Title-cased version of the route when an entry is missing.
const ENTITY_ROUTE_LABELS = {
  ticket:        'Tickets',
  client:        'Customers',
  user:          'Users (end users)',
  agent:         'Agents',
  asset:         'Assets',
  site:          'Sites',
  supplier:      'Suppliers',
  team:          'Teams',
  KBArticle:     'Knowledge base',
  invoice:       'Invoices',
  quotation:     'Quotes',
  purchaseorder: 'Purchase orders'
};

function friendlyRouteLabel(route) {
  if (ENTITY_ROUTE_LABELS[route]) return ENTITY_ROUTE_LABELS[route];
  return route.charAt(0).toUpperCase() + route.slice(1);
}

function renderDiagnostics(data) {
  const list = document.getElementById('diagList');
  if (!list) return;
  list.innerHTML = '';

  // Compute an overall health verdict before rendering individual rows so we
  // can put a clear at-a-glance banner at the top.
  const verdict = computeDiagnosticsVerdict(data);
  list.appendChild(makeDiagBanner(verdict));

  // Reorder the groups to lead with what most users actually want to see
  // first: am I detected, what's my role, what works, what doesn't.
  const tabRows = [];
  if (data.activeTab && data.activeTab.url) {
    if (data.contentScriptReachable === true) {
      tabRows.push(diagRow('ok', 'HaloPlus is connected', 'Detected this Halo tab and the page-side script is responding.'));
    } else if (data.contentScriptReachable === false) {
      const detail = data.activeTabError
        ? 'Page script not responding — ' + data.activeTabError + '. Reload the tab; if it persists the extension may not be allowed to inject on this URL.'
        : 'Page script not responding. Reload the tab to retry.';
      tabRows.push(diagRow('bad', 'HaloPlus is not connected', detail));
    } else {
      tabRows.push(diagRow('unknown', 'Connection not checked', 'No active tab to check against.'));
    }
  } else {
    tabRows.push(diagRow('warn', 'No active tab', 'Open a Halo page in this window to run diagnostics.'));
  }
  list.appendChild(makeDiagGroup('On this tab', tabRows));

  if (data.lastRegistrationError) {
    list.appendChild(makeDiagGroup('Last registration error', [
      diagRow('bad', 'Error', data.lastRegistrationError)
    ]));
  }

  if (data.page) {
    const p = data.page;

    // ── Your account ─────────────────────────────────────────────────
    if (p.permissions) {
      const perm = p.permissions;
      const accountRows = [];
      accountRows.push(diagRow(
        perm.isAdmin ? 'ok' : 'warn',
        'Account type',
        perm.isAdmin ? 'Administrator — full feature set is available.' : 'Standard agent — some admin-only features will be hidden.'
      ));
      accountRows.push(diagRow(
        perm.canImpersonate ? 'ok' : 'unknown',
        'Impersonation',
        perm.canImpersonate ? '/imp is available for your role.' : 'Not enabled for your role.'
      ));
      accountRows.push(diagRow(
        perm.canLogTickets ? 'ok' : 'unknown',
        'Logging tickets',
        perm.canLogTickets ? 'You can create tickets via HaloPlus.' : 'Not enabled for your role.'
      ));
      if (perm.isImpersonating) {
        accountRows.push(diagRow('warn', 'Currently impersonating',
          `Acting as agent ${perm.currentAgentId} (real agent ${perm.parentAgentId}). Use /xi to drop back.`));
      } else if (perm.staleImpersonationMarker) {
        accountRows.push(diagRow('unknown', 'Stale impersonation marker',
          `Halo has a leftover "real user" id (${perm.parentAgentId}) in this tab's storage that isn't a real agent. HaloPlus is ignoring it — you're not impersonating.`));
      }
      list.appendChild(makeDiagGroup('Your account', accountRows));
    }

    // ── What's available for your role ───────────────────────────────
    const featureRows = [];

    // SQL access — drives Data Viewer + Schema explorer
    if (p.reportApiOk === true) {
      featureRows.push(diagRow('ok', 'Data Viewer & SQL Schema', 'Working — you can run queries and explore the SQL schema.'));
    } else if (p.reportApiOk === false) {
      featureRows.push(diagRow('bad', 'Data Viewer & SQL Schema',
        'Unavailable — your Halo role doesn\'t allow direct SQL queries. The Data Viewer tab is hidden.'));
    } else {
      featureRows.push(diagRow('unknown', 'Data Viewer & SQL Schema', 'Not probed yet — running this in the background.'));
    }

    // Palette searches — roll up entity-API access into one summary row + per-entity sub rows
    if (p.entityAccess) {
      const entries = Object.entries(p.entityAccess);
      const okCount  = entries.filter(([, ok]) => ok === true).length;
      const badCount = entries.filter(([, ok]) => ok === false).length;
      const total    = entries.length;

      let summaryStatus, summaryText;
      if (badCount === 0) {
        summaryStatus = 'ok';
        summaryText = `All ${total} palette searches work for your role.`;
      } else if (okCount === 0) {
        summaryStatus = 'bad';
        summaryText = 'None of the palette searches are available for your role.';
      } else {
        summaryStatus = 'warn';
        summaryText = `${okCount} of ${total} palette searches work. The rest are greyed out in the palette.`;
      }
      featureRows.push(diagRow(summaryStatus, 'Palette searches', summaryText));

      // Only show per-entity detail when something is actually restricted.
      if (badCount > 0) {
        entries.forEach(([route, ok]) => {
          if (ok === true) return;
          const label = '   · ' + friendlyRouteLabel(route);
          const sub = ok === false ? 'Restricted for your role — greyed out in the palette.'
                                   : 'Couldn\'t verify (network or 404).';
          featureRows.push(diagRow(ok === false ? 'bad' : 'unknown', label, sub));
        });
      }
    }

    // Ticket types
    const ttStatus = p.ticketTypeCount > 0 ? 'ok' : 'warn';
    const ttDetail = p.ticketTypeCount > 0
      ? `${p.ticketTypeCount} types loaded into the palette.${p.ticketTypeTagsLoaded ? '' : ' Email tag prefixes still loading in the background.'}`
      : 'No custom ticket types detected yet. Open the palette once to trigger loading.';
    featureRows.push(diagRow(ttStatus, 'Custom ticket types', ttDetail));

    list.appendChild(makeDiagGroup('Available features', featureRows));

    // ── Custom Halo domains (only when relevant) ─────────────────────
    if (data.savedDomains && data.savedDomains.length) {
      const rows = [];
      data.savedDomains.forEach(domain => {
        const permResult = (data.permissionsPerDomain || []).find(p => p.match === domain) || { granted: false };
        const isRegistered = (data.registeredMatches || []).includes(domain);
        const displayHost = domain.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
        const ok = permResult.granted && isRegistered;
        rows.push(diagRow(
          ok ? 'ok' : 'bad',
          displayHost,
          ok ? 'Permission granted and content script is registered.'
             : !permResult.granted ? 'Chrome permission not granted — click Re-grant on the Halo banner above.'
                                   : 'Content script not registered — remove and re-add this domain.'
        ));
      });
      list.appendChild(makeDiagGroup('Custom Halo domains', rows));
    }

    // ── Diagnostics footer with version (kept for support) ───────────
    list.appendChild(makeDiagGroup('About this report', [
      diagRow('unknown', 'HaloPlus version', data.extensionVersion || '(unknown)')
    ]));
  }
}

function computeDiagnosticsVerdict(data) {
  // Critical: extension can't talk to a Halo tab at all
  if (!data.activeTab || !data.activeTab.url) {
    return { level: 'warn', headline: 'No active tab', sub: 'Open a Halo page in this window and re-run diagnostics.' };
  }
  if (data.contentScriptReachable === false) {
    return { level: 'bad', headline: 'HaloPlus can\'t reach Halo on this tab', sub: 'Try reloading the tab. If the issue persists, check Custom Halo domains below.' };
  }
  if (data.lastRegistrationError) {
    return { level: 'bad', headline: 'Last registration failed', sub: 'See the error in the report below.' };
  }
  if (!data.page) {
    return { level: 'warn', headline: 'Couldn\'t collect page diagnostics', sub: 'Try reloading the tab and re-running.' };
  }

  const p = data.page;
  const issues = [];
  if (p.reportApiOk === false) issues.push('Data Viewer & SQL Schema');
  if (p.entityAccess) {
    const blocked = Object.values(p.entityAccess).filter(v => v === false).length;
    if (blocked > 0) issues.push(`${blocked} palette search${blocked === 1 ? '' : 'es'}`);
  }
  if (p.permissions && p.permissions.staleImpersonationMarker) issues.push('a stale impersonation marker');

  if (!issues.length) {
    return { level: 'ok', headline: 'All systems go', sub: 'HaloPlus is fully operational on this tenant.' };
  }
  return {
    level: 'warn',
    headline: 'Some features are limited for your role',
    sub: 'Unavailable: ' + issues.join(', ') + '. Details below.'
  };
}

function makeDiagBanner(verdict) {
  const banner = document.createElement('div');
  banner.className = 'diag-banner diag-banner-' + verdict.level;
  const icon = document.createElement('span');
  icon.className = 'diag-banner-icon';
  icon.textContent = verdict.level === 'ok' ? '✓' : verdict.level === 'bad' ? '✗' : '!';
  const text = document.createElement('div');
  text.className = 'diag-banner-text';
  const head = document.createElement('span');
  head.className = 'diag-banner-head';
  head.textContent = verdict.headline;
  const sub = document.createElement('span');
  sub.className = 'diag-banner-sub';
  sub.textContent = verdict.sub || '';
  text.appendChild(head);
  text.appendChild(sub);
  banner.appendChild(icon);
  banner.appendChild(text);
  return banner;
}

function runExtendedProbes() {
  const probeBtn = document.getElementById('runExtendedProbesBtn');
  const list = document.getElementById('diagList');
  if (!list) return;
  if (probeBtn) { probeBtn.disabled = true; probeBtn.textContent = 'Probing…'; }

  let placeholder = document.getElementById('extProbesGroup');
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.id = 'extProbesGroup';
    placeholder.className = 'diag-group';
    list.appendChild(placeholder);
  }
  placeholder.innerHTML = '<span class="diag-group-title">Extended probes</span><div class="diag-empty">Probing 10 candidate endpoints…</div>';

  chrome.runtime.sendMessage({ type: 'HU_RUN_EXTENDED_PROBES' }, response => {
    if (probeBtn) { probeBtn.disabled = false; probeBtn.textContent = 'Run extended probes'; }
    if (chrome.runtime.lastError || !response || !response.ok) {
      const err = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Unknown error';
      placeholder.innerHTML = '<span class="diag-group-title">Extended probes</span><div class="diag-empty">Probes failed: ' + escapeHtml(err) + '</div>';
      return;
    }
    lastExtendedProbes = response.data;
    renderExtendedProbes(placeholder, response.data);
  });
}

// Translates each probe path to a friendly feature name that's the row's
// primary label. The technical path moves into the sub-text so the human
// scan path is feature → status, not URL → URL.
const EXTENDED_PROBE_LABELS = {
  '/api/Agent/me':                                    'Your agent identity',
  '/api/Search?search=test&count_per_entity=2':       'Universal search across entities',
  '/api/ViewColumns?type=1':                          'Saved-view column labels',
  '/api/tickets?count=1&includecolumns=true':         'List-grid column labels (tickets)',
  '/api/PopupNote?showall=true':                      'Popup notes (VIP / contract warnings)',
  '/api/FaultViewLog':                                'Ticket "viewed by" trail',
  '/api/Notifications?count=5':                       'In-app notifications feed',
  '/api/Feed?count=5':                                'Activity feed',
  '/api/HaloField':                                   'Generic field metadata',
  '/api/Field?kind=ticket':                           'Ticket field definitions'
};

function renderExtendedProbes(container, data) {
  container.innerHTML = '';
  const title = document.createElement('span');
  title.className = 'diag-group-title';
  title.textContent = 'Optional features (extended probes)';
  container.appendChild(title);

  const results = data.results || [];
  const okCount = results.filter(r => r.status === 'ok').length;
  const intro = document.createElement('div');
  intro.className = 'diag-banner-sub';
  intro.style.padding = '0 2px 6px';
  intro.textContent = `${okCount} of ${results.length} optional features are available on this tenant + role.`;
  container.appendChild(intro);

  results.forEach(r => {
    const featureLabel = EXTENDED_PROBE_LABELS[r.path] || r.purpose || r.path;
    let icon;
    let sub;
    if (r.status === 'ok') {
      icon = 'ok';
      sub = `Available · responded in ${r.ms}ms`;
    } else if (r.status === 'forbidden') {
      icon = 'bad';
      sub = 'Restricted — your Halo role isn\'t allowed to call this endpoint.';
    } else if (r.status === 'unauthorized') {
      icon = 'bad';
      sub = 'Not authorised — re-login to Halo and try again.';
    } else if (r.status === 'notfound') {
      icon = 'warn';
      sub = 'Not available on this Halo build.';
    } else if (r.status === 'error') {
      icon = 'warn';
      sub = `Returned HTTP ${r.httpCode || '?'} — endpoint may be tenant-disabled.`;
    } else {
      icon = 'unknown';
      sub = 'Couldn\'t verify — network or unexpected response.';
    }
    sub += '  ·  ' + r.path;
    container.appendChild(diagRow(icon, featureLabel, sub));
  });
}

function makeDiagGroup(title, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'diag-group';
  const titleEl = document.createElement('span');
  titleEl.className = 'diag-group-title';
  titleEl.textContent = title;
  wrap.appendChild(titleEl);
  rows.forEach(r => wrap.appendChild(r));
  return wrap;
}

function diagRow(status, label, sub) {
  const row = document.createElement('div');
  row.className = 'diag-row';

  const icon = document.createElement('span');
  icon.className = 'diag-icon diag-icon-' + status;
  icon.textContent = status === 'ok' ? '✓' : status === 'bad' ? '✗' : status === 'warn' ? '!' : '?';
  row.appendChild(icon);

  const labelWrap = document.createElement('div');
  const labelEl = document.createElement('span');
  labelEl.className = 'diag-label';
  labelEl.textContent = label;
  labelWrap.appendChild(labelEl);
  if (sub) {
    const subEl = document.createElement('span');
    subEl.className = 'diag-label-sub';
    subEl.textContent = sub;
    labelWrap.appendChild(subEl);
  }
  row.appendChild(labelWrap);

  return row;
}

async function copyDiagnostics() {
  if (!lastDiagnostics) return;
  const status = document.getElementById('diagCopyStatus');
  const text = formatDiagnosticsForClipboard(lastDiagnostics);
  try {
    await navigator.clipboard.writeText(text);
    if (status) {
      status.textContent = 'Copied to clipboard.';
      setTimeout(() => { status.textContent = ''; }, 3000);
    }
  } catch (e) {
    if (status) status.textContent = 'Copy failed: ' + e.message;
  }
}

function formatDiagnosticsForClipboard(d) {
  const lines = [];
  lines.push('HaloPlus Diagnostics');
  lines.push('Generated: ' + (d.timestamp || ''));
  lines.push('Version: ' + (d.extensionVersion || '?'));
  lines.push('');
  lines.push('Saved custom domains:');
  if (!d.savedDomains || !d.savedDomains.length) {
    lines.push('  (none)');
  } else {
    d.savedDomains.forEach(domain => {
      const perm = (d.permissionsPerDomain || []).find(p => p.match === domain);
      const reg = (d.registeredMatches || []).includes(domain);
      lines.push('  ' + domain);
      lines.push('    permission granted: ' + (perm && perm.granted ? 'yes' : 'no'));
      lines.push('    content script registered: ' + (reg ? 'yes' : 'no'));
    });
  }
  lines.push('');
  lines.push('Active tab:');
  lines.push('  url: ' + ((d.activeTab && d.activeTab.url) || '(none)'));
  lines.push('  content script reachable: ' + (d.contentScriptReachable === true ? 'yes' : d.contentScriptReachable === false ? 'no' : 'not checked'));
  if (d.activeTabError) lines.push('  error: ' + d.activeTabError);
  lines.push('');
  lines.push('Last registration error: ' + (d.lastRegistrationError || 'none'));
  if (lastExtendedProbes && Array.isArray(lastExtendedProbes.results)) {
    lines.push('');
    lines.push('Extended probes (probed ' + (lastExtendedProbes.probedAt || '') + '):');
    lastExtendedProbes.results.forEach(r => {
      const detail = r.status === 'ok'
        ? `200 ${r.ms}ms ${r.shape}`
        : r.status === 'forbidden' ? '403 forbidden'
        : r.status === 'unauthorized' ? '401 unauthorized'
        : r.status === 'notfound' ? '404'
        : r.status === 'error' ? `HTTP ${r.httpCode || '?'}`
        : `inconclusive: ${(r.error || '').slice(0, 80)}`;
      lines.push('  ' + r.path + '  →  ' + detail);
    });
  }
  return lines.join('\n');
}

function listenForContext() {
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'PAGE_CONTEXT' && message.data) {
        pageContext = message.data;
        isHaloTab = true;
        updateContextBadge(pageContext);
        applyHaloAvailability();
      }
    });
  } catch (e) {
    // Not running as extension (dev mode)
  }
}

function isTemplateRelevant(tpl) {
  if (!pageContext) return false;
  const relevantTables = PAGE_RELEVANT_TABLES[pageContext.page] || [];
  if (!relevantTables.length) return false;
  return tpl.tables_used?.some(t => relevantTables.includes(t))
      || tpl.variables_used?.some(v => Object.keys(pageContext.vars || {}).includes(v));
}

function el(tag, attrs = {}, text = '') {
  const element = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => element.setAttribute(k, v));
  if (text) element.textContent = text;
  return element;
}

let customCommands = [];
let editingCommandIndex = null;

async function loadCustomCommandsPanel() {
  const data = await new Promise(r => chrome.storage.local.get(['huCustomCommands'], r));
  customCommands = data.huCustomCommands || [];
}

async function persistCustomCommands() {
  await new Promise(r => chrome.storage.local.set({ huCustomCommands: customCommands }, r));
}

function renderCommandList() {
  const list = document.getElementById('commandList');
  if (!list) return;
  list.innerHTML = '';
  if (!customCommands.length) {
    list.innerHTML = '<div class="cmds-empty">No custom commands yet. Create one to launch it from the palette with /.</div>';
    return;
  }
  customCommands.forEach((cmd, index) => {
    const item = el('div', { class: editingCommandIndex === index ? 'cmd-item is-editing-hidden' : 'cmd-item' });
    const preview = cmd.type === 'sql'
      ? (cmd.sql || '').replace(/\s+/g, ' ').trim().slice(0, 55) + (cmd.sql?.length > 55 ? '...' : '')
      : (cmd.url || '');
    item.innerHTML = `
      <div class="cmd-item-info">
        <span class="cmd-item-title">/${escapeHtml(cmd.title)}</span>
        <span class="cmd-item-sub">${escapeHtml(cmd.subtitle || preview)}</span>
      </div>
      <span class="cmd-item-badge">${escapeHtml(cmd.category || cmd.type)}</span>
      <div class="cmd-item-actions">
        <button class="cmd-item-edit" title="Edit command">Edit</button>
        <button class="cmd-item-del" title="Delete command">&times;</button>
      </div>
    `;
    item.querySelector('.cmd-item-edit').addEventListener('click', () => {
      document.getElementById('addCommandBtn').style.display = 'none';
      showCommandForm(index);
    });
    item.querySelector('.cmd-item-del').addEventListener('click', async () => {
      customCommands.splice(index, 1);
      await persistCustomCommands();
      renderCommandList();
    });
    list.appendChild(item);
  });
}

function showCommandForm(editIndex = null) {
  editingCommandIndex = Number.isInteger(editIndex) ? editIndex : null;
  renderCommandList();
  const form = document.getElementById('commandForm');
  if (!form) return;
  form.style.display = '';
  form.innerHTML = '';
  const isEditing = Number.isInteger(editIndex) && editIndex >= 0 && editIndex < customCommands.length;
  const existing = isEditing ? customCommands[editIndex] : null;

  const wrapper = el('div', { class: 'cmd-form' });
  wrapper.innerHTML = `
    <div class="cmd-form-row">
      <label class="field-label">Command name</label>
      <input id="cmdTitle" type="text" class="input-field" placeholder="e.g. Open Tickets Today" value="${escapeHtml(existing?.title || '')}">
    </div>
    <div class="cmd-form-row">
      <label class="field-label">Description <span style="font-weight:400;color:var(--text-3)">(shown in palette)</span></label>
      <input id="cmdSubtitle" type="text" class="input-field" placeholder="Optional short description" value="${escapeHtml(existing?.subtitle || '')}">
    </div>
    <div class="cmd-form-split">
      <div class="cmd-form-row">
        <label class="field-label">Type</label>
        <select id="cmdType" class="select-field">
          <option value="navigation">Navigation</option>
          <option value="sql">SQL</option>
        </select>
      </div>
      <div class="cmd-form-row">
        <label class="field-label">Category</label>
        <input id="cmdCategory" type="text" class="input-field" list="cmdCategoryList" placeholder="e.g. Finance" value="${escapeHtml(existing?.category || '')}">
        <datalist id="cmdCategoryList">
          <option value="Navigation"><option value="SQL">
          <option value="ITSM"><option value="Finance"><option value="People">
          <option value="Assets"><option value="Config"><option value="Workflow">
        </datalist>
      </div>
    </div>
    <div class="cmd-form-row" id="cmdUrlRow">
      <label class="field-label">URL</label>
      <input id="cmdUrl" type="text" class="input-field" placeholder="/customers?filter=...  or  https://...">
    </div>
    <div class="cmd-form-row" id="cmdSqlRow" style="display:none">
      <label class="field-label">SQL</label>
      <textarea id="cmdSql" class="input-field cmd-sql-area" placeholder="SELECT TOP 50 Faultid, Symptom FROM faults WHERE ..."></textarea>
    </div>
    <div class="cmd-form-actions">
      <button class="btn-small" id="cmdCancelBtn">Cancel</button>
      <button class="btn-primary" id="cmdSaveBtn">Save command</button>
    </div>
  `;
  form.appendChild(wrapper);

  const typeEl = document.getElementById('cmdType');
  const urlRow = document.getElementById('cmdUrlRow');
  const sqlRow = document.getElementById('cmdSqlRow');
  const titleEl = document.getElementById('cmdTitle');
  const subtitleEl = document.getElementById('cmdSubtitle');
  const categoryEl = document.getElementById('cmdCategory');
  const urlEl = document.getElementById('cmdUrl');
  const sqlEl = document.getElementById('cmdSql');
  const saveBtn = document.getElementById('cmdSaveBtn');

  titleEl.value = existing?.title || '';
  subtitleEl.value = existing?.subtitle || '';
  categoryEl.value = existing?.category || '';
  urlEl.value = existing?.url || '';
  sqlEl.value = existing?.sql || '';
  typeEl.value = existing?.type || 'navigation';
  if (isEditing) saveBtn.textContent = 'Save changes';

  const syncTypeUi = () => {
    urlRow.style.display = typeEl.value === 'navigation' ? '' : 'none';
    sqlRow.style.display = typeEl.value === 'sql' ? '' : 'none';
  };

  typeEl.addEventListener('change', syncTypeUi);
  syncTypeUi();

  saveBtn.addEventListener('click', async () => {
    const title = titleEl.value.trim();
    const type = typeEl.value;
    const url = urlEl.value.trim();
    const sql = sqlEl.value.trim();

    if (!title) { titleEl.classList.add('var-input-error'); return; }
    if (type === 'navigation' && !url) { urlEl.classList.add('var-input-error'); return; }
    if (type === 'navigation' && !isAllowedNavigationUrl(url)) {
      urlEl.classList.add('var-input-error');
      urlEl.title = 'Only http(s) URLs or paths starting with / are allowed.';
      return;
    }
    if (type === 'sql' && !sql) { sqlEl.classList.add('var-input-error'); return; }

    const cmd = {
      id: existing?.id || Date.now().toString(),
      title,
      subtitle: subtitleEl.value.trim(),
      type,
      category: categoryEl.value.trim() || (type === 'navigation' ? 'Navigation' : 'SQL'),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (type === 'navigation') cmd.url = url;
    if (type === 'sql') cmd.sql = sql;

    if (isEditing) {
      customCommands.splice(editIndex, 1, cmd);
    } else {
      customCommands.push(cmd);
    }
    await persistCustomCommands();
    editingCommandIndex = null;
    form.style.display = 'none';
    document.getElementById('addCommandBtn').style.display = '';
    renderCommandList();
  });

  document.getElementById('cmdCancelBtn').addEventListener('click', () => {
    editingCommandIndex = null;
    form.style.display = 'none';
    document.getElementById('addCommandBtn').style.display = '';
    renderCommandList();
  });

  titleEl.focus();
}

function setupCommandsSection() {
  loadCustomCommandsPanel().then(renderCommandList);
  document.getElementById('addCommandBtn').addEventListener('click', () => {
    document.getElementById('addCommandBtn').style.display = 'none';
    showCommandForm();
  });
}

async function loadCustomHaloDomains() {
  const data = await new Promise(r => chrome.storage.local.get([CUSTOM_DOMAINS_KEY], r));
  customHaloMatches = Array.isArray(data[CUSTOM_DOMAINS_KEY]) ? data[CUSTOM_DOMAINS_KEY] : [];
  return customHaloMatches;
}

// Storage layout for the env labels. Keyed by hostname (lowercase) so a
// single entry covers any URL match. Existing `huCustomHaloDomains` (an
// array of match patterns) stays as the Chrome-permissions source; we
// just layer env metadata on top.
const DOMAINS_META_KEY = 'huCustomDomainsMeta';

async function loadDomainsMeta() {
  const data = await new Promise(r => chrome.storage.local.get([DOMAINS_META_KEY], r));
  return (data && data[DOMAINS_META_KEY]) || {};
}

async function saveDomainsMeta(meta) {
  await new Promise(r => chrome.storage.local.set({ [DOMAINS_META_KEY]: meta }, r));
}

function matchToHost(match) {
  // `https://acme.com/*` → `acme.com`; tolerates wildcards like
  // `https://*.acme.com/*` by stripping the leading `*.`.
  try {
    const m = String(match).replace(/^https?:\/\//, '').replace(/\/\*?$/, '');
    return m.replace(/^\*\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function isHaloStandardHost(host) {
  return /\.(halopsa\.com|haloitsm\.com|haloservicedesk\.com)$/i.test(host);
}

function setupCustomDomainSettings() {
  const addBtn       = document.getElementById('domainAddBtn');
  const addForm      = document.getElementById('domainAddForm');
  const addHost      = document.getElementById('domainAddHost');
  const addEnv       = document.getElementById('domainAddEnv');
  const addLabel     = document.getElementById('domainAddLabel');
  const addConfirm   = document.getElementById('domainAddConfirmBtn');
  const addCancel    = document.getElementById('domainAddCancelBtn');
  if (!addBtn || !addForm) return;

  renderDomainList();

  addBtn.addEventListener('click', async () => {
    addForm.hidden = false;
    addBtn.hidden = true;
    addEnv.value = '';
    addLabel.value = '';
    // Prefill the host from the active tab when it's a Halo page that isn't
    // already in the user's tenant list. Saves a copy-paste step in the
    // common "I'm here, save this as a tenant" flow.
    addHost.value = await getPrefilledHostForAdd();
    setTimeout(() => addHost.focus(), 30);
  });

  addCancel.addEventListener('click', () => {
    addForm.hidden = true;
    addBtn.hidden = false;
  });

  addConfirm.addEventListener('click', () => addDomain({
    host: addHost.value,
    env: addEnv.value,
    label: addLabel.value
  }));
  addHost.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addConfirm.click(); }
  });
}

// Returns the active tab's hostname when it's a Halo page (standard apex
// or one of the user's custom-domain matches) AND hasn't already been
// configured. Returns '' when nothing usable is found — the user can
// still type a host manually.
async function getPrefilledHostForAdd() {
  let url = '';
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tabs?.[0]?.url || '';
  } catch (_) {
    return '';
  }
  if (!url) return '';
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
  if (!host) return '';
  // Only prefill on actual Halo surfaces (standard or saved custom).
  if (!isHaloUrl(url)) return '';
  // Don't prefill if this host already has an entry.
  const meta = await loadDomainsMeta();
  if (meta[host]) return '';
  return host;
}

async function addDomain({ host, env, label }) {
  const status = document.getElementById('customDomainStatus');
  const addForm = document.getElementById('domainAddForm');
  const addBtn = document.getElementById('domainAddBtn');
  if (status) status.textContent = '';

  let match;
  try {
    match = normalizeCustomDomainMatch(host);
  } catch (e) {
    if (status) status.textContent = e.message;
    return;
  }
  if (!match) {
    if (status) status.textContent = 'Enter a hostname or URL.';
    return;
  }
  const hostname = matchToHost(match);

  // Persist env metadata first — it doesn't need permission.
  const meta = await loadDomainsMeta();
  meta[hostname] = {
    env: env || '',                        // empty = auto-detect at read time
    label: (label || '').trim().slice(0, 24)
  };
  await saveDomainsMeta(meta);

  // For standard Halo hosts, no Chrome permission is needed — manifest already
  // grants it. For custom hosts, add to the permission list.
  if (!isHaloStandardHost(hostname)) {
    const matches = Array.isArray(customHaloMatches) ? customHaloMatches.slice() : [];
    if (!matches.includes(match)) {
      matches.push(match);
      const previousMatches = customHaloMatches.slice();
      await saveCustomHaloDomains(matches);
      if (status) status.textContent = 'Saved. Requesting Chrome permission…';
      const granted = await requestHostPermissions(matches);
      if (!granted) {
        await saveCustomHaloDomains(previousMatches);
        // Keep the meta entry — re-trying Save will pick it back up.
        if (status) status.textContent = 'Permission denied. Click "+ Add tenant" to retry.';
        renderDomainList();
        return;
      }
      await injectIntoActiveCustomDomain(matches);
    }
  }

  if (status) status.textContent = `Saved ${hostname}.`;
  if (addForm) addForm.hidden = true;
  if (addBtn) addBtn.hidden = false;
  renderDomainList();
  refreshActiveTabState();
}

async function updateDomainMeta(hostname, patch) {
  const meta = await loadDomainsMeta();
  meta[hostname] = Object.assign({}, meta[hostname] || {}, patch);
  await saveDomainsMeta(meta);
  refreshActiveTabState();
}

async function removeDomain(hostname) {
  const meta = await loadDomainsMeta();
  delete meta[hostname];
  await saveDomainsMeta(meta);

  // Remove from the Chrome permission list if it was a custom host.
  if (!isHaloStandardHost(hostname)) {
    const matches = (customHaloMatches || []).filter(m => matchToHost(m) !== hostname);
    await saveCustomHaloDomains(matches);
    try {
      await new Promise(resolve => {
        chrome.permissions.remove({ origins: [
          `https://${hostname}/*`, `http://${hostname}/*`
        ] }, () => resolve());
      });
    } catch (_) {}
  }
  renderDomainList();
  refreshActiveTabState();
}

async function renderDomainList() {
  const wrap = document.getElementById('domainListWrap');
  if (!wrap) return;
  const [matches, meta] = await Promise.all([
    loadCustomHaloDomains(),
    loadDomainsMeta()
  ]);

  // Union of: hosts from the custom-domain match list + any meta-only entries
  // (the user may also have labelled standard-apex tenants like acme.haloitsm.com).
  const hostsFromMatches = (matches || []).map(matchToHost).filter(Boolean);
  const hostsFromMeta = Object.keys(meta || {});
  const seen = new Set();
  const hosts = [];
  [...hostsFromMatches, ...hostsFromMeta].forEach(h => {
    if (h && !seen.has(h)) { seen.add(h); hosts.push(h); }
  });
  hosts.sort();

  wrap.innerHTML = '';
  if (!hosts.length) {
    wrap.innerHTML = '<div class="domain-empty">No tenants added yet. Click <strong>+ Add tenant</strong> to label one.</div>';
    return;
  }

  const detect = typeof huDetectEnvironment === 'function' ? huDetectEnvironment : () => 'unknown';
  const specs = (typeof HU_ENVIRONMENT_SPECS !== 'undefined') ? HU_ENVIRONMENT_SPECS : {};

  hosts.forEach(host => {
    const entry = meta[host] || {};
    const resolvedEnv = entry.env || detect(host);
    const spec = specs[resolvedEnv] || specs.unknown || { label: 'CUSTOM', color: '#64748b', bg: '#e2e8f0', text: '#334155' };
    const labelText = (entry.label || '').trim() || spec.label;

    const card = document.createElement('div');
    card.className = 'domain-card';
    card.innerHTML = `
      <div class="domain-card-head">
        <span class="domain-card-pill" style="background:${spec.bg};color:${spec.text};border-color:${spec.color}">${escapeHtml(labelText)}</span>
        <span class="domain-card-host">${escapeHtml(host)}</span>
        <button class="domain-card-remove" type="button" title="Remove tenant" aria-label="Remove tenant">×</button>
      </div>
      <div class="domain-card-controls">
        <label class="domain-field">
          <span class="domain-field-label">Environment</span>
          <select class="domain-env-select input-field">
            <option value="">Auto-detect (${escapeHtml((specs[detect(host)] || specs.unknown || { label: 'CUSTOM' }).label)})</option>
            <option value="prod">PROD</option>
            <option value="staging">STAGING</option>
            <option value="uat">UAT</option>
            <option value="test">TEST</option>
            <option value="sandbox">SANDBOX</option>
            <option value="dev">DEV</option>
            <option value="unknown">Custom / other</option>
          </select>
        </label>
        <label class="domain-field">
          <span class="domain-field-label">Custom label</span>
          <input class="domain-label-input input-field" type="text" value="${escapeHtml(entry.label || '')}" placeholder="(use env name)" maxlength="24">
        </label>
      </div>
    `;
    const envSelect = card.querySelector('.domain-env-select');
    const labelInput = card.querySelector('.domain-label-input');
    const removeBtn  = card.querySelector('.domain-card-remove');

    envSelect.value = entry.env || '';
    envSelect.addEventListener('change', () => {
      updateDomainMeta(host, { env: envSelect.value }).then(() => renderDomainList());
    });
    labelInput.addEventListener('change', () => {
      updateDomainMeta(host, { label: labelInput.value.trim().slice(0, 24) }).then(() => renderDomainList());
    });
    removeBtn.addEventListener('click', () => {
      if (confirm(`Remove ${host}?\nThis revokes any Chrome host permission and clears the environment label.`)) {
        removeDomain(host);
      }
    });

    wrap.appendChild(card);
  });
}

async function saveCustomHaloDomains(matches) {
  customHaloMatches = matches;
  await new Promise(resolve => chrome.storage.local.set({ [CUSTOM_DOMAINS_KEY]: matches }, resolve));
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'HU_REGISTER_CUSTOM_DOMAINS' }, () => resolve());
  });
}

function requestHostPermissions(matches) {
  return new Promise(resolve => {
    chrome.permissions.request({ origins: matches }, granted => resolve(Boolean(granted)));
  });
}

function parseCustomHaloDomainInput(value) {
  const seen = new Set();
  return String(value || '')
    .split(/\r?\n|,/)
    .map(normalizeCustomDomainMatch)
    .filter(Boolean)
    .filter(match => {
      if (seen.has(match)) return false;
      seen.add(match);
      return true;
    });
}

function normalizeCustomDomainMatch(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';

  if (/^https?:\/\/\*\.[a-z0-9.-]+$/i.test(raw)) {
    return `${raw.toLowerCase()}/*`;
  }

  if (/^\*\.[a-z0-9.-]+$/i.test(raw)) {
    return `https://${raw.toLowerCase()}/*`;
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    throw new Error(`Invalid domain: ${raw}`);
  }

  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Invalid domain: ${raw}`);
  }

  if (parsed.port) {
    throw new Error(`Chrome extensions can't grant access to a specific port. Enter "${parsed.hostname}" without ":${parsed.port}" — Chrome's permission covers the host on any port.`);
  }

  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}/*`;
}

async function injectIntoActiveCustomDomain(matches) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    return;
  }

  const tab = tabs?.[0];
  if (!tab?.id || !tab.url || !customMatchesIncludeUrl(matches, tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js']
    });
  } catch (error) {
    // The dynamic content script will run after the tab is refreshed.
  }
}

function customMatchesIncludeUrl(matches, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }

  return matches.some(match => {
    const matchUrl = match.replace(/\/\*$/, '');
    const wildcard = matchUrl.match(/^(https?:\/\/)\*\.(.+)$/i);
    if (wildcard) {
      return parsed.protocol === wildcard[1].replace('//', ':') &&
        (parsed.hostname === wildcard[2] || parsed.hostname.endsWith(`.${wildcard[2]}`));
    }

    try {
      const origin = new URL(matchUrl);
      return parsed.protocol === origin.protocol && parsed.hostname === origin.hostname;
    } catch (error) {
      return false;
    }
  });
}

async function loadPreferences() {
  const data = await new Promise(r => chrome.storage.local.get([SETTINGS_KEY], r));
  return Object.assign({
    ticket360Enabled: true,
    auto360: true,
    drawer360Push: true,
    hideHaloSidebar: false,
    doubleClickTechFields: true
  }, data[SETTINGS_KEY] || {});
}

async function savePreferences(prefs) {
  await new Promise(r => chrome.storage.local.set({ [SETTINGS_KEY]: prefs }, r));
}

function setupPreferences() {
  const enabledEl      = document.getElementById('prefTicket360Enabled');
  const auto360El      = document.getElementById('prefAuto360');
  const pushEl         = document.getElementById('prefDrawer360Push');
  const sidebarEl      = document.getElementById('prefHideHaloSidebar');
  const dblClickEl     = document.getElementById('prefDoubleClickTechFields');
  const newTabEl       = document.getElementById('prefPaletteNewTab');
  if (!enabledEl || !auto360El || !pushEl || !sidebarEl || !dblClickEl || !newTabEl) return;

  const subWrap = document.getElementById('ticket360SubPrefs');
  const applyTicket360Lock = () => {
    if (!subWrap) return;
    const off = !enabledEl.checked;
    subWrap.classList.toggle('pref-sublist-locked', off);
    subWrap.querySelectorAll('input.pref-toggle').forEach(input => {
      input.disabled = off;
    });
  };

  loadPreferences().then(prefs => {
    enabledEl.checked  = prefs.ticket360Enabled !== false;
    auto360El.checked  = !!prefs.auto360;
    pushEl.checked     = !!prefs.drawer360Push;
    sidebarEl.checked  = !!prefs.hideHaloSidebar;
    dblClickEl.checked = prefs.doubleClickTechFields !== false;
    newTabEl.checked   = !!prefs.openInNewHaloTab;
    applyTicket360Lock();
  });

  const persist = () => savePreferences({
    ticket360Enabled:      enabledEl.checked,
    auto360:               auto360El.checked,
    drawer360Push:         pushEl.checked,
    hideHaloSidebar:       sidebarEl.checked,
    doubleClickTechFields: dblClickEl.checked,
    openInNewHaloTab:      newTabEl.checked,
  });

  enabledEl.addEventListener('change', () => { applyTicket360Lock(); persist(); });
  auto360El.addEventListener('change', persist);
  pushEl.addEventListener('change', persist);
  sidebarEl.addEventListener('change', persist);
  dblClickEl.addEventListener('change', persist);
  newTabEl.addEventListener('change', persist);
}

document.addEventListener('DOMContentLoaded', init);


