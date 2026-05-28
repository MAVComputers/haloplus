/**
 * HaloPlus content script.
 * Adds in-page utilities on Halo: command palette, recent records,
 * field API overlays, JSON inspector, and report-query execution for the side panel.
 */

(function () {
  'use strict';

  const HU = {
    paletteOpen: false,
    fieldOverlayOn: false,
    jsonInspectorOpen: false,
    paletteResults: [],
    paletteGrouped: false,
    paletteShowAll: false,
    selectedIndex: 0,
    searchTimer: null,
    tableScanTimer: null,
    lastTrackedUrl: '',
    shortcuts: [],
    customCommands: [],
    recentCommands: [],
    commandHistory: [],
    historyIndex: -1,
    historyDraft: '',
    ticketTypeCommands: [],
    ticketTypeSearchMap: {},
    schemaColumnCache: {},
    impersonatedAgentId: '',
    suppressSlashUntil: 0,
    ticket360TicketId: 0,
    timelineTicketId: 0,
    theme: 'light',
    settings: { auto360: true, drawer360Push: true, hideHaloSidebar: false, ticket360Enabled: true, doubleClickTechFields: true, openInNewHaloTab: false },
    palette: { placement: 'mid', fontScale: 1 },
    review: { firstActiveAt: 0, dismissed: false, snoozeUntil: 0 },
    configTree: {},
    configDiscoveryInFlight: new Set(),
    configWarmupProgress: { current: 0, total: 0, sectionLabel: '' },
    _hidHaloMenu: false,
    permissions: null,
    permissionsReadAt: 0,
    reportApiOk: null,        // tri-state: null = unprobed, true / false = result
    reportApiError: '',
    reportApiProbedAt: 0,
    entityAccess: null,       // null = unprobed; { route: true | false | null }
    entityAccessProbedAt: 0,
    entityAccessProbeInFlight: null,
    ticketTypeCounts: {},     // { typeId: openCount } — populated lazily on palette open
    ticketTypeCountsAt: 0,
    ticketTypeCountsInFlight: null,
    ticketTypeTagsLoaded: false,   // once-per-session pre-fetch of email tag overrides
    ticketTypeTagsInFlight: null,
    ticketTypeTagsFetched: null,   // Set<typeId> — populated lazily, by typeId
    ticketTypeCountsFetched: null, // Set<typeId> — same idea for counts
    ticketTypeCountsLazyInFlight: null,
    ticketTypeTagsLazyInFlight: null,
    entityLoaderToken: 0,          // monotonic counter — cancels stale spinner timers
    openLoaderToken: 0,
    slotLabelMap: null,            // { entityKey: { 'displayLabel': 'other1', ... } } — built from /api/Languages
    slotLabelMapPromise: null,     // in-flight fetch promise; prevents duplicate downloads
    customFieldMap: {},            // { entityKey: { 'displayLabel': 'CFLastTicket', ... } } — built from /api/FieldInfo per entity
    customFieldMapPromises: {},    // { entityKey: Promise } — in-flight per-entity FieldInfo fetches
    ticketRecordPromises: {}       // { ticketId: Promise<rawRecord> } — ticket + user/site/client expanded; used for value-matching AND runtime validation of hardcoded mappings
  };

  const REVIEW_DELAY_MS = 5 * 24 * 60 * 60 * 1000;
  const REVIEW_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  const REVIEW_URL = 'https://chromewebstore.google.com/detail/haloplus/ondioamcpkphlebmeocbhjmpdodpmklp/reviews';

  // Environment label — keep these in sync with shared/constants.js. We
  // can't include shared/constants.js in the content_scripts array without
  // touching the manifest's load order; duplicating ~20 lines is cheaper
  // than the inter-file dependency.
  const ENVIRONMENT_SPECS = {
    prod:    { label: 'PROD',    color: '#dc2626', bg: '#fee2e2', text: '#7f1d1d' },
    staging: { label: 'STAGING', color: '#f59e0b', bg: '#fef3c7', text: '#78350f' },
    uat:     { label: 'UAT',     color: '#8b5cf6', bg: '#ede9fe', text: '#4c1d95' },
    test:    { label: 'TEST',    color: '#3b82f6', bg: '#dbeafe', text: '#1e3a8a' },
    sandbox: { label: 'SANDBOX', color: '#10b981', bg: '#d1fae5', text: '#064e3b' },
    dev:     { label: 'DEV',     color: '#10b981', bg: '#d1fae5', text: '#064e3b' },
    unknown: { label: 'CUSTOM',  color: '#64748b', bg: '#e2e8f0', text: '#334155' }
  };
  const HALO_HOST_RE_LOCAL = /\.(halopsa\.com|haloitsm\.com|haloservicedesk\.com)$/i;

  function detectEnvironment(hostname) {
    if (!hostname) return 'unknown';
    const h = String(hostname).toLowerCase();
    // No word boundaries — hostnames concatenate words (`pinkacademysandbox`).
    if (/(sandbox|sbx)/.test(h)) return 'sandbox';
    if (/(staging|stage|stg)/.test(h)) return 'staging';
    if (/(uat)/.test(h)) return 'uat';
    if (/(test|tst)/.test(h)) return 'test';
    if (/(devel|dev)/.test(h)) return 'dev';
    if (HALO_HOST_RE_LOCAL.test(h)) return 'prod';
    return 'unknown';
  }

  // Resolves the environment + optional custom label for a host. Uses the
  // user's saved config if present, otherwise the auto-detector. Returns
  // null only when detection comes back 'unknown' AND nothing is configured
  // — i.e. a non-Halo host with no override. That keeps random tabs
  // visually quiet while still labelling every real Halo surface.
  async function resolveHostConfig(hostname) {
    if (!hostname) return null;
    let entry = null;
    try {
      const data = await new Promise(r => chrome.storage.local.get(['huCustomDomainsMeta'], r));
      entry = (data.huCustomDomainsMeta || {})[hostname.toLowerCase()] || null;
    } catch (_) {}
    const detected = detectEnvironment(hostname);
    const envOverride = entry && entry.env && ENVIRONMENT_SPECS[entry.env] ? entry.env : '';
    const label = entry && typeof entry.label === 'string' ? entry.label.trim() : '';
    const env = envOverride || detected;
    if (env === 'unknown' && !label) return null;
    return { env, label };
  }

  function removeEnvironmentBanner() {
    const bar = document.getElementById('hu-env-bar');
    if (bar) bar.remove();
    const chip = document.getElementById('hu-env-chip');
    if (chip) chip.remove();
  }

  // Chip can be dragged to any corner. We snap to the nearest corner on
  // release rather than allowing arbitrary placement — keeps the chip
  // predictable and out of the way of page content.
  const ENV_CHIP_CORNERS = ['top-right','top-left','bottom-right','bottom-left'];
  function applyEnvChipCorner(chip, bar, corner) {
    if (!chip) return;
    // Reset corner positioning before applying the chosen corner.
    chip.style.top = '';
    chip.style.bottom = '';
    chip.style.left = '';
    chip.style.right = '';
    if (corner === 'top-left')     { chip.style.top = '6px';    chip.style.left = '12px'; }
    else if (corner === 'top-right')    { chip.style.top = '6px';    chip.style.right = '12px'; }
    else if (corner === 'bottom-left')  { chip.style.bottom = '6px'; chip.style.left = '12px'; }
    else if (corner === 'bottom-right') { chip.style.bottom = '6px'; chip.style.right = '12px'; }
    if (bar) {
      // Strip moves to the same edge as the chip so the affordance reads
      // as a unit (top vs bottom of the viewport).
      const onTop = corner.startsWith('top');
      bar.style.top = onTop ? '0' : '';
      bar.style.bottom = onTop ? '' : '0';
    }
  }

  function makeEnvChipDraggable(chip, bar) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0;
    const onPointerDown = (e) => {
      // Only respond to the primary button.
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      // Switch to free positioning while dragging.
      chip.style.transition = 'none';
      chip.style.cursor = 'grabbing';
      // Capture the pointer so we get reliable up events even if the cursor
      // leaves the chip.
      try { chip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (!moved && (dx > 3 || dy > 3)) moved = true;
      if (!moved) return;
      // Free-position the chip under the cursor (with a small offset).
      chip.style.top = '';
      chip.style.bottom = '';
      chip.style.left = '';
      chip.style.right = '';
      chip.style.top  = (e.clientY - 12) + 'px';
      chip.style.left = (e.clientX - 24) + 'px';
    };
    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      chip.style.cursor = 'grab';
      try { chip.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!moved) return;
      // Snap to the nearest corner based on the chip's centre.
      const rect = chip.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const corner = (cy < vh / 2 ? 'top' : 'bottom') + '-' + (cx < vw / 2 ? 'left' : 'right');
      applyEnvChipCorner(chip, bar, corner);
      try { chrome.storage.local.set({ huEnvChipCorner: corner }); } catch (_) {}
    };
    chip.addEventListener('pointerdown', onPointerDown);
    chip.addEventListener('pointermove', onPointerMove);
    chip.addEventListener('pointerup', onPointerUp);
    chip.addEventListener('pointercancel', onPointerUp);
  }

  function injectEnvironmentBanner(env, customLabel) {
    // A thin coloured strip at the top of the viewport plus a small corner
    // chip. Chip is draggable across the four corners so it doesn't fight
    // with Halo's own buttons.
    if (window !== window.top) return; // don't inject inside iframes
    const spec = ENVIRONMENT_SPECS[env] || ENVIRONMENT_SPECS.unknown;
    let bar = document.getElementById('hu-env-bar');
    let chip;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'hu-env-bar';
      bar.style.cssText = [
        'position:fixed','left:0','right:0','top:0','height:3px','z-index:2147483640',
        'pointer-events:none'
      ].join(';');
      chip = document.createElement('div');
      chip.id = 'hu-env-chip';
      chip.style.cssText = [
        'position:fixed','top:6px','right:12px','z-index:2147483641',
        'padding:3px 10px','border-radius:99px','font:600 10px/1.3 system-ui,-apple-system,Segoe UI,sans-serif',
        'letter-spacing:0.08em','text-transform:uppercase',
        'box-shadow:0 1px 3px rgba(0,0,0,0.15)','pointer-events:auto',
        'cursor:grab','user-select:none','touch-action:none'
      ].join(';');
      document.documentElement.appendChild(bar);
      document.documentElement.appendChild(chip);
      makeEnvChipDraggable(chip, bar);
      // Apply the saved corner if any. Default to bottom-right (out of the
      // way of Halo's top-right toolbar buttons).
      try {
        chrome.storage.local.get(['huEnvChipCorner'], data => {
          const corner = ENV_CHIP_CORNERS.includes(data && data.huEnvChipCorner)
            ? data.huEnvChipCorner : 'bottom-right';
          applyEnvChipCorner(chip, bar, corner);
        });
      } catch (_) {}
    } else {
      chip = document.getElementById('hu-env-chip');
    }
    bar.style.background = spec.color;
    if (chip) {
      chip.style.background = spec.bg;
      chip.style.color = spec.text;
      chip.style.border = '1px solid ' + spec.color;
      const label = (customLabel && String(customLabel).trim()) || spec.label;
      chip.textContent = label;
      chip.title = `HaloPlus: ${label} environment (${location.hostname}). Drag to move.` +
                   (env === 'prod' ? '\nChanges affect the real system.' : '');
    }
  }

  function refreshEnvironmentBanner() {
    resolveHostConfig(location.hostname).then(config => {
      if (!config) {
        removeEnvironmentBanner();
        return;
      }
      injectEnvironmentBanner(config.env, config.label);
    }).catch(() => {});
  }

  const ROUTES = {
    ticket:   { list: '/tickets?area=1',             detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    problem:  { list: '/tickets?area=2',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    change:   { list: '/tickets?area=3',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    request:  { list: '/tickets?area=4',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    project:  { list: '/tickets?area=7',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    hr:       { list: '/tickets?area=8',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    facility: { list: '/tickets?area=9',              detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    draft:    { list: '/tickets?area=10',             detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    mywork:   { list: '/tickets?area=12',             detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    major:    { list: '/tickets?area=13',             detail: id => `/tickets?id=${encodeURIComponent(id)}` },
    customer: { list: '/customers',                  detail: id => `/customers?clientid=${encodeURIComponent(id)}` },
    site:     { list: '/customers?mainview=site',   detail: id => `/customers?mainview=site&siteid=${encodeURIComponent(id)}` },
    agent:    { list: '/config/agents/agents',       detail: id => `/config/agents/agents?agentid=${encodeURIComponent(id)}` },
    user:     { list: '/customers?mainview=user',   detail: id => `/customers?mainview=user&userid=${encodeURIComponent(id)}` },
    team:     { list: '/config/agents/teams',       detail: id => `/config/agents/teams?teamid=${encodeURIComponent(id)}` },
    asset:    { list: '/assets',                    detail: id => `/assets?id=${encodeURIComponent(id)}` },
    kb:       { list: '/kb',                        detail: id => `/kb?id=${encodeURIComponent(id)}` },
    report:   { list: '/reports?mainview=reportgroup', detail: id => `/reports?id=${encodeURIComponent(id)}` },
    config:   { list: '/config',                     detail: id => `/config?selid=${encodeURIComponent(id)}` }
  };


  const BASE_COMMANDS = [
    // ITSM navigation
    navCommand('t',          'Tickets',           'Open the incident / ticket list',       routeList('ticket'),   ['incidents', 'tickets', 'calls'],           'ITSM'),
    navCommand('prob',       'Problems',          'Open the problem list',                 routeList('problem'),  ['problems', 'problem management', 'PIR'],    'ITSM'),
    navCommand('chg',        'Changes',           'Open the change request list',          routeList('change'),   ['changes', 'change management', 'RFC'],      'ITSM'),
    navCommand('req',        'Requests',          'Open the request ticket list',          routeList('request'),  ['requests', 'service requests'],            'ITSM'),
    navCommand('hr',         'HR',                'Open the HR ticket area',               routeList('hr'),       ['human resources'],                         'ITSM'),
    navCommand('fac',        'Facilities',        'Open the facilities ticket area',       routeList('facility'), ['facilities', 'facility', 'building'],      'ITSM'),
    navCommand('dft',        'Draft Articles',    'Open the draft articles ticket area',   routeList('draft'),    ['article drafts', 'drafts'],                'ITSM'),
    navCommand('mw',         'My Work',           'Open the My Work ticket area',          routeList('mywork'),   ['my work', 'worklist', 'my tickets'],       'ITSM'),
    navCommand('mi',         'Major Incidents',   'Open the major incidents ticket area',  routeList('major'),    ['major incidents', 'major incident'],       'ITSM'),
    // People
    navCommand('c',          'Customers',         'Open customers / clients',              routeList('customer'), ['customers', 'clients', 'organisations', 'organizations'],'People'),
    navCommand('a',          'Agents',            'Open agents / technicians',             routeList('agent'),    ['agents', 'technicians', 'staff'],          'People'),
    navCommand('u',          'Users',             'Open end-user contacts',                routeList('user'),     ['users', 'contacts', 'end users'],          'People'),
    navCommand('team',       'Teams',             'Open agent teams',                      routeList('team'),     ['teams', 'groups'],                         'People'),
    navCommand('s',          'Sites',             'Open sites and locations',              routeList('site'),     ['sites', 'locations', 'offices', 'branches'],'People'),
    // Assets & Knowledge
    navCommand('asset',      'Assets',            'Open the asset / CI list',              routeList('asset'),    ['assets', 'devices', 'CIs', 'hardware', 'inventory'], 'Assets'),
    navCommand('kb',         'Knowledge Base',    'Open the knowledge base',               routeList('kb'),       ['articles', 'FAQ', 'knowledgebase'],        'Knowledge'),
    // Projects
    navCommand('prj',        'Projects',          'Open the project ticket area',          routeList('project'),  ['projects', 'project management'],          'Projects'),
    // Config & Reports
    navCommand('cfg',        'Configuration',     'Open Halo configuration',               '/config',             ['config', 'settings', 'admin', 'setup'],     'Config'),
    navCommand('rep',        'Reports',           'Open reports',                          '/reports?mainview=reportgroup', ['reports', 'reporting', 'sql', 'analytics'], 'Config'),
    // Commands
    command('r',             'Recent records',    'Open the last 20 Halo records you visited', showRecentPanel,       ['recent', 'history', 'jump back']),
    command('360',           'Ticket 360',        'Open a full ticket context panel for the current ticket', openTicket360Panel, ['ticket360', 'ticket context', 'ticket summary', 'overview']),
    command('tl',            'Action timeline',   'Show recent actions and communication for the current ticket', openActionTimelinePanel, ['timeline', 'actions', 'history', 'updates']),
    command('f',             'Toggle field API names', 'Show or hide API names beside form labels', toggleFieldOverlay, ['fields', 'api names', 'field overlay']),
    command('j',             'Inspect record JSON', 'Open raw record data and copy to clipboard', openJsonInspector,   ['json', 'payload', 'raw', 'api']),
    command('api',           'API reference',     'Browse all Halo REST API endpoints',    showApiReference,      ['rest', 'endpoints', 'developer', 'docs']),
    command('imp',           'Impersonate agent', 'Type /imp followed by an agent name or ID', runImpersonationCommand, ['act as', 'switch user', 'agent']),
    command('xi',            'Exit impersonation','Switch back from the impersonated Halo session', exitImpersonation, ['exitimp', 'switchback', 'stop impersonating']),
    command('h',             'HaloPlus help',    'Show command palette tips and available commands', showHelpPanel,   ['help', 'keyboard', 'shortcuts', 'commands']),
    command('sc',            'Add shortcut',      'Save this page as a palette shortcut',  addCurrentPageShortcut,['shortcut', 'favorite', 'bookmark']),
    command('rs',            'Reload shortcuts',  'Refresh user-defined shortcuts from storage', loadShortcuts,   ['reload shortcuts', 'refresh'])
  ];

  const COMMAND_ALIASES = {
    i: 't'
  };

  const ENTITY_COMMAND_IDS = {
    t: 't',
    i: 't',
    prob: 'prob',
    chg: 'chg',
    req: 'req',
    hr: 'hr',
    fac: 'fac',
    dft: 'dft',
    mw: 'mw',
    mi: 'mi',
    prj: 'prj',
    c: 'c',
    client: 'c',
    clients: 'c',
    org: 'c',
    orgs: 'c',
    organisation: 'c',
    organisations: 'c',
    organization: 'c',
    organizations: 'c',
    a: 'a',
    u: 'u',
    s: 's',
    team: 'team',
    k: 'kb',
    kb: 'kb',
    asset: 'asset',
    inv: 'invoices',
    q: 'quotes',
    po: 'purchases',
    rep: 'rep'
  };
  // Maps command keywords to the entity search and navigation definition.
  const ENTITY_SEARCH_MAP = {
    incident:  { commandId: 'incidents', kind: 'Incident',   route: 'ticket',   table: 'faults',  id: 'Faultid',  title: 'Symptom',   sub: 'Username',  extraCols: ['AAreaDesc'],                                          searchCols: ['Symptom', 'Username'], optionalSearchCols: ['Symptom2', 'FDescription'], ticketPrefix: 'IN', typeMatch: ['incident'] },
    incidents: { commandId: 'incidents', kind: 'Incident',   route: 'ticket',   table: 'faults',  id: 'Faultid',  title: 'Symptom',   sub: 'Username',  extraCols: ['AAreaDesc'],                                          searchCols: ['Symptom', 'Username'], optionalSearchCols: ['Symptom2', 'FDescription'], ticketPrefix: 'IN', typeMatch: ['incident'] },
    ticket:    { commandId: 'incidents', kind: 'Ticket',     route: 'ticket',   table: 'faults',  id: 'Faultid',  title: 'Symptom',   sub: 'Username',  extraCols: ['AAreaDesc'],                                          searchCols: ['Symptom', 'Username'], optionalSearchCols: ['Symptom2', 'FDescription'], ticketPrefix: 'IN' },
    tickets:   { commandId: 'incidents', kind: 'Ticket',     route: 'ticket',   table: 'faults',  id: 'Faultid',  title: 'Symptom',   sub: 'Username',  extraCols: ['AAreaDesc'],                                          searchCols: ['Symptom', 'Username'], optionalSearchCols: ['Symptom2', 'FDescription'], ticketPrefix: 'IN' },
    customer:      { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    customers:     { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    client:        { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    clients:       { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    org:           { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    orgs:          { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    organisation:  { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    organisations: { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    organization:  { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    organizations: { commandId: 'customers', kind: 'Customer',   route: 'customer', table: 'area',    id: 'AArea',    title: 'AAreaDesc', sub: '\'\'',     extraCols: [],                                                     searchCols: ['AAreaDesc'], optionalSearchCols: ['AMemo'], combineWith: ['user'] },
    agent:     { commandId: 'agents',    kind: 'Agent',      route: 'agent',    table: 'uname',   id: 'UNum',     title: 'UName',     sub: 'USMTP',     extraCols: [],                                                     searchCols: ['UName', 'USMTP'] },
    agents:    { commandId: 'agents',    kind: 'Agent',      route: 'agent',    table: 'uname',   id: 'UNum',     title: 'UName',     sub: 'USMTP',     extraCols: [],                                                     searchCols: ['UName', 'USMTP'] },
    user:      { commandId: 'customers', kind: 'End user',   route: 'user',     table: 'users',   id: 'uid',      title: 'UUsername', sub: 'UEmail',    extraCols: [],                                                     searchCols: ['UUsername', 'UEmail'], combineWith: ['customer'] },
    users:     { commandId: 'customers', kind: 'End user',   route: 'user',     table: 'users',   id: 'uid',      title: 'UUsername', sub: 'UEmail',    extraCols: [],                                                     searchCols: ['UUsername', 'UEmail'], combineWith: ['customer'] },
    asset:     { commandId: 'assets',    kind: 'Asset',      route: 'asset',    table: 'device',  id: 'DID',      title: 'DInvNo',    sub: 'DID',       extraCols: [],                                                     searchCols: ['DInvNo'], optionalSearchCols: ['DDesc'] },
    assets:    { commandId: 'assets',    kind: 'Asset',      route: 'asset',    table: 'device',  id: 'DID',      title: 'DInvNo',    sub: 'DID',       extraCols: [],                                                     searchCols: ['DInvNo'], optionalSearchCols: ['DDesc'] },
    kb:        { commandId: 'kb',        kind: 'KB Article', route: 'kb',       table: 'kbentry', id: 'id',       title: 'Abstract',  sub: '\'\'',     extraCols: [],                                                     searchCols: ['Abstract'], optionalSearchCols: ['Description', 'Resolution'] },
    knowledge: { commandId: 'kb',        kind: 'KB Article', route: 'kb',       table: 'kbentry', id: 'id',       title: 'Abstract',  sub: '\'\'',     extraCols: [],                                                     searchCols: ['Abstract'], optionalSearchCols: ['Description', 'Resolution'] },
    invoice:   { commandId: 'invoices',  kind: 'Invoice',    route: 'invoice',  table: 'invoiceheader', id: 'ihid', title: 'IH3rdPartyInvoiceNumber', sub: 'IHname', searchCols: ['IH3rdPartyInvoiceNumber', 'IHname'] },
    invoices:  { commandId: 'invoices',  kind: 'Invoice',    route: 'invoice',  table: 'invoiceheader', id: 'ihid', title: 'IH3rdPartyInvoiceNumber', sub: 'IHname', searchCols: ['IH3rdPartyInvoiceNumber', 'IHname'] },
    quote:     { commandId: 'quotes',    kind: 'Quote',      route: 'quote',    table: 'quotationheader', id: 'qhid', title: 'QHtitle', sub: 'QHPORef', searchCols: ['QHtitle', 'QHPORef'] },
    quotes:    { commandId: 'quotes',    kind: 'Quote',      route: 'quote',    table: 'quotationheader', id: 'qhid', title: 'QHtitle', sub: 'QHPORef', searchCols: ['QHtitle', 'QHPORef'] },
    purchase:  { commandId: 'purchases', kind: 'Purchase Order', route: 'purchase', table: 'supplierorderheader', id: 'SHid', title: 'SHtitle', sub: 'SHPORef', searchCols: ['SHtitle', 'SHPORef'] },
    purchases: { commandId: 'purchases', kind: 'Purchase Order', route: 'purchase', table: 'supplierorderheader', id: 'SHid', title: 'SHtitle', sub: 'SHPORef', searchCols: ['SHtitle', 'SHPORef'] },
    po:        { commandId: 'purchases', kind: 'Purchase Order', route: 'purchase', table: 'supplierorderheader', id: 'SHid', title: 'SHtitle', sub: 'SHPORef', searchCols: ['SHtitle', 'SHPORef'] }
  };

  Object.assign(ENTITY_SEARCH_MAP, {
    i: ENTITY_SEARCH_MAP.incident,
    t: ENTITY_SEARCH_MAP.ticket,
    prob: { ...ENTITY_SEARCH_MAP.ticket, commandId: 'prob', kind: 'Problem',      ticketPrefix: 'PR', typeMatch: ['problem'] },
    chg:  { ...ENTITY_SEARCH_MAP.ticket, commandId: 'chg',  kind: 'Change',       ticketPrefix: 'CH', typeMatch: ['change'] },
    req:  { ...ENTITY_SEARCH_MAP.ticket, commandId: 'req',  kind: 'Request',      ticketPrefix: 'RQ', typeMatch: ['request', 'service'] },
    hr:   { ...ENTITY_SEARCH_MAP.ticket, commandId: 'hr',   kind: 'HR',           ticketPrefix: 'HR', sectionMatch: ['hr', 'human resource'] },
    fac:  { ...ENTITY_SEARCH_MAP.ticket, commandId: 'fac',  kind: 'Facilities',   ticketPrefix: 'FA', sectionMatch: ['facilit'] },
    dft:  { ...ENTITY_SEARCH_MAP.ticket, commandId: 'dft',  kind: 'Draft Article',ticketPrefix: 'DR', typeMatch: ['article', 'draft', 'knowledge'] },
    mw:   { ...ENTITY_SEARCH_MAP.ticket, commandId: 'mw',   kind: 'My Work',      ticketPrefix: 'MW', assignedToMe: true },
    mi:   { ...ENTITY_SEARCH_MAP.ticket, commandId: 'mi',   kind: 'Major Incident', ticketPrefix: 'MI', typeMatch: ['major incident', 'major'] },
    prj:  { ...ENTITY_SEARCH_MAP.ticket, commandId: 'prj',  kind: 'Project',      ticketPrefix: 'PJ', typeMatch: ['project'] },
    c: ENTITY_SEARCH_MAP.customer,
    a: ENTITY_SEARCH_MAP.agent,
    u: ENTITY_SEARCH_MAP.user,
    k: ENTITY_SEARCH_MAP.kb,
    inv: ENTITY_SEARCH_MAP.invoice,
    q: ENTITY_SEARCH_MAP.quote,
    site: { commandId: 'sites', kind: 'Site', route: 'site', table: 'site', id: 'SSitenum', title: 'SDesc', sub: 'ISNULL((SELECT AAreaDesc FROM area WHERE AArea = site.SArea), \'\')', searchCols: ['SDesc'] },
    sites: { commandId: 'sites', kind: 'Site', route: 'site', table: 'site', id: 'SSitenum', title: 'SDesc', sub: 'ISNULL((SELECT AAreaDesc FROM area WHERE AArea = site.SArea), \'\')', searchCols: ['SDesc'] },
    s: { commandId: 'sites', kind: 'Site', route: 'site', table: 'site', id: 'SSitenum', title: 'SDesc', sub: 'ISNULL((SELECT AAreaDesc FROM area WHERE AArea = site.SArea), \'\')', searchCols: ['SDesc'] }
    ,
    team: { commandId: 'team', kind: 'Team', route: 'team', table: 'sectiondetail', id: 'SDid', title: 'SDSectionName', sub: 'SDDepartmentid', searchCols: ['SDSectionName'] },
    rep: { commandId: 'rep', kind: 'Report', route: 'report', table: 'report', id: 'rid', title: 'rname', sub: 'rdesc', searchCols: ['rname', 'rdesc'] }
  });

  // Maps each ENTITY_SEARCH_MAP routeType to the Halo /api/<entity> endpoint.
  // Used by searchEntityViaApi to replace /api/Report-based SQL searches with
  // permission-respecting entity-API calls (work for non-admin agents).
  // Each entry lists candidate response field names for title/subtitle so the
  // renderer copes with Halo's inconsistent shapes across entity types.
  const ENTITY_API_CONFIG = {
    ticket:   { path: '/api/tickets',         listKey: 'tickets',       titleFields: ['summary'],                    subtitleFields: ['user_name', 'client_name'] },
    customer: { path: '/api/client',          listKey: 'clients',       titleFields: ['name'],                        subtitleFields: ['phonenumber', 'website'] },
    agent:    { path: '/api/agent',           listKey: null,             titleFields: ['name'],                        subtitleFields: ['email', 'jobtitle', 'team'] },
    user:     { path: '/api/users',           listKey: 'users',          titleFields: ['name', 'firstname'],          subtitleFields: ['emailaddress', 'email', 'phonenumber'] },
    asset:    { path: '/api/asset',           listKey: 'assets',         titleFields: ['inventory_number', 'name'],   subtitleFields: ['name', 'assettype_name'] },
    kb:       { path: '/api/KBArticle',       listKey: 'articles',       titleFields: ['name', 'title', 'abstract'],  subtitleFields: ['description'] },
    invoice:  { path: '/api/invoice',         listKey: 'invoices',       titleFields: ['third_party_reference', 'invoicenumber', 'name'], subtitleFields: ['name', 'client_name'] },
    quote:    { path: '/api/quotation',       listKey: 'quotes',         titleFields: ['title', 'name'],              subtitleFields: ['client_name', 'reference'] },
    purchase: { path: '/api/purchaseorder',   listKey: 'purchaseorders', titleFields: ['title', 'name'],              subtitleFields: ['supplier_name', 'reference'] },
    site:     { path: '/api/site',            listKey: 'sites',          titleFields: ['name'],                        subtitleFields: ['client_name'] },
    team:     { path: '/api/team',            listKey: 'teams',          titleFields: ['name'],                        subtitleFields: ['department_name', 'department'] }
  };

  function pickField(record, fieldNames) {
    for (const name of fieldNames || []) {
      const v = record && record[name];
      if (v == null) continue;
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'object') {
        const nested = v.name || v.shortname || v.text;
        if (nested) return nested;
      }
    }
    return '';
  }

  // Entity-API search: GET /api/<entity>?search=<term>&count=N. Works for
  // non-admin agents because each entity endpoint enforces its own view
  // permission (the agent's "can view tickets/customers/etc." rights).
  async function searchEntityViaApi(def, searchTerm) {
    const config = ENTITY_API_CONFIG[def.route];
    if (!config) return null;  // No API mapping — caller will fall back to SQL

    // Scoped commands filter ticket results client-side. Fetch a bigger
    // candidate set so the filter has enough rows to find matches.
    const hasSectionFilter = Array.isArray(def.sectionMatch) && def.sectionMatch.length > 0;
    const hasTypeFilter    = Array.isArray(def.typeMatch)    && def.typeMatch.length > 0;
    const hasTypeIdFilter  = def.typeId != null;
    const needsAssignedToMe = !!def.assignedToMe;
    const isNumericTerm = !!(searchTerm && /^\d+$/.test(String(searchTerm).trim()));
    const isTicketRoute = def.route === 'ticket';
    const needsBigFetch = hasSectionFilter || hasTypeFilter || hasTypeIdFilter ||
                          needsAssignedToMe || isNumericTerm;
    const fetchCount = needsBigFetch ? 200 : 20;

    // For numeric ticket searches, Halo's `?search=` doesn't reliably match
    // partial IDs ("30" → ticket #3079). Skip the server-side search and
    // filter client-side instead. For non-numeric or non-ticket searches,
    // keep the server-side `?search=` (faster + finds older records).
    const params = new URLSearchParams();
    const useServerSearch = !!searchTerm && !(isNumericTerm && isTicketRoute);
    if (useServerSearch) params.set('search', String(searchTerm));
    params.set('count', String(fetchCount));
    // Server-side type filter for custom ticket types — Halo's actual filter
    // param is `requesttype` (verified by probing; tickettype_ids et al. are
    // silently ignored). Client-side typeId filter below is still applied as
    // belt-and-braces.
    if (hasTypeIdFilter && isTicketRoute) params.set('requesttype', String(def.typeId));
    // Open-only mode is set when the agent clicks the open-count badge — the
    // scope then returns just the open tickets, newest first.
    if (def.openOnly && isTicketRoute) {
      params.set('open_only', 'true');
      params.set('order', 'id');
      params.set('orderdesc', 'true');
    }

    const response = await haloApiRequest(`${config.path}?${params.toString()}`);
    let records = extractEntityList(response, config.listKey);

    // Numeric ticket search: filter the broad fetch by ID-contains
    if (isNumericTerm && isTicketRoute) {
      const needle = String(searchTerm).trim();
      const filtered = records.filter(r => String(r.id || '').includes(needle));
      // Always try the exact ID lookup as a top hit (covers older tickets
      // outside the 200 recent results).
      try {
        const exact = await haloApiRequest(`${config.path}/${Number(needle)}`);
        if (exact && exact.id != null) {
          const byId = new Map();
          [exact, ...filtered].forEach(r => byId.set(String(r.id), r));
          records = Array.from(byId.values());
        } else {
          records = filtered;
        }
      } catch (e) {
        records = filtered;
      }
    }

    const valueText = v => v == null
      ? ''
      : (typeof v === 'object' ? (v.name || v.shortname || v.text || '') : String(v));

    // /api/tickets?count=N (list view) returns IDs only for type/team/etc — no
    // *_name fields. Resolve via Halo's localStorage caches (cache_tickettype,
    // cache_team, cache_status) so filters and subtitles can match by name +
    // pick up Halo's per-status colour for the result pill.
    const typeCache = readHaloCacheLookup('cache_tickettype');
    const teamCache = readHaloCacheLookup('cache_team');
    const statusCache = readHaloCacheLookup('cache_status');
    const lookupStatus = r => {
      if (!statusCache || r.status_id == null) return null;
      const row = statusCache.get(Number(r.status_id));
      if (!row) return null;
      // Halo's status records carry the chip colour under various keys depending
      // on tenant version. Take the first non-empty.
      const colour = row.colour || row.color || row.chip_color || row.status_colour || '';
      return { name: row.name || row.label || '', colour };
    };
    const lookupTypeName = r => {
      if (r.tickettype && typeof r.tickettype === 'object') return r.tickettype.name || '';
      if (r.tickettype_name) return String(r.tickettype_name);
      if (r.tickettype_id != null && typeCache) {
        const row = typeCache.get(Number(r.tickettype_id));
        if (row) return row.name || '';
      }
      return '';
    };
    const lookupTeamInfo = r => {
      if (r.team_id != null && teamCache) {
        const row = teamCache.get(Number(r.team_id));
        if (row) return { name: row.name || '', department: row.department_name || '' };
      }
      return { name: valueText(r.team), department: valueText(r.department_name) };
    };

    if (hasSectionFilter) {
      const needles = def.sectionMatch.map(s => String(s || '').toLowerCase());
      records = records.filter(r => {
        const team = lookupTeamInfo(r);
        const hay = [
          team.name, team.department,
          r.section_name, r.section,
          lookupTypeName(r) // Halo often models HR/Facilities as ticket types, not teams
        ].map(valueText).join(' | ').toLowerCase();
        return needles.some(n => hay.includes(n));
      });
    }

    if (hasTypeFilter) {
      const needles = def.typeMatch.map(s => String(s || '').toLowerCase());
      records = records.filter(r => {
        const hay = [lookupTypeName(r), valueText(r.requesttype), valueText(r.type), valueText(r.kind)]
          .join(' | ').toLowerCase();
        return needles.some(n => hay.includes(n));
      });
    }

    // Custom ticket types from HU.ticketTypeSearchMap carry the numeric typeId
    // instead of a name-match array. Filter by numeric ID — covers cases where
    // the server ignored `tickettype_ids` (also defends against mis-keyed
    // records whose tickettype field uses a non-standard shape).
    if (hasTypeIdFilter) {
      const wantedId = Number(def.typeId);
      records = records.filter(r => {
        const id = r.tickettype_id != null ? r.tickettype_id
                 : (r.tickettype && typeof r.tickettype === 'object' ? r.tickettype.id : null);
        return id != null && Number(id) === wantedId;
      });
    }

    if (needsAssignedToMe) {
      // The current agent's ID comes from Halo's localStorage. P_currloggedonuser
      // is the parent agent (real logged-in user); currloggedonuser may differ
      // during impersonation.
      const myId = Number(localStorage.getItem('P_currloggedonuser')
                        || localStorage.getItem('currloggedonuser') || 0);
      if (myId) {
        records = records.filter(r => Number(r.agent_id) === myId);
      }
    }

    if (needsBigFetch) records = records.slice(0, 20);

    return records.map(record => {
      // Try canonical id fields first, then route-specific aliases. Halo's
      // /api/<entity> list responses are inconsistent — some return `id`,
      // others use entity-prefixed names like `kbentry_id` or `entry_id`.
      const id = record.id != null ? record.id
               : record.uid != null ? record.uid
               : record.kbentry_id != null ? record.kbentry_id
               : record.entry_id != null ? record.entry_id
               : record.kbarticle_id != null ? record.kbarticle_id
               : record.kb_id != null ? record.kb_id
               : null;
      if (id == null) return null;
      const rawTitle = pickField(record, config.titleFields) || `${def.kind} ${id}`;

      // Tickets get a richer subtitle: user + client (de-duped). The ticket
      // type renders separately as a chip alongside the status pill so it's
      // visually distinct and consistent across results.
      let rawSubtitle;
      let ticketTypeName = '';
      if (def.route === 'ticket') {
        ticketTypeName = String(lookupTypeName(record) || '').trim();
        const parts = [
          valueText(record.user_name) || valueText(record.user),
          valueText(record.client_name)
        ].map(s => String(s || '').trim()).filter(Boolean);
        rawSubtitle = Array.from(new Set(parts)).slice(0, 2).join(' · ');
      } else if (def.route === 'kb') {
        // KB: show category (Halo uses several field names depending on tenant
        // config — FAQ list vs Category) alongside a short description snippet.
        const category = pickField(record, [
          'faqlist_name', 'faq_list_name', 'kb_category', 'category_name',
          'category_1_display', 'category_1', 'kbcategory_name'
        ]);
        const description = pickField(record, ['description', 'abstract']);
        const parts = [category, description].map(s => String(s || '').trim()).filter(Boolean);
        rawSubtitle = Array.from(new Set(parts)).slice(0, 2).join(' · ');
      } else {
        rawSubtitle = pickField(record, config.subtitleFields);
      }

      const status = def.route === 'ticket' ? lookupStatus(record) : null;

      return {
        id,
        recordId: id,
        title: formatSearchResultTitle(def, { id, title: rawTitle }),
        subtitle: String(rawSubtitle || '').trim() || `${def.kind} #${id}`,
        kind: def.kind,
        type: 'navigate',
        status,
        ticketType: ticketTypeName || undefined,
        url: new URL(routeDetail(def.routeType || def.route, id), window.location.origin).href
      };
    }).filter(Boolean);
  }

  // Probe each entity API once on init so the palette can grey out commands
  // the agent's Halo role doesn't grant access to (e.g. /api/quotation may
  // 403 for a basic tier). Result is cached for the session; role changes
  // are rare and reload picks up a fresh probe.
  async function probeEntityAccess() {
    if (HU.entityAccessProbeInFlight) return HU.entityAccessProbeInFlight;

    const inflight = (async () => {
      const routes = Object.keys(ENTITY_API_CONFIG);
      const probes = await Promise.all(routes.map(async route => {
        const cfg = ENTITY_API_CONFIG[route];
        try {
          await haloApiRequest(`${cfg.path}?count=1`);
          return [route, true];
        } catch (e) {
          // 401/403/permission → definitively no access. Other failures
          // (network, 500) → null = "unknown, don't gate."
          const msg = String(e && e.message || '').toLowerCase();
          const forbidden = msg.includes('401') || msg.includes('403') ||
                            msg.includes('forbidden') || msg.includes('unauthorized') ||
                            msg.includes('permission');
          return [route, forbidden ? false : null];
        }
      }));
      HU.entityAccess = Object.fromEntries(probes);
      HU.entityAccessProbedAt = Date.now();
      return HU.entityAccess;
    })();

    HU.entityAccessProbeInFlight = inflight;
    try {
      return await inflight;
    } finally {
      HU.entityAccessProbeInFlight = null;
    }
  }

  // Audit candidates not yet wired into the app — probed on demand from the
  // Diagnostics card so we know which endpoints are reachable for this
  // tenant + agent role before investing UI work.
  const EXTENDED_PROBE_TARGETS = [
    { path: '/api/Agent/me',                                          purpose: 'Replace token-claim probing with first-party identity' },
    { path: '/api/Search?search=test&count_per_entity=2',             purpose: 'Universal search — palette upgrade' },
    { path: '/api/ViewColumns?type=1',                                purpose: 'Authoritative list-column labels (SQL↔API bridge)' },
    { path: '/api/tickets?count=1&includecolumns=true',               purpose: 'Embedded column labels on tickets list' },
    { path: '/api/PopupNote?showall=true',                            purpose: 'Popup notes for 360 card (VIP / contract warnings)' },
    { path: '/api/FaultViewLog',                                      purpose: '"Viewed by" trail for tickets' },
    { path: '/api/Notifications?count=5',                             purpose: 'In-app notification feed (palette badge)' },
    { path: '/api/Feed?count=5',                                      purpose: 'Followed-record activity feed' },
    { path: '/api/HaloField',                                         purpose: 'Undocumented field metadata — probe to confirm shape' },
    { path: '/api/Field?kind=ticket',                                  purpose: 'Entity field definitions' }
  ];

  async function runExtendedProbes() {
    const results = await Promise.all(EXTENDED_PROBE_TARGETS.map(async target => {
      const start = Date.now();
      try {
        const data = await haloApiRequest(target.path);
        const ms = Date.now() - start;
        let shape = '';
        if (data && typeof data === 'object') {
          if (Array.isArray(data)) {
            shape = `array(${data.length})`;
          } else {
            const topKeys = Object.keys(data).slice(0, 4).join(', ');
            shape = topKeys ? `{${topKeys}${Object.keys(data).length > 4 ? ', …' : ''}}` : '{}';
          }
        } else if (data == null) {
          shape = 'null';
        } else {
          shape = typeof data;
        }
        return { path: target.path, purpose: target.purpose, status: 'ok', ms, shape };
      } catch (e) {
        const ms = Date.now() - start;
        const msg = String(e && e.message || '');
        const lower = msg.toLowerCase();
        let status = 'unknown';
        let httpCode = '';
        const codeMatch = msg.match(/\b(4\d\d|5\d\d)\b/);
        if (codeMatch) httpCode = codeMatch[1];
        if (lower.includes('401') || lower.includes('unauthorized')) status = 'unauthorized';
        else if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission')) status = 'forbidden';
        else if (lower.includes('404') || lower.includes('not found')) status = 'notfound';
        else if (codeMatch) status = 'error';
        return { path: target.path, purpose: target.purpose, status, ms, httpCode, error: msg };
      }
    }));
    return { results, probedAt: new Date().toISOString() };
  }

  // BASE_COMMAND.id → entity-API route via ENTITY_SEARCH_MAP, falling back to
  // tenant-defined ticket types in HU.ticketTypeSearchMap so custom types
  // (e.g. "marketing-request") grey out together with /t when ticket access
  // is revoked. Returns null for commands that aren't entity-backed.
  function entityRouteForCommandId(commandId) {
    if (!commandId) return null;
    const def = ENTITY_SEARCH_MAP[commandId] || HU.ticketTypeSearchMap[commandId];
    return (def && def.route) || null;
  }

  function isEntityCommandDisabled(commandId) {
    if (!HU.entityAccess) return false;  // unprobed → don't gate
    const route = entityRouteForCommandId(commandId);
    if (!route) return false;
    return HU.entityAccess[route] === false;
  }

  function entityDisabledTooltip(commandId) {
    const def = ENTITY_SEARCH_MAP[commandId];
    const kind = (def && def.kind) || 'this record type';
    return `Your Halo role doesn't allow viewing ${String(kind).toLowerCase()}.`;
  }

  // Lazy version: fetch email-tag overrides only for the typeIds the caller
  // asks about (typically the typeIds currently rendered in the palette).
  // Skips IDs we've already attempted this session. The bulk /api/TicketType
  // endpoint redacts these fields for non-admin agents, so we have to hit
  // /api/TicketType/{id}?includedetails=true per type — but only when needed.
  async function enrichTicketTypeTags(requestedTypeIds) {
    if (!HU.ticketTypeTagsFetched) HU.ticketTypeTagsFetched = new Set();

    // Default to all known custom-type IDs if no list was given (back-compat
    // for callers that still want the eager behaviour).
    const sourceIds = Array.isArray(requestedTypeIds)
      ? requestedTypeIds
      : HU.ticketTypeCommands.map(c => c.typeId);

    const targets = sourceIds
      .map(Number)
      .filter(id => Number.isFinite(id) && !HU.ticketTypeTagsFetched.has(id));

    if (!targets.length) return;

    // Mark all targets as in-flight up front so concurrent calls don't double-fetch.
    targets.forEach(id => HU.ticketTypeTagsFetched.add(id));

    // Find searchMap defs that lack emailTag and ARE in our target list.
    const queue = [];
    Object.values(HU.ticketTypeSearchMap).forEach(def => {
      if (!def || def.typeId == null || def.emailTag) return;
      if (targets.includes(Number(def.typeId))) queue.push(def);
    });
    if (!queue.length) return;

    const concurrency = 4;
    for (let i = 0; i < queue.length; i += concurrency) {
      const batch = queue.slice(i, i + concurrency);
      await Promise.all(batch.map(async def => {
        try {
          const detail = await haloApiRequest(
            `/api/TicketType/${encodeURIComponent(def.typeId)}?includedetails=true`
          );
          const start = detail && detail.email_start_tag_override;
          const end = (detail && detail.email_end_tag_override) || ']';
          if (start) {
            def.emailTag = { start, end };
            def.ticketPrefix = null;  // emailTag wins over the generated 2-letter prefix
          }
        } catch (_) {
          // type stays with the generated prefix; not fatal
        }
      }));
    }
  }

  // For a built-in scoped command (/prob, /chg, /req, /hr, etc.), find which
  // typeIds in cache_tickettype match its typeMatch / sectionMatch needles.
  // Used to sum per-type counts into a single number for the command's chip.
  function getTypeIdsForBuiltinCommand(commandId) {
    const def = ENTITY_SEARCH_MAP[commandId];
    if (!def) return [];
    const sectionNeedles = (def.sectionMatch || []).map(s => String(s).toLowerCase());
    const typeNeedles    = (def.typeMatch    || []).map(s => String(s).toLowerCase());
    if (!sectionNeedles.length && !typeNeedles.length) return null;  // null = "all"
    const cache = readHaloCacheLookup('cache_tickettype');
    if (!cache) return [];
    const ids = [];
    cache.forEach((row, id) => {
      const hay = String(row.name || '').toLowerCase();
      const match = typeNeedles.some(n => hay.includes(n)) ||
                    sectionNeedles.some(n => hay.includes(n));
      if (match) ids.push(id);
    });
    return ids;
  }

  // Resolve a command's open-ticket count from HU.ticketTypeCounts. Returns
  // undefined when no count can be computed (e.g. counts haven't loaded yet,
  // or the command isn't ticket-scoped, or it's /mw which filters by agent).
  // Also returns undefined for 0 — a "0 open" chip is more noise than signal.
  function getCommandOpenCount(commandId) {
    if (!HU.ticketTypeCounts || !Object.keys(HU.ticketTypeCounts).length) return undefined;
    let count;
    // Custom ticket type: direct typeId lookup.
    const ttDef = HU.ticketTypeSearchMap[commandId];
    if (ttDef && ttDef.typeId != null) {
      count = HU.ticketTypeCounts[ttDef.typeId];
    } else {
      // Built-in scoped ticket command: sum counts for all matching typeIds.
      const builtinDef = ENTITY_SEARCH_MAP[commandId];
      if (builtinDef && builtinDef.route === 'ticket' && !builtinDef.assignedToMe) {
        const ids = getTypeIdsForBuiltinCommand(commandId);
        if (ids === null) {
          // No type/section filter (/t, /tickets): sum across ALL types.
          count = Object.values(HU.ticketTypeCounts).reduce((a, b) => a + Number(b || 0), 0);
        } else if (ids.length) {
          count = ids.reduce((sum, id) => sum + Number(HU.ticketTypeCounts[id] || 0), 0);
        }
      }
    }
    return count > 0 ? count : undefined;
  }

  // Lazy version: fetch open-ticket counts only for the typeIds the caller
  // passes in (typically the typeIds currently rendered in the palette). IDs
  // already fetched this session are skipped. Result is merged into the
  // existing HU.ticketTypeCounts map so subsequent renders pick up the chip.
  async function refreshTicketTypeCounts(requestedTypeIds) {
    if (!HU.ticketTypeCountsFetched) HU.ticketTypeCountsFetched = new Set();

    const sourceIds = Array.isArray(requestedTypeIds)
      ? requestedTypeIds
      : HU.ticketTypeCommands.map(c => c.typeId);

    const targets = sourceIds
      .map(Number)
      .filter(id => Number.isFinite(id) && !HU.ticketTypeCountsFetched.has(id));

    if (!targets.length) return HU.ticketTypeCounts;

    // Mark all as in-flight up front so concurrent calls don't double-fetch.
    targets.forEach(id => HU.ticketTypeCountsFetched.add(id));

    const concurrency = 3;
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.all(batch.map(async typeId => {
        try {
          // Halo's filter param for /api/tickets is `requesttype` (verified
          // by probing). `pageinate=true` makes record_count reflect the
          // true total instead of echoing page_size.
          const res = await haloApiRequest(
            `/api/tickets?requesttype=${encodeURIComponent(typeId)}` +
            `&open_only=true&pageinate=true&page_no=1&page_size=1`
          );
          const n = res && res.record_count;
          if (n != null && Number.isFinite(Number(n))) HU.ticketTypeCounts[typeId] = Number(n);
        } catch (_) {
          // ignore — counter just doesn't render for this type
        }
      }));
    }
    HU.ticketTypeCountsAt = Date.now();
    return HU.ticketTypeCounts;
  }

  // Build the list of typeIds that should be fetched for the commands the
  // palette is currently about to render. Combines custom-type IDs (direct
  // typeId on the def) with built-in scoped IDs (resolved via cache_tickettype
  // name match) and the "all types" set for /t.
  function collectTypeIdsForCommands(commands) {
    const ids = new Set();
    for (const cmd of commands) {
      if (!cmd || !cmd.id) continue;
      const ttDef = HU.ticketTypeSearchMap[cmd.id];
      if (ttDef && ttDef.typeId != null) {
        ids.add(Number(ttDef.typeId));
        continue;
      }
      const builtin = ENTITY_SEARCH_MAP[cmd.id];
      if (builtin && builtin.route === 'ticket' && !builtin.assignedToMe) {
        const matches = getTypeIdsForBuiltinCommand(cmd.id);
        if (matches === null) {
          // /t or /tickets — need every typeId for a meaningful sum.
          const cache = readHaloCacheLookup('cache_tickettype');
          if (cache) cache.forEach((_row, id) => ids.add(Number(id)));
        } else {
          matches.forEach(id => ids.add(Number(id)));
        }
      }
    }
    return Array.from(ids);
  }

  // After a render, kick off lazy fetches for any visible commands whose
  // typeId data we don't have yet, then re-render so the new counters / tag
  // prefixes appear. Caller passes the commands that were just rendered.
  function scheduleVisibleCommandFetches(commands) {
    if (!Array.isArray(commands) || !commands.length) return;
    const typeIds = collectTypeIdsForCommands(commands);
    if (!typeIds.length) return;
    const fetchedCounts = HU.ticketTypeCountsFetched || new Set();
    const fetchedTags   = HU.ticketTypeTagsFetched   || new Set();
    const needCounts = typeIds.some(id => !fetchedCounts.has(id));
    const needTags   = typeIds.some(id => !fetchedTags.has(id));
    if (!needCounts && !needTags) return;

    const rerender = () => {
      if (!HU.paletteOpen) return;
      const input = document.getElementById('hu-palette-input');
      if (input) runPaletteSearch(input.value);
    };

    if (needCounts) refreshTicketTypeCounts(typeIds).then(rerender).catch(() => {});
    if (needTags)   enrichTicketTypeTags(typeIds).then(rerender).catch(() => {});
  }

  const CONFIG_SECTIONS = [
    { label: 'All Features',               slug: 'home',              keywords: ['all', 'features', 'home'] },
    { label: 'Tenant',                     slug: 'organisation',      keywords: ['tenant', 'organisation', 'organization'] },
    { label: 'Teams & Agents',             slug: 'agents',            keywords: ['teams', 'agents', 'team', 'agent'] },
    { label: 'Users',                      slug: 'users',             keywords: ['users', 'user', 'end-users', 'end users'] },
    { label: 'Email',                      slug: 'email',             keywords: ['email', 'mail', 'mailbox'] },
    { label: 'Tickets',                    slug: 'tickets',           keywords: ['tickets', 'ticket', 'incidents', 'requests', 'requesttype', 'ticket types'] },
    { label: 'AI',                         slug: 'ai',                keywords: ['ai', 'artificial intelligence', 'gpt'] },
    { label: 'Asset Management',           slug: 'assets',            keywords: ['assets', 'asset', 'cmdb', 'devices'] },
    { label: 'Calendars and Appointments', slug: 'calendar',          keywords: ['calendar', 'calendars', 'appointments', 'appointment'] },
    { label: 'Call Management',            slug: 'call',              keywords: ['call', 'calls', 'phone', 'voip'] },
    { label: 'Chat',                       slug: 'chat',              keywords: ['chat', 'messaging'] },
    { label: 'Contracts',                  slug: 'contracts',         keywords: ['contracts', 'contract'] },
    { label: 'Document Management',        slug: 'documents',         keywords: ['documents', 'document', 'docs'] },
    { label: 'Forecasting',                slug: 'forecasting',       keywords: ['forecasting', 'forecast', 'opportunities', 'opps'] },
    { label: 'Event Management',           slug: 'eventmanagement',   keywords: ['events', 'event', 'event management'] },
    { label: 'Knowledge Base',             slug: 'kb',                keywords: ['knowledge', 'kb', 'articles', 'faq'] },
    { label: 'Items and Stock Control',    slug: 'items',             keywords: ['items', 'item', 'stock', 'inventory'] },
    { label: 'Notifications',              slug: 'notifications',     keywords: ['notifications', 'notification', 'alerts'] },
    { label: 'Project Management',         slug: 'projects',          keywords: ['projects', 'project', 'pm'] },
    { label: 'Purchase Orders',            slug: 'purchaseorders',    keywords: ['purchase', 'orders', 'po', 'purchases', 'purchase orders'] },
    { label: 'Reporting',                  slug: 'reports',           keywords: ['reports', 'reporting', 'report'] },
    { label: 'Self Service Portal',        slug: 'selfservice',       keywords: ['self service', 'portal', 'ssp', 'self-service'] },
    { label: 'Services',                   slug: 'services',          keywords: ['services', 'service'] },
    { label: 'Service Level Agreements',   slug: 'sla',               keywords: ['sla', 'slas', 'service level'] },
    { label: 'Software Releases',          slug: 'software',          keywords: ['software', 'releases', 'release'] },
    { label: 'Suppliers',                  slug: 'suppliers',         keywords: ['suppliers', 'supplier', 'vendors'] },
    { label: 'Supplier Contracts',         slug: 'suppliercontracts', keywords: ['supplier contracts', 'vendor contracts'] },
    { label: 'Time Management',            slug: 'time',              keywords: ['time', 'timesheet', 'timesheets', 'time management'] },
    { label: 'Language',                   slug: 'language',          keywords: ['language', 'languages', 'i18n', 'translations'] },
    { label: 'Custom Objects',             slug: 'custom',            keywords: ['custom', 'fields', 'objects', 'custom objects', 'custom fields'] },
    { label: 'Integrations',               slug: 'integrations',      keywords: ['integrations', 'integration', 'api', 'connectors'] },
    { label: 'Migrations',                 slug: 'migrations',        keywords: ['migrations', 'migration', 'import', 'imports'] },
    { label: 'Advanced Settings',          slug: 'advanced',          keywords: ['advanced', 'advanced settings', 'database', 'audit'] }
  ];

  function command(id, title, subtitle, run, keywords = [], kind = '') {
    return { id, title, subtitle, run, keywords, type: 'command', kind };
  }

  function safeNavUrl(value) {
    if (!value) return '';
    try {
      const resolved = new URL(value, window.location.origin);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';
      return resolved.href;
    } catch (e) {
      return '';
    }
  }

  // Halo writes its Multi-Tab mode state into localStorage as `haloTabState`
  // (shared across isolated + main worlds). Presence of a `tabs` array means
  // Multi-Tab is active right now; absence means single-tab mode.
  function isHaloMultiTabActive() {
    try {
      const raw = localStorage.getItem('haloTabState');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed && parsed.tabs);
    } catch (_) { return false; }
  }

  // SPA-navigate via the main-world bridge (content/main-world-bridge.js).
  // React's `_reactRootContainer` expando and Redux's store are invisible
  // from the isolated content-script world, so we signal across via
  // CustomEvent. Two modes:
  //   - openInNewHaloTab off OR multi-tab inactive: history.push() → replace
  //   - openInNewHaloTab on AND multi-tab active:   dispatch ADD_NEW_TAB
  // CustomEvent `detail` is structured-cloned across worlds, so we can't
  // read back a "handled" flag. Trust the bridge for same-origin and let
  // it own the fallback if React Router isn't reachable. Only cross-origin
  // URLs do a hard navigation here.
  function navigateTo(value) {
    const href = safeNavUrl(value);
    if (!href) return;
    let url;
    try { url = new URL(href); } catch (_) {
      window.location.assign(href);
      return;
    }
    if (url.origin !== window.location.origin) {
      window.location.assign(href);
      return;
    }
    const useNewTab = HU.settings.openInNewHaloTab && isHaloMultiTabActive();
    const eventName = useNewTab ? 'haloplus:open-new-tab' : 'haloplus:navigate';
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: { path: url.pathname + url.search + url.hash }
    }));
  }

  // Delegated click handler for HaloPlus-rendered <a class="hu-spa-link"> tags.
  // A plain `<a href="/tickets?id=1">` would do a hard browser navigation
  // (closing every Halo Multi-Tab tab) — route them through navigateTo()
  // instead. Modifier-key clicks (ctrl/cmd/shift, middle-click) keep their
  // native semantics so the browser can still open them in a new tab.
  document.addEventListener('click', e => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest('a.hu-spa-link[href]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    navigateTo(a.getAttribute('href'));
  }, true);

  function navCommand(id, title, subtitle, path, keywords = [], kind = '') {
    return command(id, title, subtitle, () => navigateTo(path), keywords, kind);
  }

  function routeList(type) {
    return ROUTES[type]?.list || '/';
  }

  function routeDetail(type, id) {
    const route = ROUTES[type];
    if (!route) return '/';
    return route.detail ? route.detail(id) : route.list;
  }

  function detectContext() {
    const url = window.location.href.toLowerCase();
    const context = {
      platform: 'unknown',
      page: 'unknown',
      fields: [],
      vars: {},
      url: window.location.href
    };

    if (url.includes('halopsa')) context.platform = 'halopsa';
    else if (url.includes('haloitsm')) context.platform = 'haloitsm';
    else if (url.includes('haloservicedesk')) context.platform = 'haloitsm';

    if (url.includes('/config')) context.page = 'configuration';
    else if (url.includes('/report')) context.page = 'report';
    else if (url.includes('/lookup') || url.includes('lookup')) context.page = 'lookup';
    else if (url.includes('/ticket') || url.includes('/fault')) context.page = 'ticket';
    else if (url.includes('/asset') || url.includes('/device')) context.page = 'asset';
    else if (url.includes('/customer') || url.includes('/area')) context.page = 'organisation';
    else if (url.includes('/agent') || url.includes('/uname')) context.page = 'agent';

    try {
      const params = new URL(window.location.href).searchParams;
      const id = params.get('id');
      if (id && /^\d+$/.test(id)) {
        if (context.page === 'ticket')    context.vars['$ticketid']  = id;
        if (url.includes('/invoices'))    context.vars['$invoiceid'] = id;
        if (url.includes('/assets'))      context.vars['$assetid']   = id;
      }
      const clientId = params.get('clientid');
      if (clientId && /^\d+$/.test(clientId)) context.vars['$clientid'] = clientId;
      const siteId   = params.get('siteid');
      if (siteId   && /^\d+$/.test(siteId))   context.vars['$siteid']   = siteId;
      const agentId  = params.get('agentid');
      if (agentId  && /^\d+$/.test(agentId))  context.vars['$agentid']  = agentId;
      const userId   = params.get('userid');
      if (userId   && /^\d+$/.test(userId))   context.vars['$userid']   = userId;

      // Try to resolve $agentid from the logged-in agent profile in the DOM
      if (!context.vars['$agentid']) {
        const profileBtn = document.querySelector('[id*="agentid"], [data-agentid], [data-userid]');
        const agentNum = profileBtn?.dataset?.agentid || profileBtn?.dataset?.userid;
        if (agentNum && /^\d+$/.test(agentNum)) context.vars['$agentid'] = agentNum;
      }
    } catch (e) {
      // URL parsing is best effort.
    }

    try {
      const labels = document.querySelectorAll('label, .field-label, [class*="label"]');
      labels.forEach(label => {
        const text = label.textContent?.trim();
        if (text && text.length < 60) context.fields.push(text);
      });
      context.fields = [...new Set(context.fields)].slice(0, 30);
    } catch (e) {
      // Field detection is best effort.
    }

    context.permissions = readHaloPermissions();
    context.reportApiOk = HU.reportApiOk;
    context.reportApiError = HU.reportApiError || '';

    return context;
  }

  function getAccessToken() {
    // Halo rotates the access_token cookie frequently and the Halo UI itself
    // reads from the cookie on every request, so prefer it over the older
    // localStorage / sessionStorage fallbacks.
    const cookieMatch = document.cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (cookieMatch) {
      const v = decodeURIComponent(cookieMatch[1]);
      if (v) return v;
    }

    const keys = ['access_token', 'halo_access_token', 'token'];
    const stores = [window.localStorage, window.sessionStorage];
    for (const store of stores) {
      try {
        for (const key of keys) {
          const value = store.getItem(key);
          const token = readTokenValue(value);
          if (token) return token;
        }
      } catch (e) {
        // Storage access can be blocked in some contexts.
      }
    }
    return '';
  }

  function readTokenValue(value) {
    if (!value) return '';
    if (/^[A-Za-z0-9._-]{20,}$/.test(value)) return value;

    try {
      const parsed = JSON.parse(value);
      return parsed?.access_token || parsed?.accessToken || parsed?.token || '';
    } catch (e) {
      return '';
    }
  }

  // Reads the agent's permission claims from localStorage. Halo stores its full
  // claim set there (synced from /api/Agent/me at login + on impersonation
  // start/stop), so this is a sync sub-millisecond read that doesn't need
  // network. Cached for 30s to avoid repeated JSON.parse on every gate check.
  // NOTE: claims do NOT update on impersonation — they reflect the parent
  // agent's permissions. `isImpersonating` flags this so gates can ignore the
  // claims when an impersonation session is active.
  function readHaloPermissions(forceFresh) {
    const now = Date.now();
    if (!forceFresh && HU.permissions && now - HU.permissionsReadAt < 30000) {
      return HU.permissions;
    }
    HU.permissionsReadAt = now;

    try {
      const arr = JSON.parse(localStorage.getItem('claims') || '[]');
      const m = {};
      arr.forEach(c => { if (c && c.type) m[c.type] = String(c.value || ''); });

      const isAdmin = m['Administration'] === 'true';
      const isTrueish = v => Boolean(v) && v !== '0' && v.toLowerCase() !== 'false';
      const claimAllows = name => isAdmin || isTrueish(m[name]);

      const currentAgentId = localStorage.getItem('currloggedonuser') || '';
      const parentAgentId  = localStorage.getItem('P_currloggedonuser') || '';

      // `P_currloggedonuser` differing from `currloggedonuser` is NOT a
      // reliable impersonation signal on its own — Halo's localStorage can
      // carry a stale or user-record id (not an agent id) under that key
      // from prior sessions. Only treat it as impersonation when both ids
      // resolve to known agents in `cache_agent`. Falling back to "not
      // impersonating" is the safe default; the worst case is hiding the
      // banner for a genuinely impersonating session, which a page reload
      // (which repopulates cache_agent) would correct.
      let isImpersonating = !!parentAgentId && parentAgentId !== currentAgentId;
      let staleImpersonationMarker = false;
      if (isImpersonating) {
        const agents = readHaloCacheLookup('cache_agent');
        if (agents && agents.size) {
          const parentExists  = agents.has(Number(parentAgentId));
          const currentExists = agents.has(Number(currentAgentId));
          if (!parentExists || !currentExists) {
            isImpersonating = false;
            staleImpersonationMarker = true;
          }
        }
      }

      HU.permissions = {
        isAdmin,
        canImpersonate: claimAllows('Can_Impersonate_Users'),
        canLogTickets:  claimAllows('Can_Log_Tickets'),
        canEditClosedTickets: claimAllows('Can_Edit_Closed_Tickets'),
        canRunPowerShell: claimAllows('Can_Run_PowerShell'),
        claims: m,
        totalClaims: arr.length,
        currentAgentId,
        parentAgentId,
        isImpersonating,
        staleImpersonationMarker,
        cacheRoles: (localStorage.getItem('cache_roles') || '').split(',').filter(Boolean)
      };
    } catch (e) {
      HU.permissions = {
        isAdmin: false, canImpersonate: false, claims: {}, totalClaims: 0,
        currentAgentId: '', parentAgentId: '', isImpersonating: false, cacheRoles: [],
        error: e.message
      };
    }
    return HU.permissions;
  }

  // Read one of Halo's localStorage caches (cache_status, cache_tickettype,
  // cache_agent, cache_team) and return a Map keyed by id. Halo populates
  // these on every page load, so the data is fresh and avoids extra API calls.
  function readHaloCacheLookup(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      const map = new Map();
      for (const item of arr) {
        if (item && item.id != null) map.set(Number(item.id), item);
      }
      return map;
    } catch (e) {
      return null;
    }
  }

  function getCachedName(cacheKey, id, fallback) {
    if (id == null || id === '' || id === 0) return fallback || '';
    const map = readHaloCacheLookup(cacheKey);
    const item = map && map.get(Number(id));
    if (!item) return fallback || '';
    return item.name || item.shortname || fallback || '';
  }

  function isReportPermissionError(message) {
    if (!message) return false;
    const m = String(message).toLowerCase();
    if (m.includes('401') || m.includes('403')) return true;
    if (m.includes('forbidden') || m.includes('unauthorized')) return true;
    if (m.includes('permission') || m.includes('access denied')) return true;
    if (m.includes('not allowed')) return true;
    if (m.includes('please contact the administrator')) return true;
    if (m.includes('contact the administrator')) return true;
    if (m.includes('contact an administrator')) return true;
    if (m.includes('contact your administrator')) return true;
    return false;
  }

  // Probe /api/Report once on startup (kept for Data Viewer + Schema gating).
  // Result cached for 60s so the side panel + diagnostics can re-check cheaply.
  async function probeReportApi(forceFresh) {
    const now = Date.now();
    if (!forceFresh && HU.reportApiOk !== null && now - HU.reportApiProbedAt < 60000) {
      return HU.reportApiOk;
    }
    HU.reportApiProbedAt = now;
    try {
      await runHaloReport('SELECT TOP 1 Faultid FROM faults', 'HaloPlus Permission Probe');
      HU.reportApiOk = true;
      HU.reportApiError = '';
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      HU.reportApiOk = isReportPermissionError(msg) ? false : null;
      HU.reportApiError = msg;
    }
    return HU.reportApiOk;
  }

  function createReportPayload(sql, name) {
    return [{
      name: name || 'HaloPlus Query',
      sql,
      mainentity: guessMainEntity(sql),
      _loadreportonly: true
    }];
  }

  function guessMainEntity(sql) {
    const match = String(sql || '').match(/\bfrom\s+([a-zA-Z0-9_]+)/i);
    if (!match) return '';

    const knownEntities = {
      faults: 'Faults',
      actions: 'Actions',
      users: 'Users',
      site: 'Site',
      area: 'Area',
      uname: 'Uname',
      device: 'Device',
      requesttype: 'RequestType',
      tstatus: 'TStatus',
      slahead: 'SLAHead',
      policy: 'Policy',
      servsite: 'ServSite',
      kbentry: 'KBEntry'
    };

    return knownEntities[match[1].toLowerCase()] || match[1];
  }

  async function runHaloReport(sql, name) {
    const token = getAccessToken();
    // No `halo-app-name` / `x-halo-service`: Halo flagged third-party use of those first-party-UI markers.
    const headers = {
      accept: '*/*',
      'content-type': 'application/json'
    };

    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${window.location.origin}/api/Report`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(createReportPayload(sql, name))
    });

    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      // Keep text for diagnostics.
    }

    if (!response.ok) {
      const detail = typeof data === 'string' ? data : (data?.message || data?.error || response.statusText);
      throw new Error(`Halo API ${response.status}: ${detail}`);
    }

    return data;
  }

  async function postHaloJson(path, body) {
    return haloApiRequest(path, { method: 'POST', body });
  }

  async function haloApiRequest(path, options = {}) {
    // Token MUST be read live every call: Halo rotates the cookie mid-session, cached reads 401.
    // No `halo-app-name` / `x-halo-service`: Halo flagged third-party use of those first-party-UI markers.
    const token = getAccessToken();
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      'pragma': 'no-cache'
    };

    if (token) headers.authorization = `Bearer ${token}`;

    const requestInit = {
      method,
      credentials: 'include',
      headers
    };

    if (options.body !== undefined && options.body !== null && method !== 'GET') {
      requestInit.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(`${window.location.origin}${path}`, requestInit);

    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      // Keep text for fallback redirect detection.
    }

    if (!response.ok) {
      const detail = typeof data === 'string' ? data : (data?.message || data?.error || response.statusText);
      throw new Error(`Halo API ${response.status}: ${detail}`);
    }

    return data;
  }

  // Unwrap Halo's inconsistent entity-list response shapes.
  // - Bare array  (e.g. /api/agent)                          → returns the array
  // - { record_count, <named array> }  (e.g. /api/tickets)   → returns the named array
  // - Single object  (e.g. /api/tickets/{id})                → returns [object]
  function extractEntityList(response, preferredKey) {
    if (!response) return [];
    if (Array.isArray(response)) return response;
    if (preferredKey && Array.isArray(response[preferredKey])) return response[preferredKey];
    // Try the conventional keys Halo uses
    const commonKeys = ['tickets', 'clients', 'users', 'agents', 'sites', 'assets',
                        'quotes', 'quotations', 'invoices', 'purchaseorders',
                        'articles', 'kbarticles', 'kbentries', 'entries',
                        'teams', 'statuses',
                        'actions', 'records', 'data', 'results'];
    for (const k of commonKeys) {
      if (Array.isArray(response[k])) return response[k];
    }
    // Last-resort: find any array-valued property on the wrapper object.
    // Covers Halo endpoints whose envelope key we haven't enumerated yet.
    if (response && typeof response === 'object') {
      for (const k of Object.keys(response)) {
        if (Array.isArray(response[k]) && response[k].length && typeof response[k][0] === 'object') {
          return response[k];
        }
      }
    }
    // Single-object responses (e.g. /api/tickets/{id}) — wrap in an array
    if (typeof response === 'object') return [response];
    return [];
  }

  // Convenience: GET /api/<entity>?search=<term>&count=<n>
  async function searchHaloEntity(entityPath, options = {}) {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.count)  params.set('count',  String(options.count));
    if (options.extra)  Object.entries(options.extra).forEach(([k, v]) => params.set(k, String(v)));
    const qs = params.toString();
    const url = qs ? `${entityPath}?${qs}` : entityPath;
    const response = await haloApiRequest(url);
    return extractEntityList(response, options.listKey);
  }

  function getCurrentTicketId() {
    const url = new URL(window.location.href);
    const direct = url.searchParams.get('id') || url.searchParams.get('faultid');
    if (direct && /^\d+$/.test(direct)) {
      const path = url.pathname.toLowerCase();
      const isTicketPage = /\/(tickets?|faults?)(\/|$)/.test(path) && !/\/config\//.test(path);
      if (isTicketPage) return Number(direct);
    }

    const fallback = detectContext().vars['$ticketid'];
    return fallback && /^\d+$/.test(fallback) ? Number(fallback) : 0;
  }

  // Halo's API returns date-times without an explicit timezone (e.g.
  // "2026-05-13T18:01:50.347"). The values are stored in UTC but JS's
  // `new Date(str)` interprets a zone-less ISO string as LOCAL time, which
  // shifts every Halo time by the agent's UTC offset (2h for CEST agents
  // — the original bug report). Append 'Z' when no zone is present so JS
  // parses it as UTC and converts to local for display + SLA math.
  function parseHaloDate(value) {
    if (value == null) return new Date(NaN);
    if (value instanceof Date) return value;
    const str = String(value);
    if (str.includes('T') && !/Z$|[+\-]\d{2}:?\d{2}$/.test(str)) {
      return new Date(str + 'Z');
    }
    return new Date(str);
  }

  function formatDateTime(value) {
    if (!value) return '--';
    const date = parseHaloDate(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  // Halo's `actions.timetaken` is stored as decimal HOURS (both in SQL and in
  // the entity-API response). Convert to minutes before formatting so a
  // 15-minute log (`timetaken: 0.25`) renders as `15m`, not `0m`.
  function minutesFromTimetaken(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.round(hours * 60);
  }

  // Supervisors can adjust the billable time on an action via
  // `timetaken_adjusted`. When set (and different from the raw value), it's
  // the figure that flows through to invoicing — prefer it over the raw.
  // Falls back to `timetaken` when adjusted is unset/zero.
  function effectiveActionMinutes(action) {
    if (!action) return 0;
    const adjusted = minutesFromTimetaken(
      action['Time Taken Adjusted'] ?? action.timetaken_adjusted
    );
    if (adjusted > 0) return adjusted;
    return minutesFromTimetaken(action['Time Taken'] ?? action.timetaken);
  }

  function formatMinutes(value) {
    const minutes = Math.round(Number(value));
    if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
    }
    return `${minutes}m`;
  }

  function formatSlaState(value) {
    const map = {
      I: 'Inside SLA',
      O: 'Outside SLA',
      E: 'Excluded',
      A: 'Awaiting'
    };
    return map[String(value || '').toUpperCase()] || (value ? String(value) : 'Awaiting');
  }

  function buildTicket360Query(ticketId) {
    return `
SELECT TOP 1
  F.Faultid AS [Ticket ID],
  F.Symptom AS [Summary],
  TS.TStatusDesc AS [Status],
  P.PDesc AS [Priority],
  RT.RTDesc AS [Ticket Type],
  SL.SLDesc AS [SLA],
  F.SLAState AS [SLA State],
  F.DateOccured AS [Opened],
  F.FixByDate AS [Due By],
  F.DateCleared AS [Closed],
  U.uid AS [User ID],
  U.UUsername AS [End User],
  U.UEmail AS [User Email],
  U.UMobile AS [User Mobile],
  A.AArea AS [Client ID],
  A.AAreaDesc AS [Client],
  S.SSitenum AS [Site ID],
  S.SDesc AS [Site],
  AU.UNum AS [Assigned Agent ID],
  AU.UName AS [Assigned Agent],
  AU.USMTP AS [Assigned Agent Email],
  CU.UNum AS [Closed By ID],
  CU.UName AS [Closed By],
  D.DDevNum AS [Asset ID],
  D.DInvNo AS [Asset Tag]
FROM
  Faults F
  LEFT JOIN Users U ON F.UserID = U.uid
  LEFT JOIN TStatus TS ON F.Status = TS.TStatus
  LEFT JOIN Policy P ON F.Seriousness = P.PPolicy
  LEFT JOIN RequestType RT ON F.RequestTypeNew = RT.RTID
  LEFT JOIN SLAHead SL ON F.SLAID = SL.SLID
  LEFT JOIN Area A ON F.Areaint = A.AArea
  LEFT JOIN Site S ON F.SiteNumber = S.SSitenum
  LEFT JOIN Uname AU ON F.AssignedToInt = AU.UNum
  LEFT JOIN Uname CU ON F.ClearWhoInt = CU.UNum
  LEFT JOIN Device D ON F.DeviceNumber = D.DDevNum AND F.DevSite = D.DSite
WHERE
  F.Faultid = ${Number(ticketId)}
`.trim();
  }

  function buildTicketActionTimelineQuery(ticketId) {
    return `
SELECT TOP 25
  ActionNumber AS [Action ID],
  Who AS [Who],
  Whe_ AS [When],
  ActOutcome AS [Outcome],
  LEFT(CONVERT(nvarchar(max), Note), 400) AS [Note],
  TimeTaken AS [Time Taken],
  DateEmailed AS [Date Emailed],
  ActionHide AS [Hidden]
FROM
  Actions
WHERE
  Faultid = ${Number(ticketId)}
ORDER BY
  Whe_ DESC,
  ActionNumber DESC
`.trim();
  }

  function buildTicketCommercialTraceQuery(ticketId) {
    return `
SELECT
  Trace.RecordType AS [Record Type],
  Trace.RecordID AS [Record ID],
  Trace.Title AS [Title],
  Trace.RecordDate AS [Date],
  Trace.RefCode AS [Reference]
FROM (
  SELECT
    'Quote' AS RecordType,
    CAST(QH.qhid AS nvarchar(50)) AS RecordID,
    QH.QHtitle AS Title,
    QH.QHDate AS RecordDate,
    QH.QHPORef AS RefCode
  FROM QUOTATIONHEADER QH
  WHERE QH.QHfaultID = ${Number(ticketId)}

  UNION ALL

  SELECT
    'Sales Order' AS RecordType,
    CAST(OH.OHid AS nvarchar(50)) AS RecordID,
    OH.OHtitle AS Title,
    OH.OHorderdate AS RecordDate,
    OH.OHponumber AS RefCode
  FROM ORDERHEAD OH
  WHERE OH.OHfaultid = ${Number(ticketId)} OR OH.OHprojectfaultid = ${Number(ticketId)}

  UNION ALL

  SELECT
    'Purchase Order' AS RecordType,
    CAST(SOH.SHid AS nvarchar(50)) AS RecordID,
    SOH.SHtitle AS Title,
    SOH.SHPODate AS RecordDate,
    SOH.SHPORef AS RefCode
  FROM SUPPLIERORDERHEADER SOH
  WHERE SOH.SHfaultID = ${Number(ticketId)}

  UNION ALL

  SELECT
    'Invoice' AS RecordType,
    CAST(IH.ihid AS nvarchar(50)) AS RecordID,
    IH.IHname AS Title,
    IH.ihdatepaid AS RecordDate,
    IH.IH3rdPartyInvoiceNumber AS RefCode
  FROM InvoiceHeader IH
  INNER JOIN InvoiceDetail ID ON ID.IdIHid = IH.ihid
  WHERE ID.IDFaultid = ${Number(ticketId)}
) Trace
`.trim();
  }

  function getReportLoadError(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.report?.load_error === 'string' && payload.report.load_error) return payload.report.load_error;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === 'object') {
          const nested = getReportLoadError(item);
          if (nested) return nested;
        }
      }
    }
    for (const value of Object.values(payload)) {
      if (value && typeof value === 'object') {
        const nested = getReportLoadError(value);
        if (nested) return nested;
      }
    }
    return '';
  }

  function sortTraceRows(rows) {
    return [...rows].sort((a, b) => {
      const dateA = (a?.['Date'] ? parseHaloDate(a['Date']).getTime() : 0) || 0;
      const dateB = (b?.['Date'] ? parseHaloDate(b['Date']).getTime() : 0) || 0;
      if (dateA !== dateB) return dateB - dateA;
      return String(a?.['Record Type'] || '').localeCompare(String(b?.['Record Type'] || ''));
    });
  }

  function extractRows(payload) {
    if (!payload) return [];
    if (Array.isArray(payload) && looksLikeRows(payload, '')) return payload;

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
        const score = scoreRows(value, path);
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
    if (/(permission|filterable|available_columns|conditions|joins|series|chart|report\.permissions)/i.test(path)) return false;
    const keys = Object.keys(value[0]).map(key => key.toLowerCase());
    if (keys.includes('agent_id') && keys.includes('readonly')) return false;
    if (keys.includes('sys_name') && keys.includes('query')) return false;
    if (keys.includes('name') && keys.includes('data_type') && keys.includes('data_type_group')) return false;
    if (keys.includes('id') && keys.includes('name') && keys.includes('data_type') && keys.includes('data_type_group')) return false;
    return keys.length > 0;
  }

  function scoreRows(value, path) {
    if (!looksLikeRows(value, path)) return 0;
    const keys = Object.keys(value[0]);
    const usefulKeys = keys.filter(key => !/^(id|guid|name|type)$/i.test(key)).length;
    const preferred = ['ticket id', 'summary', 'status', 'priority', 'end user', 'record type', 'action id', 'when', 'outcome'];
    const preferredMatches = keys.filter(key => preferred.includes(String(key).toLowerCase())).length;
    return value.length + (usefulKeys * 4) + (preferredMatches * 25);
  }

  function injectStyles() {
    if (document.getElementById('haloutils-styles')) return;

    const style = document.createElement('style');
    style.id = 'haloutils-styles';
    style.textContent = `
      .hu-hidden { display: none !important; }
      .hu-palette-backdrop {
        position: fixed; inset: 0; z-index: 2147483600;
        background: rgba(12, 18, 28, 0.26);
      }
      .hu-palette {
        --hu-palette-font-scale: 1;
        position: fixed; top: 72px;
        z-index: 2147483601; background: #fff; color: #172033;
        border: 1px solid #d8dde8; border-radius: 8px; box-shadow: 0 24px 80px rgba(8, 16, 30, 0.28);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow: visible;
        font-size: calc(15px * var(--hu-palette-font-scale));
      }
      .hu-palette-pos-mid {
        left: 50%; transform: translateX(-50%);
        width: min(760px, calc(100vw - 28px));
        max-height: min(720px, calc(100vh - 112px));
      }
      .hu-palette-pos-left {
        left: 18px;
        width: min(520px, calc(100vw - 36px));
        max-height: min(720px, calc(100vh - 112px));
      }
      .hu-palette-pos-right {
        right: 18px;
        width: min(520px, calc(100vw - 36px));
        max-height: min(720px, calc(100vh - 112px));
      }
      .hu-palette-tools {
        position: absolute; top: 9px; right: 9px;
        display: flex; gap: 4px; z-index: 2;
        opacity: 0; pointer-events: none; transition: opacity 0.15s ease-out;
      }
      .hu-palette:hover .hu-palette-tools,
      .hu-palette-tools:focus-within { opacity: 1; pointer-events: auto; }
      .hu-palette-input { padding-right: 200px; }
      .hu-spinner {
        display: inline-block; width: 11px; height: 11px;
        border: 2px solid currentColor; border-top-color: transparent;
        border-radius: 50%; vertical-align: -1px;
        animation: hu-spin 0.7s linear infinite;
      }
      @keyframes hu-spin { to { transform: rotate(360deg); } }
      .hu-palette-discovery {
        position: absolute; bottom: 8px; right: 12px;
        display: inline-flex; align-items: center; gap: 7px;
        font-size: 11px; line-height: 1; color: #475066;
        padding: 5px 11px; background: rgba(255,255,255,0.96);
        border: 1px solid #e3e7ef; border-radius: 999px;
        pointer-events: none; z-index: 3;
        box-shadow: 0 1px 4px rgba(8,16,30,0.05);
        max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      html.hu-theme-dark .hu-palette-discovery {
        background: rgba(23,27,34,0.96); border-color: #303744; color: #c7cedb;
      }
      .hu-palette-review {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 14px; background: #fff7ee;
        border-bottom: 1px solid #f4dcb5; color: #8a4b00;
        font-size: 12.5px;
      }
      .hu-palette-review-text { flex: 1; min-width: 0; }
      .hu-palette-review-btn {
        height: 24px; padding: 0 10px; font-size: 11px; font-weight: 600;
        border: 1px solid #e6c39a; background: #fff; color: #8a4b00;
        border-radius: 4px; cursor: pointer;
      }
      .hu-palette-review-btn:hover { background: #ffe9cd; }
      .hu-palette-review-go { background: #ff9b51; border-color: #ff9b51; color: #fff; }
      .hu-palette-review-go:hover { background: #ff8a35; border-color: #ff8a35; color: #fff; }
      .hu-palette-review-no { color: #94684a; }
      .hu-palette.hu-has-review .hu-palette-tools { display: none; }
      html.hu-theme-dark .hu-palette-review { background: #2a1f12; border-color: #4a3520; color: #f0c89a; }
      html.hu-theme-dark .hu-palette-review-btn { background: #1f1810; border-color: #4a3520; color: #f0c89a; }
      html.hu-theme-dark .hu-palette-review-btn:hover { background: #2f2418; }
      html.hu-theme-dark .hu-palette-review-go { background: #ff9b51; border-color: #ff9b51; color: #1a1208; }
      html.hu-theme-dark .hu-palette-review-go:hover { background: #ff8a35; border-color: #ff8a35; color: #1a1208; }
      .hu-palette-tool {
        height: 26px; min-width: 28px; padding: 0 7px;
        border: 1px solid rgba(216, 221, 232, 0.85); background: rgba(255,255,255,0.95);
        border-radius: 5px; color: #475066; font-size: 12px; font-weight: 600;
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 3px rgba(8,16,30,0.06);
      }
      .hu-palette-tool:hover { background: #eef4ff; color: #172033; border-color: #b8d7ff; }
      .hu-palette-tool-pos { position: relative; padding: 0 7px; }
      .hu-palette-pos-menu {
        position: absolute; top: 100%; right: 0;
        display: none; flex-direction: column; min-width: 130px;
        background: #fff; border: 1px solid #d8dde8; border-radius: 6px;
        box-shadow: 0 8px 22px rgba(8,16,30,0.14); padding: 6px 4px 4px; gap: 2px; z-index: 1;
      }
      .hu-palette-tool-pos::after {
        content: ''; position: absolute; top: 100%; left: 0; right: 0; height: 6px;
        display: none;
      }
      .hu-palette-tool-pos:hover::after,
      .hu-palette-tool-pos:focus-within::after { display: block; }
      .hu-palette-tool-pos:hover .hu-palette-pos-menu,
      .hu-palette-tool-pos:focus-within .hu-palette-pos-menu { display: flex; }
      .hu-palette-pos-option {
        text-align: left; height: 26px; padding: 0 8px; font-size: 12px; font-weight: 500;
        border: 0; background: transparent; border-radius: 4px; cursor: pointer; color: #172033;
        display: flex; align-items: center; gap: 8px;
      }
      .hu-palette-pos-option:hover { background: #eef4ff; }
      .hu-palette-input {
        width: 100%; height: 44px; border: 0; border-bottom: 1px solid #e3e7ef;
        padding: 0 14px; font-size: calc(15px * var(--hu-palette-font-scale)); outline: none; color: #101827; background: #fff;
      }
      .hu-palette-list { max-height: 480px; overflow-y: auto; padding: 5px; }
      .hu-result {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%;
        border: 0; background: transparent; text-align: left; padding: 6px 8px;
        min-height: 34px; border-radius: 5px; cursor: pointer; color: #172033; font: inherit;
      }
      .hu-result > span:first-child { min-width: 0; }
      .hu-result.hu-active, .hu-result:hover { background: #eef4ff; }
      .hu-result.hu-disabled { opacity: 0.45; cursor: not-allowed; }
      .hu-result.hu-disabled:hover, .hu-result.hu-disabled.hu-active { background: transparent; }
      .hu-result.hu-result-loading { cursor: default; opacity: 0.85; }
      .hu-result.hu-result-loading:hover, .hu-result.hu-result-loading.hu-active { background: transparent; }
      .hu-palette .hu-status-pill {
        display: inline-block; padding: 1px 6px; margin-right: 6px;
        font-size: calc(9.5px * var(--hu-palette-font-scale)); font-weight: 600;
        line-height: 1.35; color: #fff; border-radius: 8px;
        text-shadow: 0 1px 1px rgba(0,0,0,0.18); vertical-align: 1px;
        max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .hu-palette .hu-type-pill {
        display: inline-block; padding: 1px 6px; margin-right: 6px;
        font-size: calc(9.5px * var(--hu-palette-font-scale)); font-weight: 500;
        line-height: 1.35; color: #5e6b80; background: #eef1f6;
        border: 1px solid #dde3ec; border-radius: 8px;
        vertical-align: 1px;
        max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .hu-spinner {
        display: inline-block; width: 12px; height: 12px; margin-right: 8px;
        border: 2px solid #d8dde8; border-top-color: #2196f3; border-radius: 50%;
        animation: hu-spin 0.6s linear infinite; vertical-align: -1px;
      }
      @keyframes hu-spin { to { transform: rotate(360deg); } }
      .hu-palette .hu-result-title { display: block; font-size: calc(12.5px * var(--hu-palette-font-scale)); line-height: 1.25; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-palette .hu-result-sub { display: block; margin-top: 1px; color: #667085; font-size: calc(10.5px * var(--hu-palette-font-scale)); line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-palette .hu-result-kind { color: #6a7280; font-size: calc(10px * var(--hu-palette-font-scale)); line-height: 1; align-self: center; border: 1px solid #e0e5ee; border-radius: 5px; padding: 2px 5px; }
      .hu-palette .hu-result-kind-accent { background: #ff9b51; border-color: #ff9b51; color: #fff; font-weight: 700; letter-spacing: 0.02em; }
      .hu-palette .hu-result.hu-active .hu-result-kind-accent { background: #ff8a35; border-color: #ff8a35; }
      .hu-palette .hu-result-kind-clickable { cursor: pointer; }
      .hu-palette .hu-result-kind-clickable:hover { filter: brightness(1.08); box-shadow: 0 0 0 2px rgba(255,155,81,0.25); }
      .hu-palette-footer {
        border-top: 1px solid #e3e7ef; padding: 9px 14px 10px; background: #fbfcff;
        color: #667085; font-size: calc(12px * var(--hu-palette-font-scale));
        display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      }
      .hu-palette-footer .hu-result-title { color: #172033; font-size: calc(12px * var(--hu-palette-font-scale)); }
      .hu-palette-footer .hu-result-sub { font-size: calc(11px * var(--hu-palette-font-scale)); white-space: normal; }
      .hu-palette-env {
        font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em;
        padding: 2px 7px; border-radius: 99px;
        border: 1px solid; flex-shrink: 0; align-self: center;
      }
      .hu-drawer {
        position: fixed; right: 18px; top: 72px; bottom: 24px; width: min(520px, calc(100vw - 36px));
        z-index: 2147483599; background: #fff; color: #172033; border: 1px solid #d8dde8; border-radius: 8px;
        box-shadow: 0 18px 64px rgba(8, 16, 30, 0.24); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        display: flex; flex-direction: column; overflow: hidden;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .hu-drawer-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #e3e7ef; }
      .hu-drawer-title { font-size: 14px; font-weight: 800; }
      .hu-icon-btn { border: 1px solid #d8dde8; background: #fff; border-radius: 6px; min-width: 30px; height: 30px; cursor: pointer; color: #172033; }
      .hu-drawer-body { overflow: auto; padding: 10px; }
      .hu-row { width: 100%; border: 0; border-bottom: 1px solid #edf0f5; background: transparent; text-align: left; padding: 10px; cursor: pointer; color: #172033; font: inherit; }
      .hu-row:hover { background: #eef4ff; }
      .hu-row-title { display: block; font-size: 13px; font-weight: 700; }
      .hu-row-sub { display: block; color: #667085; font-size: 11px; margin-top: 2px; }
      .hu-field-tag {
        display: inline-flex; margin-left: 6px; padding: 1px 5px; border-radius: 5px;
        background: #eef4ff; color: #2259bc; border: 1px solid #cbd9f6;
        font-family: "SF Mono", "Cascadia Code", Consolas, monospace; font-size: 10px; vertical-align: baseline;
        cursor: pointer;
        user-select: none;
        transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease, transform 80ms ease;
      }
      .hu-field-tag:hover {
        background: #dbe7ff; border-color: #a8c1f0;
      }
      .hu-field-tag:active {
        transform: scale(0.95);
      }
      .hu-field-tag-copied {
        background: #d4f5dc !important; color: #1a7f3a !important; border-color: #8fdba3 !important;
      }
      .hu-field-tag-related {
        background: #fff4e0; color: #a8590a; border-color: #f0d4a3;
      }
      .hu-field-tag-related:hover {
        background: #ffe6c2; border-color: #e6b977;
      }
      .hu-field-tag-related .hu-field-tag-entity {
        font-weight: 700; opacity: 0.85;
      }
      .hu-field-tag-related .hu-field-tag-sep { opacity: 0.55; padding: 0 1px; }
      .hu-table-column-tag {
        display: inline-flex; width: max-content; max-width: 48%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        margin: 0 0 0 5px; padding: 1px 4px; font-size: 9px; line-height: 1.25;
        opacity: 0.92; pointer-events: none;
        vertical-align: middle;
      }
      .hu-table-column-label-target { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; }
      .hu-json-formatted { font-family: "SF Mono", "Cascadia Code", Consolas, monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #172033; padding: 10px; margin: 0; }
      #hu-json-drawer .hu-drawer-body { padding: 0; }
      .hu-json-toolbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; flex-direction: column;
        gap: 8px;
        padding: 10px;
        background: #fff;
        border-bottom: 1px solid #e3e7ef;
      }
      .hu-json-toolbar-meta { display: flex; flex-direction: column; min-width: 0; }
      .hu-json-toolbar-meta .hu-row-title,
      .hu-json-toolbar-meta .hu-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-json-toolbar-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .hu-json-count { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: #667085; min-height: 14px; }
      .hu-json-search {
        flex: 1 1 180px; min-width: 140px;
        padding: 5px 9px; font-size: 12px;
        border: 1px solid #d8dde8; border-radius: 6px;
        background: #fff; color: #172033;
        outline: none;
      }
      .hu-json-search:focus { border-color: #ff9b51; box-shadow: 0 0 0 3px rgba(255,155,81,0.18); }
      .hu-json-view-toggle { display: inline-flex; border: 1px solid #d8dde8; border-radius: 6px; overflow: hidden; }
      .hu-json-view-btn {
        background: #fff; border: 0; padding: 4px 10px; cursor: pointer;
        font-size: 11px; font-weight: 600; color: #5e7290;
      }
      .hu-json-view-btn + .hu-json-view-btn { border-left: 1px solid #d8dde8; }
      .hu-json-view-btn:hover { color: #25343f; }
      .hu-json-view-btn.is-active { background: #25343f; color: #fff; }
      .hu-json-action {
        background: #fff; border: 1px solid #d8dde8; border-radius: 6px;
        padding: 4px 9px; cursor: pointer; font-size: 11px; color: #25343f;
      }
      .hu-json-action:hover { border-color: #b5bdcc; }
      .hu-json-tree {
        padding: 8px 10px 14px;
        font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
        font-size: 11.5px; line-height: 1.55;
      }
      .hu-json-node { position: relative; }
      .hu-json-node-header,
      .hu-json-leaf {
        display: flex; align-items: center; gap: 4px;
        padding: 1px 4px; border-radius: 3px;
        min-width: 0;
      }
      .hu-json-node-header { cursor: pointer; user-select: none; }
      .hu-json-node-header:hover { background: rgba(37, 52, 63, 0.05); }
      .hu-json-leaf:hover { background: rgba(37, 52, 63, 0.04); }
      .hu-json-arrow {
        display: inline-block; width: 10px; color: #8694a0;
        font-size: 9px; transition: transform 0.1s ease;
        flex-shrink: 0;
      }
      .hu-json-node.is-collapsible.is-open > .hu-json-node-header .hu-json-arrow { transform: rotate(90deg); }
      .hu-json-children { display: none; margin-left: 14px; border-left: 1px dashed #e3e7ef; padding-left: 10px; }
      .hu-json-node.is-collapsible.is-open > .hu-json-children { display: block; }
      .hu-json-key { color: #2259bc; font-weight: 600; }
      .hu-json-sep { color: #8694a0; }
      .hu-json-summary { color: #8694a0; font-size: 10.5px; margin-left: 2px; }
      .hu-json-value { white-space: pre-wrap; word-break: break-word; min-width: 0; }
      .hu-json-string { color: #1f7a3a; }
      .hu-json-number { color: #b8651f; }
      .hu-json-boolean { color: #8a3ab9; font-weight: 600; }
      .hu-json-null { color: #94a3b8; font-style: italic; }
      .hu-json-copy-btn { margin-left: auto; flex-shrink: 0; opacity: 0; transition: opacity 0.1s ease; }
      .hu-json-node-header:hover .hu-json-copy-btn,
      .hu-json-leaf:hover .hu-json-copy-btn { opacity: 1; }
      .hu-json-node.is-match > .hu-json-node-header,
      .hu-json-node.is-match > .hu-json-leaf { background: rgba(255, 220, 100, 0.35); }
      .hu-json-mark { background: rgba(255, 220, 100, 0.6); color: inherit; border-radius: 2px; padding: 0 1px; }
      .hu-json-empty { padding: 16px; text-align: center; color: #667085; font-size: 12px; }
      .hu-copy { border: 1px solid #d8dde8; background: #fff; border-radius: 5px; cursor: pointer; font-size: 10px; padding: 2px 6px; color: #172033; }
      .hu-copy-json { font-size: 11px; padding: 4px 10px; white-space: nowrap; flex-shrink: 0; }
      .hu-toolbar-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 10px; border-bottom: 1px solid #edf0f5; }
      .hu-section-row { background: #f3f6fc; cursor: default; border-bottom: 1px solid #e3e7ef; }
      .hu-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #667085; font-weight: 600; }
      .hu-method-badge { font-size: 10px; padding: 2px 7px; white-space: nowrap; flex-shrink: 0; align-self: flex-start; margin-top: 2px; }
      .hu-api-row { cursor: default; }
      .hu-api-row:hover { background: #f8fafc; }
      .hu-api-row-inner { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; width: 100%; }
      /* API reference v2 — search + filter + collapsible params */
      /* Drawer body has padding: 10px which creates a gap above the sticky
         toolbar that scrolled content shows through. Zero out the top/side
         padding only on the API drawer; the toolbar provides its own. */
      #hu-api-drawer .hu-drawer-body { padding: 0; }
      .hu-api-toolbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 10px; background: #fff; border-bottom: 1px solid #e3e7ef;
      }
      .hu-api-results { padding: 0 10px 10px; }
      .hu-api-search {
        flex: 1 1 220px; min-width: 0;
        padding: 6px 10px; font-size: 12px;
        border: 1px solid #d8dde8; border-radius: 6px;
        background: #fff; color: #172033;
        outline: none;
      }
      .hu-api-search:focus { border-color: #ff9b51; box-shadow: 0 0 0 3px rgba(255,155,81,0.18); }
      .hu-api-methods { display: flex; gap: 4px; flex-wrap: wrap; }
      .hu-api-method-chip {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 10px; font-weight: 700;
        padding: 4px 8px; border-radius: 99px;
        border: 1px solid #d8dde8; background: #fff; color: #5e7290;
        cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .hu-api-method-chip:hover { border-color: #b5bdcc; color: #25343f; }
      .hu-api-method-chip.is-active { background: #25343f; color: #fff; border-color: #25343f; }
      .hu-api-count {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 11px; color: #667085; margin-left: auto;
      }
      .hu-api-empty { padding: 24px 12px; text-align: center; color: #667085; font-size: 12px; }
      .hu-api-cat-count {
        display: inline-block; margin-left: 6px;
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 10px; padding: 1px 6px; border-radius: 99px;
        background: rgba(255,155,81,0.12); color: #b8651f;
        font-weight: 700; letter-spacing: 0;
      }
      .hu-api-row-v2 {
        display: block !important;
        padding: 8px 10px;
        border-bottom: 1px solid #edf0f5;
      }
      .hu-api-row-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
      }
      .hu-api-toggle {
        background: transparent; border: 0; padding: 0;
        display: flex; align-items: center; gap: 6px;
        cursor: pointer; min-width: 0; flex: 1;
        text-align: left;
      }
      .hu-api-arrow { color: #8694a0; font-size: 10px; flex-shrink: 0; transition: transform 0.12s ease; }
      .hu-api-path {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 12px; color: #25343f; font-weight: 600;
        overflow-wrap: anywhere;
        background: transparent;
        padding: 0;
      }
      .hu-api-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .hu-api-summary { font-size: 11px; color: #667085; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-api-methods-tag {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
        padding: 2px 6px; border-radius: 4px;
        background: rgba(34, 89, 188, 0.10); color: #2259bc;
        border: 1px solid rgba(34, 89, 188, 0.22);
      }
      .hu-api-copy { font-size: 10px; padding: 2px 8px; }
      .hu-api-detail {
        margin-top: 8px; padding: 8px 10px;
        background: #f7f9fc; border: 1px solid #e3e7ef; border-radius: 6px;
        font-size: 11px;
      }
      .hu-api-param-row {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        margin-bottom: 4px;
      }
      .hu-api-param-row:last-child { margin-bottom: 0; }
      .hu-api-param-label {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
        color: #8694a0; font-weight: 700;
        min-width: 40px;
      }
      .hu-api-param {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 11px;
        background: #fff; border: 1px solid #d8dde8; padding: 1px 6px; border-radius: 4px;
        color: #b8651f;
      }
      .hu-api-noparams { color: #8694a0; font-style: italic; font-size: 11px; }
      .hu-card {
        background: #fff;
        border: 1px solid #e3e7ef;
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 8px;
        box-shadow: 0 3px 10px rgba(8, 16, 30, 0.04);
      }
      /* Tighter section titles inside Ticket 360 cards */
      #hu-ticket360-drawer .hu-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #5e7290; margin-bottom: 6px; }
      #hu-ticket360-drawer .hu-section-title-row { margin-bottom: 6px; }
      #hu-ticket360-drawer .hu-card:last-child { margin-bottom: 0; }
      .hu-ticket-hero {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        background: linear-gradient(135deg, #25343f 0%, #314754 100%);
        border-color: rgba(255, 155, 81, 0.25);
        color: #fff;
      }
      .hu-ticket-hero-main { min-width: 0; width: 100%; }
      .hu-ticket-id-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
      .hu-ticket-id {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: rgba(255,255,255,0.68);
      }
      .hu-ticket-summary {
        font-size: 15px;
        font-weight: 800;
        line-height: 1.35;
      }
      .hu-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .hu-chip {
        display: inline-flex;
        align-items: center;
        padding: 3px 9px;
        border-radius: 999px;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.14);
        font-size: 11px;
        font-weight: 600;
      }
      .hu-section-title,
      .hu-section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 12px;
        font-weight: 800;
        color: #172033;
        margin-bottom: 10px;
      }
      .hu-stat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .hu-stat {
        border: 1px solid #edf0f5;
        border-radius: 7px;
        padding: 10px;
        background: #fbfcfe;
      }
      .hu-stat-link { cursor: pointer; }
      .hu-stat-link:hover { border-color: #b8d7ff; background: #f5f9ff; }
      .hu-stat-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.45px;
        color: #667085;
        margin-bottom: 4px;
      }
      .hu-stat-value { font-size: 13px; font-weight: 700; color: #172033; }
      .hu-stat-sub { font-size: 11px; color: #667085; margin-top: 3px; }
      .hu-list { display: flex; flex-direction: column; gap: 8px; }
      .hu-list-row {
        border: 1px solid #edf0f5;
        border-radius: 7px;
        padding: 10px;
        background: #fff;
      }
      .hu-list-row-link { cursor: pointer; }
      .hu-list-row-link:hover { border-color: #b8d7ff; background: #f8fbff; }
      .hu-list-row-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .hu-list-title { font-size: 13px; font-weight: 700; color: #172033; }
      .hu-list-meta { font-size: 11px; color: #667085; white-space: nowrap; }
      .hu-list-row-sub { font-size: 11px; color: #667085; margin-top: 4px; }
      .hu-list-note {
        font-size: 12px;
        color: #172033;
        margin-top: 8px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .hu-empty-note {
        font-size: 12px;
        color: #667085;
        padding: 4px 2px 0;
      }
      .hu-360-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
      .hu-360-kpi { border: 1px solid #edf0f5; border-radius: 8px; padding: 10px 12px; background: #fbfcfe; }
      .hu-360-kpi-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #667085; margin-bottom: 4px; }
      .hu-360-kpi-value { font-size: 13px; font-weight: 800; color: #172033; display: flex; align-items: center; gap: 6px; }
      .hu-360-kpi-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .hu-360-time-labels { display: flex; justify-content: space-between; font-size: 10px; color: #667085; margin-bottom: 4px; }
      .hu-360-time-track { height: 6px; background: #edf0f5; border-radius: 99px; overflow: hidden; }
      .hu-360-time-fill { height: 100%; border-radius: 99px; }
      .hu-360-time-note { font-size: 10px; color: #667085; margin-top: 4px; text-align: right; }
      .hu-360-act-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
      .hu-360-act-label { font-size: 11px; color: #667085; width: 90px; flex-shrink: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hu-360-act-track { flex: 1; height: 5px; background: #edf0f5; border-radius: 99px; overflow: hidden; }
      .hu-360-act-fill { height: 100%; border-radius: 99px; }
      .hu-360-act-count { font-size: 11px; color: #667085; width: 20px; text-align: right; flex-shrink: 0; }
      .hu-360-tl { display: flex; flex-direction: column; }
      .hu-360-tl-row { display: grid; grid-template-columns: 20px 1fr; gap: 8px; }
      .hu-360-tl-gutter { display: flex; flex-direction: column; align-items: center; padding-top: 3px; }
      .hu-360-tl-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .hu-360-tl-line { width: 1px; flex: 1; background: #e3e7ef; margin-top: 4px; min-height: 16px; }
      .hu-360-tl-body { padding-bottom: 14px; min-width: 0; }
      .hu-360-tl-title { font-size: 12px; font-weight: 700; color: #172033; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-360-tl-meta { font-size: 11px; color: #667085; margin-top: 2px; }
      .hu-360-tl-note { font-size: 11px; color: #5e7290; background: #f8fafc; border: 1px solid #edf0f5; border-radius: 5px; padding: 6px 8px; margin-top: 6px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: break-word; }
      /* Default state inherits Halo's white button styling. Icon colour follows
         currentColor so it stays visible. Active state highlights in HaloPlus
         orange. Triple-class specificity (0,3,1) beats Halo's button.solidbutton.notext (0,2,1). */
      button.hu-360-inject-btn.hu-360-inject-btn.hu-360-inject-btn { color: #25343f !important; transition: background 0.15s, border-color 0.15s, color 0.15s !important; }
      button.hu-360-inject-btn.hu-360-inject-btn.hu-360-inject-btn:hover { background: #fe9200 !important; border-color: #fe9200 !important; color: #fff !important; }
      button.hu-360-inject-btn.hu-360-inject-btn.hu-360-inject-btn.is-active { background: #bf6e00 !important; border-color: #bf6e00 !important; color: #fff !important; box-shadow: 0 0 0 3px rgba(254,146,0,0.25) !important; }

      /* Ticket 360 v2 — banners (VIP, approval, major incident) */
      .hu-360-banners { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      .hu-360-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; border: 1px solid; }
      .hu-360-banner-icon { font-size: 14px; font-weight: 700; flex-shrink: 0; width: 18px; text-align: center; }
      .hu-360-banner-text { font-weight: 600; }
      .hu-360-banner-vip       { background: rgba(168,85,247,0.10); border-color: rgba(168,85,247,0.35); color: #8b3aef; }
      .hu-360-banner-important { background: rgba(245,158,11,0.10); border-color: rgba(245,158,11,0.35); color: #b07209; }
      .hu-360-banner-approval  { background: rgba(59,130,246,0.10); border-color: rgba(59,130,246,0.35); color: #2563eb; }
      .hu-360-banner-major     { background: rgba(239,68,68,0.12);  border-color: rgba(239,68,68,0.40);  color: #c92626; }
      .hu-360-banner-popupnote { background: rgba(245,158,11,0.10); border-color: rgba(245,158,11,0.35); color: #b07209; align-items: flex-start; }
      .hu-360-banner-popupnote-modal {
        background: rgba(239,68,68,0.12);
        border-color: rgba(239,68,68,0.45);
        border-width: 1.5px;
        color: #c92626;
        box-shadow: 0 0 0 4px rgba(239,68,68,0.06);
      }
      .hu-360-popup-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
      .hu-360-popup-body { font-weight: 400; font-size: 11.5px; color: inherit; white-space: pre-wrap; word-break: break-word; opacity: 0.95; }
      .hu-360-popup-meta { font-size: 10.5px; opacity: 0.7; font-weight: 500; }
      .hu-360-popup-close {
        flex-shrink: 0;
        width: 20px; height: 20px;
        border: 0; background: transparent;
        color: currentColor; opacity: 0.55;
        font-size: 16px; line-height: 1;
        cursor: pointer; padding: 0;
        border-radius: 50%;
        margin-left: 4px;
      }
      .hu-360-popup-close:hover { opacity: 1; background: rgba(0,0,0,0.06); }
      html.hu-theme-dark .hu-360-popup-close:hover { background: rgba(255,255,255,0.08); }

      /* Ticket 360 footer (audit link etc.) */
      .hu-360-footer { padding: 14px 14px 18px; display: flex; justify-content: flex-end; }
      .hu-360-foot-link {
        background: none; border: 0; padding: 4px 0;
        font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #8694a0; cursor: pointer; letter-spacing: 0.01em;
        opacity: 0.75; transition: opacity 0.14s, color 0.14s;
      }
      .hu-360-foot-link:hover { color: #25343f; opacity: 1; }
      html.hu-theme-dark .hu-360-foot-link { color: #6b7a8c; }
      html.hu-theme-dark .hu-360-foot-link:hover { color: #edf1f7; }

      /* Audit log drawer */
      .hu-audit-header { padding-bottom: 4px; border-bottom: 1px solid #edf0f5; }
      .hu-audit-filter-row {
        display: flex; align-items: center; gap: 8px; padding: 6px 12px 10px;
      }
      .hu-audit-filter {
        flex: 1; min-width: 0;
        padding: 6px 10px; font-size: 12px;
        border: 1px solid #d8dde8; border-radius: 6px;
        background: #fff; color: #172033;
        outline: none;
      }
      .hu-audit-filter:focus { border-color: #ff9b51; box-shadow: 0 0 0 3px rgba(255,155,81,0.18); }
      .hu-audit-filter-count {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 10.5px; color: #667085; flex-shrink: 0;
      }
      html.hu-theme-dark .hu-audit-header { border-bottom-color: #2b3548; }
      html.hu-theme-dark .hu-audit-filter { background: #0f1626; border-color: #2b3548; color: #edf1f7; }
      html.hu-theme-dark .hu-audit-filter-count { color: #94a3b8; }
      .hu-audit-field-chips {
        display: flex; flex-wrap: wrap; gap: 5px;
        padding: 2px 12px 10px;
      }
      .hu-audit-chip {
        font-size: 10.5px; font-weight: 600;
        padding: 3px 9px; border-radius: 99px;
        border: 1px solid #d8dde8;
        background: #fff; color: #5e7290;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .hu-audit-chip:hover { border-color: #b5bdcc; color: #25343f; }
      .hu-audit-chip.is-active {
        background: #25343f; color: #fff; border-color: #25343f;
      }
      .hu-audit-chip-count {
        display: inline-block; margin-left: 4px;
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 9.5px; opacity: 0.7;
        padding: 1px 4px; border-radius: 99px;
        background: rgba(0,0,0,0.04);
      }
      .hu-audit-chip.is-active .hu-audit-chip-count {
        background: rgba(255,255,255,0.18);
      }
      html.hu-theme-dark .hu-audit-chip {
        background: #1a2236; border-color: #303744; color: #a7afbd;
      }
      html.hu-theme-dark .hu-audit-chip:hover { border-color: #45526a; color: #edf1f7; }
      html.hu-theme-dark .hu-audit-chip.is-active {
        background: #ff9b51; color: #25343f; border-color: #ff9b51;
      }
      html.hu-theme-dark .hu-audit-chip-count { background: rgba(255,255,255,0.06); }
      html.hu-theme-dark .hu-audit-chip.is-active .hu-audit-chip-count {
        background: rgba(0,0,0,0.18);
      }
      .hu-audit-chip.is-empty {
        opacity: 0.35;
        background: transparent;
        color: #94a3b8;
        border-style: dashed;
      }
      .hu-audit-chip.is-empty:hover { color: #94a3b8; border-color: #d8dde8; }
      html.hu-theme-dark .hu-audit-chip.is-empty { color: #525d72; }
      html.hu-theme-dark .hu-audit-chip.is-empty:hover { color: #525d72; border-color: #303744; }
      .hu-audit-change { padding: 2px 0; }
      .hu-audit-change + .hu-audit-change { border-top: 1px dashed rgba(0,0,0,0.04); margin-top: 2px; padding-top: 4px; }
      html.hu-theme-dark .hu-audit-change + .hu-audit-change { border-top-color: rgba(255,255,255,0.05); }
      .hu-audit-change-head { margin-bottom: 4px; }
      .hu-audit-kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 2px 12px;
        margin-top: 2px;
        padding: 6px 10px;
        background: rgba(0,0,0,0.025);
        border-radius: 5px;
        border-left: 2px solid rgba(34,89,188,0.20);
      }
      html.hu-theme-dark .hu-audit-kv { background: rgba(255,255,255,0.03); border-left-color: rgba(99,142,220,0.30); }
      .hu-audit-kv-row { display: contents; }
      .hu-audit-kv-key {
        font-size: 10.5px; font-weight: 600; color: #667085;
        letter-spacing: 0.01em; white-space: nowrap; padding-top: 1px;
      }
      .hu-audit-kv-val {
        font-size: 11.5px; color: #25343f; word-break: break-word;
      }
      html.hu-theme-dark .hu-audit-kv-key { color: #94a3b8; }
      html.hu-theme-dark .hu-audit-kv-val { color: #edf1f7; }
      .hu-audit-inferred-note {
        margin-top: 4px; font-size: 10.5px; color: #8694a0;
        font-style: italic; padding-left: 12px;
      }
      html.hu-theme-dark .hu-audit-inferred-note { color: #6b7a8c; }
      .hu-audit-tx-count {
        font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        background: rgba(34,89,188,0.10); color: #2259bc;
        border: 1px solid rgba(34,89,188,0.22);
        padding: 1px 6px; border-radius: 99px;
      }
      html.hu-theme-dark .hu-audit-tx-count {
        background: rgba(99,142,220,0.15); color: #9ab9ff; border-color: rgba(99,142,220,0.35);
      }
      .hu-audit-detail.is-collapsed {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .hu-audit-toggle {
        background: none; border: 0; padding: 2px 0; margin-top: 2px;
        font-size: 10.5px; color: #ff9b51; cursor: pointer; font-weight: 600;
        margin-left: 48px;
      }
      .hu-audit-toggle:hover { text-decoration: underline; }

      .hu-audit-group { margin-bottom: 12px; }
      .hu-audit-group-h {
        font-size: 10.5px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.06em; color: #8694a0;
        padding: 10px 12px 4px; border-bottom: 1px solid #edf0f5;
      }
      .hu-audit-list { display: flex; flex-direction: column; padding: 2px 0; }
      .hu-audit-row { padding: 7px 12px; border-bottom: 1px solid #edf0f5; font-size: 11.5px; }
      .hu-audit-row:last-child { border-bottom: 0; }
      .hu-audit-head { display: flex; gap: 10px; margin-bottom: 3px; align-items: baseline; }
      .hu-audit-time {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 10.5px; color: #8694a0; flex-shrink: 0;
        min-width: 38px;
      }
      .hu-audit-who { font-weight: 700; color: #25343f; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-audit-detail { color: #5e7290; word-break: break-word; padding-left: 48px; }
      .hu-audit-detail strong { color: #25343f; font-weight: 600; }
      .hu-audit-old { color: #b91c1c; text-decoration: line-through; opacity: 0.8; }
      .hu-audit-new { color: #15803d; }
      .hu-audit-empty { color: #8694a0; font-style: italic; }
      .hu-audit-outcome {
        font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
        background: rgba(255,155,81,0.10); color: #b8651f;
      }
      .hu-audit-table { font-size: 10.5px; color: #8694a0; font-style: italic; }
      html.hu-theme-dark .hu-audit-group-h { color: #6b7a8c; border-bottom-color: #2b3548; }
      html.hu-theme-dark .hu-audit-row { border-bottom-color: #2b3548; }
      html.hu-theme-dark .hu-audit-time { color: #6b7a8c; }
      html.hu-theme-dark .hu-audit-who { color: #edf1f7; }
      html.hu-theme-dark .hu-audit-detail { color: #a7afbd; }
      html.hu-theme-dark .hu-audit-detail strong { color: #edf1f7; }
      html.hu-theme-dark .hu-audit-old { color: #fca5a5; }
      html.hu-theme-dark .hu-audit-new { color: #86efac; }
      html.hu-theme-dark .hu-audit-empty { color: #6b7a8c; }
      html.hu-theme-dark .hu-audit-outcome { background: rgba(255,155,81,0.18); color: #ffb37a; }
      html.hu-theme-dark .hu-audit-table { color: #6b7a8c; }

      /* Aging + activity chips inside the hero card */
      .hu-360-aging { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .hu-360-aging-chip { font-size: 10.5px; color: #667085; background: #f1f4fa; border: 1px solid #e3e7ef; border-radius: 99px; padding: 1px 8px; }

      /* Quick-action pill buttons (text + icon) in hero top-right.
         Solid white background with dark text — works clearly on the dark
         hero gradient in both themes (gradient is fixed regardless of theme). */
      .hu-360-quick-actions { display: inline-flex; gap: 5px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; max-width: 65%; }
      .hu-360-quick-btn {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 11.5px; font-weight: 600; line-height: 1;
        color: #1a2236;
        background: #ffffff;
        border: 1px solid rgba(255,255,255,0.92);
        border-radius: 99px; padding: 5px 11px;
        text-decoration: none; cursor: pointer;
        transition: background 0.12s, transform 0.08s, box-shadow 0.12s;
        white-space: nowrap;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      }
      .hu-360-quick-btn:hover {
        background: #ff9b51;
        color: #fff;
        box-shadow: 0 2px 8px rgba(255,155,81,0.45);
      }
      .hu-360-quick-btn:active { transform: scale(0.96); }
      .hu-360-quick-btn svg { flex-shrink: 0; }

      /* Combined Status & SLA card */
      .hu-360-status-card { padding: 10px 12px; }
      .hu-360-status-top { display: flex; gap: 12px; align-items: flex-start; }
      .hu-360-status-arc { flex-shrink: 0; margin-top: -4px; }
      .hu-360-status-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .hu-360-meta-row { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.35; min-width: 0; }
      .hu-360-meta-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #667085; min-width: 64px; flex-shrink: 0; padding-top: 1px; }
      .hu-360-meta-value { color: #172033; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
      .hu-360-meta-step { display: inline-flex; align-items: center; gap: 6px; }
      .hu-360-workflow-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.22); flex-shrink: 0; }
      .hu-360-status-bars { margin-top: 10px; padding-top: 10px; border-top: 1px solid #edf0f5; display: flex; flex-direction: column; gap: 8px; }

      /* SLA bars (used inside combined status card) */
      .hu-360-sla-row { min-width: 0; }
      .hu-360-sla-label-row { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
      .hu-360-sla-label { font-weight: 600; color: #172033; }
      .hu-360-sla-due { font-variant-numeric: tabular-nums; font-size: 10.5px; }
      .hu-360-sla-track { height: 4px; background: #edf0f5; border-radius: 99px; overflow: hidden; }
      .hu-360-sla-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }

      /* People card v2 — customer joined into one line; assigned to is a clickable picker */
      .hu-360-people { padding: 10px 12px; }
      .hu-360-cust-row, .hu-360-assign-row { display: flex; align-items: flex-start; gap: 10px; padding: 4px 0; min-width: 0; }
      .hu-360-assign-row { border-top: 1px solid #edf0f5; padding-top: 8px; margin-top: 6px; }
      .hu-360-cust-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #5e7290; min-width: 78px; padding-top: 3px; flex-shrink: 0; }
      .hu-360-cust-value { flex: 1; font-size: 12.5px; color: #172033; line-height: 1.4; min-width: 0; }
      .hu-360-cust-link { color: #2563eb; text-decoration: none; }
      .hu-360-cust-link:hover { text-decoration: underline; }
      .hu-360-cust-text { color: #172033; }
      .hu-360-cust-sep { color: #c5cad3; margin: 0 6px; }
      .hu-360-assign-value { flex: 1; min-width: 0; }
      .hu-360-assign-trigger {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 12.5px; font-weight: 600; color: #172033;
        background: #f1f4fa; border: 1px solid #d8dde8;
        border-radius: 6px; padding: 4px 10px; cursor: pointer;
        max-width: 100%;
      }
      .hu-360-assign-trigger:hover { background: #e2e8f3; border-color: #b9c1d1; }
      .hu-360-assign-trigger svg { opacity: 0.5; flex-shrink: 0; }
      .hu-360-assign-extras { font-size: 10.5px; color: #5e7290; margin-top: 4px; line-height: 1.35; }

      /* Agent picker popover */
      .hu-360-agent-pop {
        z-index: 2147483600;
        background: #fff;
        border: 1px solid #d8dde8;
        border-radius: 8px;
        box-shadow: 0 12px 36px rgba(8,16,30,0.18);
        max-height: 320px; display: flex; flex-direction: column;
        overflow: hidden;
      }
      .hu-360-agent-search {
        border: 0; border-bottom: 1px solid #edf0f5;
        padding: 8px 10px; font-size: 12px; outline: none;
        background: transparent; color: #172033;
      }
      /* No top/bottom padding on the list — sticky team headers stick flush
         to the top edge (any padding here was leaking content above them). */
      .hu-360-agent-list { overflow-y: auto; max-height: 260px; padding: 0; }
      .hu-360-agent-row {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        width: 100%; padding: 6px 10px; border: 0; background: transparent;
        text-align: left; cursor: pointer; border-radius: 0;
        font-size: 12px; color: #172033;
      }
      .hu-360-agent-row:hover, .hu-360-agent-row:focus {
        background: #eef4ff; outline: none;
      }
      .hu-360-agent-row:disabled { opacity: 0.55; cursor: progress; }
      .hu-360-agent-team-hdr {
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.06em; color: #5e7290;
        padding: 8px 10px 4px;
        position: sticky; top: 0; background: #fff; z-index: 2;
        /* Slight bottom border for visual separation when sticky */
        border-bottom: 1px solid rgba(0,0,0,0.04);
      }
      html.hu-theme-dark .hu-360-agent-team-hdr {
        color: #94a3b8; background: #1a2236;
        border-bottom-color: rgba(255,255,255,0.05);
      }
      .hu-360-agent-name { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .hu-360-agent-team { font-size: 10.5px; color: #5e7290; flex-shrink: 0; }
      .hu-360-agent-status { padding: 4px 10px 8px; font-size: 10.5px; color: #5e7290; }

      /* Custom fields grid */
      .hu-360-field-count { font-size: 10.5px; color: #667085; background: #f1f4fa; border-radius: 99px; padding: 1px 7px; margin-left: 6px; font-weight: 500; }
      .hu-360-cf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-top: 8px; }
      .hu-360-cf-cell { min-width: 0; }
      .hu-360-cf-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #667085; margin-bottom: 2px; }
      .hu-360-cf-value { font-size: 12px; color: #172033; overflow-wrap: break-word; }

      /* Status-transitions mini timeline */
      .hu-360-trans-track { display: flex; align-items: flex-start; gap: 4px; margin-top: 8px; overflow-x: auto; padding-bottom: 4px; }
      .hu-360-trans-step { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; min-width: 64px; }
      .hu-360-trans-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; margin-bottom: 4px; }
      .hu-360-trans-label { font-size: 10.5px; font-weight: 600; color: #172033; text-align: center; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-360-trans-time { font-size: 9.5px; color: #94a3b8; margin-top: 1px; }
      .hu-360-trans-arrow { color: #cbd5e1; font-size: 14px; margin-top: 1px; align-self: center; flex-shrink: 0; }

      /* KB suggestion */
      .hu-360-kb { border-left: 3px solid #3b82f6; }
      .hu-360-kb-title { font-size: 13px; font-weight: 700; color: #172033; margin-top: 6px; }
      .hu-360-kb-abstract { font-size: 11.5px; color: #5e7290; line-height: 1.45; margin-top: 4px; }
      .hu-360-kb-open { font-size: 11px; color: #2563eb; text-decoration: none; font-weight: 600; }
      .hu-360-kb-open:hover { text-decoration: underline; }

      /* Linked records */
      .hu-360-linked-group { margin-top: 8px; }
      .hu-360-linked-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #667085; margin-bottom: 4px; }
      .hu-360-linked-count { background: #f1f4fa; color: #667085; border-radius: 99px; padding: 0 6px; font-size: 10px; font-weight: 600; margin-left: 4px; letter-spacing: 0; text-transform: none; }
      .hu-360-linked-chips { display: flex; flex-wrap: wrap; gap: 5px; }
      .hu-360-linked-chip { font-size: 11px; color: #2563eb; background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.20); border-radius: 99px; padding: 2px 9px; text-decoration: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-360-linked-chip:hover { background: rgba(59,130,246,0.18); }

      /* Similar tickets */
      .hu-360-similar-avg { font-size: 10.5px; color: #667085; font-weight: 500; }
      .hu-360-similar-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; text-decoration: none; color: inherit; border-bottom: 1px solid #edf0f5; }
      .hu-360-similar-row:last-child { border-bottom: 0; }
      .hu-360-similar-row:hover { background: #f8fafc; }
      .hu-360-similar-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .hu-360-similar-title { font-size: 12px; color: #172033; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-360-similar-meta { font-size: 10.5px; color: #94a3b8; flex-shrink: 0; }
      @media (prefers-color-scheme: dark) {
        .hu-360-kpi { background: #151d2c; border-color: #2b3548; }
        .hu-360-kpi-value { color: #edf1f7; }
        .hu-360-time-track, .hu-360-act-track { background: #2b3548; }
        .hu-360-tl-line { background: #2b3548; }
        .hu-360-tl-title { color: #edf1f7; }
        .hu-360-tl-note { background: #151d2c; border-color: #2b3548; color: #a7afbd; }
        .hu-360-aging-chip { background: #1d2a42; border-color: #2b3548; color: #a7afbd; }
        .hu-360-workflow-step-name { color: #edf1f7; }
        .hu-360-workflow-name { color: #a7afbd; }
        .hu-360-workflow-seq { background: #1d2a42; color: #a7afbd; }
        .hu-360-sla-track { background: #2b3548; }
        .hu-360-sla-label { color: #edf1f7; }
        .hu-360-sla-due, .hu-360-sla-label-row { color: #a7afbd; }
        .hu-360-cf-label { color: #a7afbd; }
        .hu-360-cf-value { color: #edf1f7; }
        .hu-360-field-count { background: #1d2a42; color: #a7afbd; }
        .hu-360-trans-label { color: #edf1f7; }
        .hu-360-trans-arrow { color: #475569; }
        .hu-360-kb-title { color: #edf1f7; }
        .hu-360-kb-abstract { color: #a7afbd; }
        .hu-360-similar-title { color: #edf1f7; }
        .hu-360-similar-row { border-bottom-color: #2b3548; }
        .hu-360-similar-row:hover { background: #1d2a42; }
        .hu-360-linked-count { background: #1d2a42; color: #a7afbd; }
      }
      @media (prefers-color-scheme: dark) {
        .hu-palette, .hu-drawer { background: #171b22; color: #edf1f7; border-color: #303744; }
        .hu-palette-input { background: #171b22; color: #edf1f7; border-color: #303744; }
        .hu-palette-footer { background: #151922; border-color: #303744; color: #a7afbd; }
        .hu-palette-footer .hu-result-title { color: #edf1f7; }
        .hu-result, .hu-row, .hu-icon-btn, .hu-copy { color: #edf1f7; background: transparent; border-color: #303744; }
        .hu-result.hu-active, .hu-result:hover, .hu-row:hover { background: #1d2a42; }
        .hu-result-sub, .hu-row-sub { color: #a7afbd; }
        .hu-drawer-header { border-color: #303744; }
        .hu-toolbar-row { border-color: #303744; }
        .hu-json-formatted { color: #edf1f7; }
        .hu-json-toolbar { background: #151d2c; border-bottom-color: #303744; }
        .hu-json-search { background: #0f1626; border-color: #303744; color: #edf1f7; }
        .hu-json-view-toggle { border-color: #303744; }
        .hu-json-view-btn { background: #1a2236; color: #a7afbd; }
        .hu-json-view-btn + .hu-json-view-btn { border-left-color: #303744; }
        .hu-json-view-btn.is-active { background: #ff9b51; color: #25343f; }
        .hu-json-action { background: #1a2236; border-color: #303744; color: #edf1f7; }
        .hu-json-key { color: #6fa8ff; }
        .hu-json-string { color: #5dd699; }
        .hu-json-number { color: #ffb874; }
        .hu-json-boolean { color: #c89aff; }
        .hu-json-children { border-left-color: #303744; }
        .hu-json-node-header:hover,
        .hu-json-leaf:hover { background: rgba(255, 255, 255, 0.05); }
        .hu-json-mark { background: rgba(255, 200, 80, 0.35); color: #ffd87a; }
        .hu-json-count { color: #94a3b8; }
        .hu-section-row { background: #1a2236; border-color: #303744; }
        .hu-section-label { color: #a7afbd; }
        .hu-api-row:hover { background: #1d2533; }
        .hu-api-toolbar { background: #151d2c; border-bottom-color: #303744; }
        .hu-api-search { background: #0f1626; border-color: #303744; color: #edf1f7; }
        .hu-api-search:focus { border-color: #ff9b51; }
        .hu-api-method-chip { background: #1a2236; border-color: #303744; color: #a7afbd; }
        .hu-api-method-chip:hover { border-color: #45526a; color: #edf1f7; }
        .hu-api-method-chip.is-active { background: #ff9b51; color: #25343f; border-color: #ff9b51; }
        .hu-api-count { color: #94a3b8; }
        .hu-api-empty { color: #94a3b8; }
        .hu-api-row-v2 { border-bottom-color: #2b3548; }
        .hu-api-path { color: #cbd5e1; background: transparent; }
        .hu-api-summary { color: #94a3b8; }
        .hu-api-cat-count { background: rgba(255,155,81,0.18); color: #ffb37a; }
        .hu-api-methods-tag { background: rgba(99, 142, 220, 0.15); color: #9ab9ff; border-color: rgba(99, 142, 220, 0.35); }
        .hu-api-detail { background: #0f1626; border-color: #2b3548; }
        .hu-api-param-label { color: #6b7a8c; }
        .hu-api-param { background: #1a2236; border-color: #303744; color: #ffb37a; }
        .hu-api-noparams { color: #6b7a8c; }
        .hu-card { background: #1a2236; border-color: #303744; box-shadow: none; }
        .hu-ticket-hero { background: linear-gradient(135deg, #25343f 0%, #314754 100%); border-color: rgba(255, 155, 81, 0.24); }
        .hu-section-title, .hu-section-title-row, .hu-stat-value, .hu-list-title, .hu-list-note { color: #edf1f7; }
        .hu-stat { background: #151d2c; border-color: #2b3548; }
        .hu-stat-link:hover, .hu-list-row-link:hover { background: #1d2533; border-color: #35507c; }
        .hu-stat-label, .hu-stat-sub, .hu-list-meta, .hu-list-row-sub, .hu-empty-note { color: #a7afbd; }
        .hu-list-row { background: #151d2c; border-color: #2b3548; }
        /* Ticket 360 v2 dark-mode overrides — the new card text uses
           #172033 by default, which is invisible on the dark card surface. */
        #hu-ticket360-drawer .hu-section-title { color: #94a3b8; }
        .hu-360-meta-value { color: #edf1f7; }
        .hu-360-meta-label { color: #94a3b8; }
        .hu-360-sla-label { color: #edf1f7; }
        .hu-360-sla-due { color: #a7afbd; }
        .hu-360-sla-track { background: #2b3548; }
        .hu-360-status-bars { border-top-color: #2b3548; }
        .hu-360-cust-value, .hu-360-cust-text { color: #edf1f7; }
        .hu-360-cust-label { color: #94a3b8; }
        .hu-360-cust-link { color: #6aa8ff; }
        .hu-360-cust-sep { color: #475569; }
        .hu-360-assign-row { border-top-color: #2b3548; }
        .hu-360-assign-trigger { background: #1d2a42; border-color: #303744; color: #edf1f7; }
        .hu-360-assign-trigger:hover { background: #243154; border-color: #404b62; }
        .hu-360-assign-extras { color: #a7afbd; }
        .hu-360-agent-pop { background: #1a2236; border-color: #303744; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
        .hu-360-agent-search { background: transparent; color: #edf1f7; border-bottom-color: #303744; }
        .hu-360-agent-row { color: #edf1f7; }
        .hu-360-agent-row:hover, .hu-360-agent-row:focus { background: #1d2a42; }
        .hu-360-agent-team { color: #94a3b8; }
        .hu-360-agent-status { color: #94a3b8; }
      }
      .hu-tbl-export-bar { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .hu-tbl-export-bar.hu-tbl-export-inline {
        display: inline-flex; justify-content: flex-start; margin: 0 0 0 6px; vertical-align: middle;
      }
      .hu-tbl-export-wrap { position: relative; }
      .hu-tbl-export-dropdown {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .hu-tbl-export-btn {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: auto;
        min-width: 30px;
        height: 30px;
        padding: 0 12px;
        font: inherit;
        cursor: pointer;
        background-color: rgb(255, 155, 81) !important;
        color: #fff !important;
        border: 0 !important;
        border-radius: 999px;
        white-space: nowrap;
        fill: #fff !important;
      }
      .hu-tbl-export-btn svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        stroke: #fff !important;
        color: #fff !important;
      }
      .hu-tbl-export-menu {
        position: absolute; right: 0; top: calc(100% + 4px); z-index: 2147483598;
        background: #fff; border: 1px solid #d8dde8; border-radius: 6px;
        box-shadow: 0 6px 20px rgba(8,16,30,.14); min-width: 180px; padding: 4px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      .hu-tbl-export-inline .hu-tbl-export-menu { left: 0; right: auto; }
      .hu-tbl-export-menu.hu-align-right { left: auto; right: 0; }
      .hu-tbl-export-menu.hu-align-left { left: 0; right: auto; }
      .hu-tbl-export-item {
        display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0;
        background: transparent; padding: 8px 10px;
        font-size: 12px; color: #172033; border-radius: 4px; cursor: pointer;
      }
      .hu-tbl-export-item svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        fill: currentColor;
        stroke: none;
      }
      .hu-tbl-export-item:hover { background: #eef4ff; }
      @media (prefers-color-scheme: dark) {
        .hu-tbl-export-menu { background: #1a2236; border-color: #303744; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
        .hu-tbl-export-item { color: #d0d7e5; }
        .hu-tbl-export-item:hover { background: #1d2a42; }
      }

      /* Lookup SQL Builder */
        display: block; width: 100%; box-sizing: border-box;
        margin-bottom: 12px; padding: 10px 12px;
        background: #f8fafc; border: 1.5px solid #d0dae8; border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 12px; color: #172033;
      }
        display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;
      }
        font-size: 10px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;
        color: #d96520; background: rgba(255,155,81,0.12); border: 1px solid rgba(255,155,81,0.3);
        border-radius: 4px; padding: 1px 6px;
      }
        padding: 4px 10px; border: 1px solid #c8d5e1; border-radius: 5px;
        background: #fff; color: #3d5068; font-size: 11px; font-weight: 600;
        cursor: pointer; font-family: inherit; transition: all 0.12s;
      }
        padding: 4px 7px; border: 1px solid #c8d5e1; border-radius: 5px;
        background: #fff; color: #172033; font-size: 11px; font-family: inherit; outline: none;
      }
        background: none; border: none; color: #d0390a; font-size: 15px; cursor: pointer;
        padding: 0 4px; opacity: 0.55; line-height: 1; flex-shrink: 0;
      }
        padding: 2px 8px; border: 1px solid rgba(14,148,136,0.3); border-radius: 99px;
        background: rgba(255,155,81,0.08); color: #d96520; font-size: 10.5px; font-weight: 600;
        cursor: pointer; font-family: monospace;
      }
        margin: 0; padding: 8px 10px; font-family: 'Consolas', 'Courier New', monospace;
        font-size: 11px; line-height: 1.6; background: #0f1c2e; color: #a8d8d2;
        border-radius: 5px; border: 1px solid rgba(255,155,81,0.15); white-space: pre-wrap; word-break: break-word;
      }
      @media (prefers-color-scheme: dark) {
      }

      /* ====================================================================
         Ticket 360 v3 — fixed dark drawer with flat sections + hairline dividers.
         All rules below scoped to #hu-ticket360-drawer so other drawers (action
         timeline, JSON inspector, etc.) keep their existing light/dark styling.
      ==================================================================== */
      /* NOTE: don't override position/width/right/top/bottom here — the base
         .hu-drawer rule already provides position: fixed and the inline-style
         push-mode also sets those. We only theme the surface + add the stripe. */
      #hu-ticket360-drawer.hu-drawer {
        background: #0f1218; color: rgba(255,255,255,0.92);
        border-left: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
        font-size: 13px; line-height: 1.45;
      }
      #hu-ticket360-drawer.hu-drawer::before {
        content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
        background: #538dba; z-index: 1; pointer-events: none;
        border-radius: 8px 0 0 8px;
      }
      #hu-ticket360-drawer .hu-drawer-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
        background: transparent;
      }
      #hu-ticket360-drawer .hu-drawer-title {
        font-size: 12px; font-weight: 500; letter-spacing: 0.04em;
        text-transform: uppercase; color: rgba(255,255,255,0.55);
      }
      #hu-ticket360-drawer .hu-icon-btn {
        width: 24px; height: 24px; display: inline-flex; align-items: center;
        justify-content: center; color: rgba(255,255,255,0.55);
        background: transparent; border: 0; border-radius: 6px; cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      #hu-ticket360-drawer .hu-icon-btn:hover {
        background: rgba(255,255,255,0.06); color: #fff;
      }
      #hu-ticket360-drawer .hu-360-loading-indicator {
        display: inline-flex; align-items: center; justify-content: center;
        margin-right: 6px;
      }
      .hu-360-spinner {
        display: inline-block; width: 12px; height: 12px;
        border: 2px solid rgba(255,255,255,0.18);
        border-top-color: rgba(255,255,255,0.75);
        border-radius: 50%; animation: hu-spin 0.7s linear infinite;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-spinner {
        border-color: rgba(0,0,0,0.10);
        border-top-color: #2563eb;
      }
      #hu-ticket360-drawer .hu-drawer-body {
        padding: 0; overflow-y: auto; height: calc(100% - 49px);
      }

      /* Section frame */
      #hu-ticket360-drawer .hu-360-sec {
        padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      #hu-ticket360-drawer .hu-360-sec:last-child { border-bottom: 0; }
      #hu-ticket360-drawer .hu-360-sec-h {
        font-size: 11px; font-weight: 500; letter-spacing: 0.06em;
        text-transform: uppercase; color: rgba(255,255,255,0.45); margin-bottom: 12px;
      }
      #hu-ticket360-drawer .hu-360-sec-h-row {
        display: flex; align-items: center; justify-content: space-between;
      }
      #hu-ticket360-drawer .hu-360-link {
        font-size: 11px; color: #9ec5e5; text-decoration: none;
        letter-spacing: 0; text-transform: none; font-weight: 400; cursor: pointer;
      }
      #hu-ticket360-drawer .hu-360-link:hover { color: #cfe2f1; }

      /* Banner — single, normal flow */
      #hu-ticket360-drawer .hu-360-banner {
        display: flex; align-items: center; gap: 8px; padding: 10px 16px;
        font-size: 12px; font-weight: 500; border-bottom: 1px solid transparent;
        margin: 0; border-radius: 0; border-left: 0; border-right: 0; border-top: 0;
      }
      #hu-ticket360-drawer .hu-360-banner-approval {
        background: rgba(83,141,186,0.10); border-bottom-color: rgba(83,141,186,0.20); color: #9ec5e5;
      }
      #hu-ticket360-drawer .hu-360-banner-vip {
        background: rgba(168,85,247,0.10); border-bottom-color: rgba(168,85,247,0.22); color: #c4a3f0;
      }
      #hu-ticket360-drawer .hu-360-banner-important {
        background: rgba(245,158,11,0.16); border-bottom-color: rgba(245,158,11,0.30); color: #fbbf24;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-banner-important {
        background: #ffedd5; border-bottom-color: #fb923c; color: #9a3412;
      }
      #hu-ticket360-drawer .hu-360-banner-major {
        background: rgba(239,68,68,0.12); border-bottom-color: rgba(239,68,68,0.25); color: #fca5a5;
      }
      #hu-ticket360-drawer .hu-360-banner-icon { flex-shrink: 0; }

      /* Hero */
      #hu-ticket360-drawer .hu-ticket-id {
        font-family: "SF Mono", ui-monospace, Menlo, monospace;
        font-size: 11px; color: rgba(255,255,255,0.55); letter-spacing: 0.02em;
        margin: 0;
      }
      #hu-ticket360-drawer .hu-360-hero { position: relative; }
      #hu-ticket360-drawer .hu-360-meta-row {
        display: flex; align-items: center; gap: 16px;
        margin-bottom: 14px;
      }
      #hu-ticket360-drawer .hu-360-meta-col {
        flex: 1; min-width: 0;
        display: flex; flex-direction: column; gap: 8px;
      }
      #hu-ticket360-drawer .hu-360-meta-col .hu-chip-row,
      #hu-ticket360-drawer .hu-360-meta-col .hu-360-aging {
        margin: 0;
      }
      #hu-ticket360-drawer .hu-360-sla-donut {
        position: relative; flex-shrink: 0;
        width: 140px; height: 72px;
        animation: hu-360-donut-fade 0.45s ease-out;
      }
      /* Status icon sits in the centre of the donut bowl (arc apex at y=4,
         arc ends at y=44, so the bowl midline is around y=24). Uses flex to
         centre the SVG because a sibling rule forces .hu-360-sla-donut svg
         to display:block, which breaks text-align centring. */
      #hu-ticket360-drawer .hu-360-sla-donut-center-icon {
        position: absolute; left: 0; right: 0; top: 30px;
        display: flex; justify-content: center; align-items: center;
        pointer-events: none;
      }
      #hu-ticket360-drawer .hu-360-sla-donut-center-icon svg {
        width: 18px; height: 18px;
      }
      /* Caption sits 8px under the arc, with the full 140px to work with. */
      #hu-ticket360-drawer .hu-360-sla-donut-center {
        position: absolute; left: 0; right: 0; top: 56px;
        text-align: center; pointer-events: none;
        font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
        font-variant-numeric: tabular-nums;
        display: flex; align-items: center; justify-content: center;
        line-height: 1.2;
      }
      /* Truncate with an ellipsis if a label is somehow wider than 140px. */
      #hu-ticket360-drawer .hu-360-sla-donut-center-text {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        min-width: 0;
      }
      #hu-ticket360-drawer .hu-360-sla-donut-center.is-ok,
      #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-ok     { color: #22c55e; }
      #hu-ticket360-drawer .hu-360-sla-donut-center.is-warn,
      #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-warn   { color: #fbbf24; }
      #hu-ticket360-drawer .hu-360-sla-donut-center.is-danger,
      #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-danger { color: #d74a46; }
      .hu-sla-status-icon { vertical-align: -1px; flex-shrink: 0; }
      @keyframes hu-360-donut-fade {
        from { opacity: 0; transform: scale(0.88); }
        to   { opacity: 1; transform: scale(1); }
      }
      #hu-ticket360-drawer .hu-360-sla-donut svg { display: block; }
      #hu-ticket360-drawer .hu-360-sla-donut-track {
        color: rgba(255,255,255,0.08);
      }
      #hu-ticket360-drawer .hu-360-sla-donut-fill.is-ok     { stroke: #22c55e; }
      #hu-ticket360-drawer .hu-360-sla-donut-fill.is-warn   { stroke: #f59e0b; }
      #hu-ticket360-drawer .hu-360-sla-donut-fill.is-danger { stroke: #ef4444; }
      #hu-ticket360-drawer .hu-360-sla-donut-fill-spare { opacity: 0.30; }
      @keyframes hu-360-sla-donut-fill-anim {
        from { stroke-dashoffset: var(--sla-arc-len); }
        to   { stroke-dashoffset: var(--sla-end-offset); }
      }
      #hu-ticket360-drawer .hu-360-sla-donut-fill {
        animation: hu-360-sla-donut-fill-anim 0.9s cubic-bezier(0.4, 0, 0.2, 1) both;
      }
      @keyframes hu-360-sla-bar-fill-anim {
        from { width: 0; }
        to   { width: var(--sla-target-width); }
      }
      #hu-ticket360-drawer .hu-360-sla-fill {
        animation: hu-360-sla-bar-fill-anim 0.9s cubic-bezier(0.4, 0, 0.2, 1) both;
      }
      @media (prefers-reduced-motion: reduce) {
        #hu-ticket360-drawer .hu-360-sla-donut-fill,
        #hu-ticket360-drawer .hu-360-sla-fill { animation-duration: 0.01s; }
      }
      #hu-ticket360-drawer .hu-ticket-summary {
        font-size: 18px; font-weight: 500; margin: 4px 0 10px; color: #fff;
        letter-spacing: -0.01em; line-height: 1.3;
      }
      #hu-ticket360-drawer .hu-ticket-summary--editable {
        cursor: text; padding: 2px 6px; margin-left: -6px; margin-right: -6px;
        border-radius: 4px; transition: background 0.15s;
        outline: 1px solid transparent; outline-offset: 0;
      }
      #hu-ticket360-drawer .hu-ticket-summary--editable:hover {
        background: rgba(255,255,255,0.04);
        outline-color: rgba(255,255,255,0.08);
      }
      #hu-ticket360-drawer .hu-ticket-summary--editable.is-editing,
      #hu-ticket360-drawer .hu-ticket-summary--editable:focus {
        background: rgba(255,255,255,0.06);
        outline-color: rgba(245,158,11,0.5);
        cursor: text;
      }
      #hu-ticket360-drawer .hu-ticket-summary--saving {
        opacity: 0.6; pointer-events: none;
      }
      #hu-ticket360-drawer .hu-chip-row {
        display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
      }
      #hu-ticket360-drawer .hu-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 9px; border-radius: 999px;
        font-size: 11px; font-weight: 500; letter-spacing: 0.01em;
        text-shadow: none; border: 1px solid transparent;
      }
      #hu-ticket360-drawer .hu-chip-status {
        background: rgba(83,141,186,0.18); color: #9ec5e5; border-color: rgba(83,141,186,0.30);
      }
      #hu-ticket360-drawer .hu-chip-status::before {
        content: ""; width: 5px; height: 5px; border-radius: 50%; background: #5b9bd5;
      }
      #hu-ticket360-drawer .hu-chip-status.hu-chip--colored::before { display: none; }
      #hu-ticket360-drawer .hu-chip-priority-medium {
        background: rgba(245,158,11,0.14); color: #fbbf24; border-color: rgba(245,158,11,0.25);
      }
      #hu-ticket360-drawer .hu-chip-priority-high {
        background: rgba(239,68,68,0.14); color: #fca5a5; border-color: rgba(239,68,68,0.25);
      }
      #hu-ticket360-drawer .hu-chip-priority-critical {
        background: rgba(220,38,38,0.20); color: #fda4af; border-color: rgba(220,38,38,0.35);
      }
      #hu-ticket360-drawer .hu-chip-priority-low {
        background: rgba(16,185,129,0.14); color: #6ee7b7; border-color: rgba(16,185,129,0.25);
      }
      #hu-ticket360-drawer .hu-chip-category {
        background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.70); border-color: rgba(255,255,255,0.08);
      }
      #hu-ticket360-drawer .hu-360-aging {
        display: flex; align-items: center; gap: 10px;
        font-size: 11px; color: rgba(255,255,255,0.45); margin-bottom: 14px;
        background: transparent; border: 0; padding: 0;
      }
      #hu-ticket360-drawer .hu-360-aging > span { background: transparent; border: 0; padding: 0; }
      #hu-ticket360-drawer .hu-360-aging > span + span::before {
        content: "·"; margin-right: 10px; color: rgba(255,255,255,0.25);
      }

      /* Quick actions — 4-col grid */
      #hu-ticket360-drawer .hu-360-quick-actions {
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
        margin: 0; max-width: none;
      }
      #hu-ticket360-drawer .hu-360-quick-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        padding: 7px 4px; font-size: 11px; font-weight: 400;
        color: rgba(255,255,255,0.80);
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 6px; text-decoration: none; cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        box-shadow: none; white-space: nowrap;
      }
      #hu-ticket360-drawer .hu-360-quick-btn:hover {
        background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.10);
      }
      #hu-ticket360-drawer .hu-360-quick-btn svg { flex-shrink: 0; opacity: 1; }

      /* Workflow segmented bar */
      #hu-ticket360-drawer .hu-360-wf-row {
        display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
      }
      #hu-ticket360-drawer .hu-360-wf-name { font-size: 13px; color: rgba(255,255,255,0.85); }
      #hu-ticket360-drawer .hu-360-wf-step {
        font-size: 11px; color: rgba(255,255,255,0.50); font-variant-numeric: tabular-nums;
      }
      #hu-ticket360-drawer .hu-360-wf-bar { display: flex; gap: 3px; margin-bottom: 16px; }
      #hu-ticket360-drawer .hu-360-wf-seg {
        flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08);
        overflow: hidden;
        transition: height 0.18s ease-out;
      }
      #hu-ticket360-drawer .hu-360-wf-seg.is-on { background: #538dba; }
      #hu-ticket360-drawer .hu-360-wf-seg.is-current { background: #9ec5e5; }
      /* Stage labels are always in the DOM but invisible at rest. On bar hover
         the segments grow and the labels fade in. */
      #hu-ticket360-drawer .hu-360-wf-seg-label {
        display: block;
        font-size: 9.5px; line-height: 20px; font-weight: 600;
        color: #fff;
        text-shadow: 0 1px 1px rgba(0,0,0,0.35);
        text-align: center; padding: 0 6px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        opacity: 0;
        transition: opacity 0.12s ease-out 0.05s;
        pointer-events: none;
      }
      #hu-ticket360-drawer .hu-360-wf-bar:hover .hu-360-wf-seg { height: 20px; }
      #hu-ticket360-drawer .hu-360-wf-bar:hover .hu-360-wf-seg-label { opacity: 1; }
      /* Pause the pulse while expanded so the label isn't fading in/out. */
      #hu-ticket360-drawer .hu-360-wf-bar:hover .hu-360-wf-seg.is-current { animation: none; }
      @keyframes hu-360-wf-pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(158,197,229,0.45); }
        50%      { opacity: 0.1; box-shadow: 0 0 0 3px rgba(158,197,229,0); }
      }
      #hu-ticket360-drawer .hu-360-wf-bar.is-active .hu-360-wf-seg.is-current {
        animation: hu-360-wf-pulse 4s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        #hu-ticket360-drawer .hu-360-wf-bar.is-active .hu-360-wf-seg.is-current,
        #hu-ticket360-drawer .hu-360-wf-seg,
        #hu-ticket360-drawer .hu-360-wf-seg-label {
          animation: none; transition: none;
        }
      }

      /* SLA bars */
      #hu-ticket360-drawer .hu-360-status-bars {
        display: flex; flex-direction: column; gap: 10px; border-top: 0; padding-top: 0; margin-top: 0;
      }
      /* Split layout: Respond and Fix sit next to each other with widths
         proportional to each SLA's total duration (flex-grow set inline). */
      #hu-ticket360-drawer .hu-360-status-bars.hu-360-status-bars--split {
        flex-direction: row; gap: 6px; align-items: stretch;
      }
      #hu-ticket360-drawer .hu-360-sla-row {
        display: flex; flex-direction: column; gap: 5px; margin: 0;
      }
      #hu-ticket360-drawer .hu-360-status-bars--split .hu-360-sla-label-row {
        font-size: 11px; gap: 6px;
        /* Allow labels to wrap past the bar boundary instead of truncating
           with an ellipsis when the bar's proportional width is too narrow. */
        overflow: visible;
      }
      #hu-ticket360-drawer .hu-360-status-bars--split .hu-360-sla-label,
      #hu-ticket360-drawer .hu-360-status-bars--split .hu-360-sla-due {
        white-space: nowrap; overflow: visible; text-overflow: clip;
        flex-shrink: 0;
      }
      #hu-ticket360-drawer .hu-360-sla-label-row {
        display: flex; align-items: center; justify-content: space-between; font-size: 12px;
      }
      #hu-ticket360-drawer .hu-360-sla-label { color: rgba(255,255,255,0.70); font-weight: 400; }
      #hu-ticket360-drawer .hu-360-sla-due {
        font-weight: 500; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.70);
      }
      #hu-ticket360-drawer .hu-360-sla-due.is-ok { color: #10b981; }
      #hu-ticket360-drawer .hu-360-sla-due.is-warn { color: #f59e0b; }
      #hu-ticket360-drawer .hu-360-sla-due.is-danger { color: #ef4444; }
      #hu-ticket360-drawer .hu-360-sla-track {
        position: relative;
        height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden;
      }
      #hu-ticket360-drawer .hu-360-sla-fill {
        position: absolute; left: 0; top: 0;
        height: 100%; border-radius: 2px; background: rgba(255,255,255,0.40);
      }
      #hu-ticket360-drawer .hu-360-sla-fill.is-ok { background: #10b981; }
      #hu-ticket360-drawer .hu-360-sla-fill.is-warn { background: #f59e0b; }
      #hu-ticket360-drawer .hu-360-sla-fill.is-danger { background: #ef4444; }
      /* Spare overlay sits behind the main fill and uses the same hue at low
         opacity, so closed-met SLAs read as "used % dark + spare % light". */
      #hu-ticket360-drawer .hu-360-sla-fill-spare { opacity: 0.30; }

      /* Dates grid — Opened + Due side-by-side as a 2-col layout */
      #hu-ticket360-drawer .hu-360-dates {
        display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px;
        margin-top: 14px; padding-top: 14px;
        border-top: 1px solid rgba(255,255,255,0.05); font-size: 12px;
      }
      #hu-ticket360-drawer .hu-360-dates-k {
        color: rgba(255,255,255,0.45); font-size: 10.5px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      #hu-ticket360-drawer .hu-360-dates-v {
        color: rgba(255,255,255,0.85); font-variant-numeric: tabular-nums;
      }

      /* People — side-by-side Customer + Assignee on roomy widths,
         stacking on narrower drawers (< 440px). */
      #hu-ticket360-drawer .hu-360-people {
        display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
        align-items: start;
      }
      #hu-ticket360-drawer .hu-360-people > .hu-360-sec-h { grid-column: 1 / -1; }
      #hu-ticket360-drawer .hu-360-person {
        display: flex; align-items: center; gap: 10px; padding: 0; min-width: 0; flex-wrap: wrap;
      }
      #hu-ticket360-drawer .hu-360-person + .hu-360-person {
        border-top: 0;
      }
      @media (max-width: 460px) {
        #hu-ticket360-drawer .hu-360-people { grid-template-columns: 1fr; }
        #hu-ticket360-drawer .hu-360-person + .hu-360-person {
          border-top: 1px solid rgba(255,255,255,0.05); padding-top: 10px;
        }
      }
      #hu-ticket360-drawer .hu-360-additional-agents {
        flex-basis: 100%; margin-top: 6px; margin-left: 42px;
        font-size: 11px; color: rgba(255,255,255,0.50);
      }
      #hu-ticket360-drawer .hu-360-avatar {
        width: 32px; height: 32px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 500; letter-spacing: 0.02em; flex-shrink: 0;
        overflow: hidden;
      }
      #hu-ticket360-drawer .hu-360-avatar--img {
        background: transparent !important; padding: 0;
      }
      #hu-ticket360-drawer .hu-360-avatar--img img {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      #hu-ticket360-drawer .hu-360-avatar-customer {
        background: rgba(168,85,247,0.18); color: #c4a3f0;
      }
      #hu-ticket360-drawer .hu-360-avatar-agent {
        background: rgba(83,141,186,0.20); color: #9ec5e5;
      }
      #hu-ticket360-drawer .hu-360-person-main { flex: 1; min-width: 0; }
      #hu-ticket360-drawer .hu-360-person-label {
        font-size: 11px; color: rgba(255,255,255,0.45); margin-bottom: 1px;
      }
      #hu-ticket360-drawer .hu-360-person-name { font-size: 13px; color: #fff; }
      #hu-ticket360-drawer .hu-360-person-name a { color: #fff; text-decoration: none; }
      #hu-ticket360-drawer .hu-360-person-name a:hover { color: #9ec5e5; }
      #hu-ticket360-drawer .hu-360-person-sub {
        font-size: 11px; color: rgba(255,255,255,0.50); margin-top: 1px;
      }
      #hu-ticket360-drawer .hu-360-person-sub a { color: inherit; text-decoration: none; }
      #hu-ticket360-drawer .hu-360-person-sub a:hover { color: #9ec5e5; }
      #hu-ticket360-drawer .hu-360-cust-sep {
        margin: 0 6px; color: rgba(255,255,255,0.25);
      }
      /* VIP / Key contact inline marker next to the customer name */
      #hu-ticket360-drawer .hu-360-cust-marker {
        display: inline-flex; align-items: center; gap: 4px;
        margin-left: 8px; padding: 2px 7px;
        font-size: 9.5px; font-weight: 600; letter-spacing: 0.04em;
        text-transform: uppercase; border-radius: 99px;
        vertical-align: middle; line-height: 1;
      }
      #hu-ticket360-drawer .hu-360-cust-marker svg {
        flex-shrink: 0; vertical-align: middle;
      }
      #hu-ticket360-drawer .hu-360-cust-marker-vip {
        background: rgba(168,85,247,0.18); color: #c4a3f0; border: 1px solid rgba(168,85,247,0.30);
      }
      #hu-ticket360-drawer .hu-360-cust-marker-key {
        background: rgba(245,158,11,0.16); color: #fbbf24; border: 1px solid rgba(245,158,11,0.28);
      }
      #hu-ticket360-drawer .hu-360-assign-trigger {
        display: inline-flex; align-items: center; gap: 4px;
        background: transparent; border: 0; color: rgba(255,255,255,0.55);
        font-size: 11px; cursor: pointer; padding: 4px 6px; border-radius: 4px;
        transition: background 0.15s, color 0.15s;
      }
      #hu-ticket360-drawer .hu-360-assign-trigger:hover {
        background: rgba(255,255,255,0.06); color: #fff;
      }
      #hu-ticket360-drawer .hu-360-person--clickable {
        cursor: pointer; border-radius: 6px;
        margin: 0 -6px; padding-left: 6px; padding-right: 6px;
        transition: background 0.15s;
      }
      #hu-ticket360-drawer .hu-360-person--clickable:hover,
      #hu-ticket360-drawer .hu-360-person--clickable:focus-visible {
        background: rgba(255,255,255,0.04); outline: none;
      }
      #hu-ticket360-drawer .hu-360-person-caret {
        color: rgba(255,255,255,0.45); flex-shrink: 0;
        transition: color 0.15s, transform 0.15s;
      }
      #hu-ticket360-drawer .hu-360-person--clickable:hover .hu-360-person-caret {
        color: #fff;
      }

      /* Timeline */
      #hu-ticket360-drawer .hu-360-tl { display: flex; flex-direction: column; }
      #hu-ticket360-drawer .hu-360-tl-row {
        display: flex; gap: 12px; padding-bottom: 14px; position: relative;
      }
      #hu-ticket360-drawer .hu-360-tl-row:last-child { padding-bottom: 0; }
      #hu-ticket360-drawer .hu-360-tl-gutter {
        flex-shrink: 0; display: flex; flex-direction: column; align-items: center; width: 8px;
        padding-top: 0;
      }
      #hu-ticket360-drawer .hu-360-tl-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        margin-top: 4px; border: 2px solid #0f1218; background: rgba(255,255,255,0.25);
        box-shadow: none;
      }
      #hu-ticket360-drawer .hu-360-tl-dot.is-ok {
        background: #10b981; box-shadow: 0 0 0 1px rgba(16,185,129,0.30);
      }
      #hu-ticket360-drawer .hu-360-tl-dot.is-warn {
        background: #f59e0b; box-shadow: 0 0 0 1px rgba(245,158,11,0.30);
      }
      #hu-ticket360-drawer .hu-360-tl-dot.is-danger {
        background: #ef4444; box-shadow: 0 0 0 1px rgba(239,68,68,0.30);
      }
      #hu-ticket360-drawer .hu-360-tl-dot.is-muted { background: rgba(255,255,255,0.25); }
      #hu-ticket360-drawer .hu-360-tl-line {
        flex: 1; width: 1px; background: rgba(255,255,255,0.08); margin-top: 4px; min-height: 8px;
      }
      #hu-ticket360-drawer .hu-360-tl-body { flex: 1; min-width: 0; padding-bottom: 4px; }
      #hu-ticket360-drawer .hu-360-tl-th {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 8px; margin-bottom: 2px;
      }
      #hu-ticket360-drawer .hu-360-tl-th-l {
        display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1;
      }
      #hu-ticket360-drawer .hu-360-tl-title {
        font-size: 12px; font-weight: 500; color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #hu-ticket360-drawer .hu-360-tl-dur {
        font-size: 10.5px; font-weight: 500; color: rgba(255,255,255,0.85);
        background: rgba(245,158,11,0.18); border: 1px solid rgba(245,158,11,0.35);
        padding: 1px 6px; border-radius: 999px; flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      #hu-ticket360-drawer .hu-360-tl-dur.is-adjusted {
        background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.45);
        text-decoration: underline dotted rgba(255,255,255,0.45);
        text-underline-offset: 2px;
      }
      #hu-ticket360-drawer .hu-360-tl-time {
        font-size: 11px; color: rgba(255,255,255,0.45); flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      #hu-ticket360-drawer .hu-360-tl-note {
        font-size: 11px; color: rgba(255,255,255,0.55); line-height: 1.5;
        background: transparent; border: 0; padding: 0; margin-top: 0;
      }
      #hu-ticket360-drawer .hu-360-tl-note strong {
        color: rgba(255,255,255,0.85); font-weight: 500;
      }
      #hu-ticket360-drawer .hu-360-tl-kv {
        display: grid; grid-template-columns: minmax(0, 140px) minmax(0, 1fr);
        gap: 2px 10px; margin-top: 6px; padding: 8px 10px;
        background: rgba(255,255,255,0.03); border-radius: 5px; font-size: 11px;
        align-items: start;
      }
      #hu-ticket360-drawer .hu-360-tl-kv-k {
        color: rgba(255,255,255,0.45);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #hu-ticket360-drawer .hu-360-tl-kv-v {
        color: rgba(255,255,255,0.80); overflow-wrap: anywhere;
      }

      /* Existing cards (KB, linked, similar, custom fields, status history,
         commercial trace) styled as flat sections too — same hairline pattern. */
      #hu-ticket360-drawer .hu-card {
        background: transparent; border: 0; border-radius: 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        padding: 16px; margin-bottom: 0; box-shadow: none;
      }
      #hu-ticket360-drawer .hu-card:last-child { border-bottom: 0; }
      #hu-ticket360-drawer .hu-section-title {
        font-size: 11px; font-weight: 500; letter-spacing: 0.06em;
        text-transform: uppercase; color: rgba(255,255,255,0.45); margin-bottom: 12px;
      }
      #hu-ticket360-drawer .hu-section-title-row { margin-bottom: 12px; }
      #hu-ticket360-drawer .hu-360-cf-label,
      #hu-ticket360-drawer .hu-360-linked-label,
      #hu-ticket360-drawer .hu-360-cf-label { color: rgba(255,255,255,0.45); }
      #hu-ticket360-drawer .hu-360-cf-value,
      #hu-ticket360-drawer .hu-360-kb-title,
      #hu-ticket360-drawer .hu-360-similar-title { color: rgba(255,255,255,0.92); }
      #hu-ticket360-drawer .hu-360-kb-abstract,
      #hu-ticket360-drawer .hu-360-similar-meta,
      #hu-ticket360-drawer .hu-360-trans-time { color: rgba(255,255,255,0.50); }
      #hu-ticket360-drawer .hu-360-linked-chip {
        background: rgba(83,141,186,0.12); color: #9ec5e5; border-color: rgba(83,141,186,0.25);
      }
      #hu-ticket360-drawer .hu-360-linked-chip:hover { background: rgba(83,141,186,0.22); }
      #hu-ticket360-drawer .hu-360-trans-label { color: rgba(255,255,255,0.85); }
      #hu-ticket360-drawer .hu-360-trans-arrow { color: rgba(255,255,255,0.20); }
      #hu-ticket360-drawer .hu-360-similar-row {
        border-bottom-color: rgba(255,255,255,0.05);
      }
      #hu-ticket360-drawer .hu-360-similar-row:hover { background: rgba(255,255,255,0.03); }
      #hu-ticket360-drawer .hu-360-field-count {
        background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55);
      }
      #hu-ticket360-drawer .hu-360-linked-count {
        background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55);
      }

      /* Clickable chip (status / priority) — adds a subtle hover affordance
         so users discover they can change those fields by clicking. */
      #hu-ticket360-drawer .hu-chip-clickable {
        cursor: pointer; font: inherit; outline: none;
        transition: filter 0.12s, transform 0.08s;
      }
      #hu-ticket360-drawer .hu-chip-clickable:hover { filter: brightness(1.18); }
      #hu-ticket360-drawer .hu-chip-clickable:active { transform: scale(0.97); }
      #hu-ticket360-drawer .hu-chip-clickable .hu-chip-caret {
        margin-left: 5px; opacity: 0.75; flex-shrink: 0;
        transition: opacity 0.12s, transform 0.12s;
      }
      #hu-ticket360-drawer .hu-chip-clickable:hover .hu-chip-caret {
        opacity: 1; transform: translateY(1px);
      }

      /* Inline note editor — sits between hero and the next section */
      .hu-360-note-editor {
        margin: 12px 16px 0; padding: 12px; border-radius: 6px;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      }
      .hu-360-note-text {
        width: 100%; box-sizing: border-box; resize: vertical;
        background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.10);
        border-radius: 5px; padding: 8px 10px; color: rgba(255,255,255,0.92);
        font-size: 12px; font-family: inherit; line-height: 1.5; min-height: 80px; outline: none;
      }
      .hu-360-note-text:focus { border-color: rgba(83,141,186,0.55); }
      .hu-360-note-actions {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; margin-top: 8px;
      }
      .hu-360-note-visibility { font-size: 11px; color: rgba(255,255,255,0.60); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
      .hu-360-note-visibility input { margin: 0; }
      .hu-360-note-btns { display: flex; gap: 6px; }
      .hu-360-note-cancel, .hu-360-note-save {
        padding: 5px 10px; font-size: 11px; font-weight: 500;
        border-radius: 5px; border: 1px solid rgba(255,255,255,0.10);
        background: transparent; color: rgba(255,255,255,0.70); cursor: pointer;
      }
      .hu-360-note-cancel:hover { background: rgba(255,255,255,0.06); color: #fff; }
      .hu-360-note-save { background: #538dba; color: #fff; border-color: #538dba; }
      .hu-360-note-save:hover { background: #6ea0c8; }
      .hu-360-note-status { font-size: 10.5px; color: rgba(255,255,255,0.55); margin-top: 6px; }
      .hu-360-mention-pop {
        position: fixed; z-index: 2147483646;
        min-width: 220px; max-width: 320px;
        background: #1a2236; border: 1px solid #303744;
        border-radius: 6px;
        box-shadow: 0 12px 36px rgba(0,0,0,0.5);
        overflow: hidden;
      }
      .hu-360-mention-list { max-height: 220px; overflow-y: auto; }
      .hu-360-mention-row {
        display: flex; align-items: center; gap: 8px;
        width: 100%; text-align: left;
        padding: 6px 10px; background: transparent;
        border: 0; cursor: pointer; color: #edf1f7;
        font-size: 12px; font-family: inherit;
      }
      .hu-360-mention-row:hover,
      .hu-360-mention-row.is-active { background: #2a3a55; }
      .hu-360-mention-name { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .hu-360-mention-team { font-size: 10.5px; color: #94a3b8; flex-shrink: 0; }
      .hu-360-mention-empty { padding: 8px 10px; font-size: 11.5px; color: #94a3b8; }
      html.hu-theme-light .hu-360-mention-pop { background: #fff; border-color: #d8dde8; box-shadow: 0 12px 36px rgba(8,16,30,0.18); }
      html.hu-theme-light .hu-360-mention-row { color: #172033; }
      html.hu-theme-light .hu-360-mention-row:hover,
      html.hu-theme-light .hu-360-mention-row.is-active { background: #eef4ff; }
      html.hu-theme-light .hu-360-mention-team { color: #5e7290; }
      html.hu-theme-light .hu-360-mention-empty { color: #5e7290; }
      .hu-360-time-row { display: flex; gap: 10px; }
      .hu-360-time-label {
        display: flex; flex-direction: column; gap: 4px;
        font-size: 10.5px; color: rgba(255,255,255,0.60);
        flex: 0 0 110px;
      }
      .hu-360-time-label-grow { flex: 1; min-width: 0; }
      .hu-360-time-row input {
        background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.10);
        border-radius: 5px; padding: 6px 8px; color: rgba(255,255,255,0.92);
        font-size: 12px; font-family: inherit; outline: none;
      }
      .hu-360-time-row input:focus { border-color: rgba(83,141,186,0.55); }
      html.hu-theme-light .hu-360-time-label { color: #5e7290; }
      html.hu-theme-light .hu-360-time-row input { background: #fff; border-color: #d8dde8; color: #172033; }
      html.hu-theme-light .hu-360-time-row input:focus { border-color: #2563eb; }

      /* Status/priority choice picker popover */
      .hu-360-choice-pop {
        z-index: 2147483600;
        background: #1a2236; border: 1px solid #303744; border-radius: 6px;
        box-shadow: 0 12px 36px rgba(0,0,0,0.5);
        max-height: 320px; display: flex; flex-direction: column; overflow: hidden;
      }
      .hu-360-choice-list { overflow-y: auto; max-height: 280px; padding: 4px; }
      .hu-360-choice-row {
        display: flex; align-items: center; gap: 8px;
        width: 100%; padding: 6px 8px; border: 0; background: transparent;
        text-align: left; cursor: pointer; border-radius: 4px;
        font-size: 12px; color: rgba(255,255,255,0.92);
      }
      .hu-360-choice-row:hover, .hu-360-choice-row:focus {
        background: rgba(255,255,255,0.08); outline: none;
      }
      .hu-360-choice-row.is-current { background: rgba(83,141,186,0.15); color: #fff; }
      .hu-360-choice-row:disabled { opacity: 0.5; cursor: progress; }
      .hu-360-choice-dot {
        width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
        background: rgba(255,255,255,0.25);
      }
      .hu-360-choice-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hu-360-choice-status { padding: 4px 10px 8px; font-size: 10.5px; color: rgba(255,255,255,0.55); }

      /* Light-mode overrides — same flat-section / hairline pattern, just
         swap surface + text colours. Triggered via the host's hu-theme-light
         class OR the @media query for users on system light without an
         explicit extension theme. */
      html.hu-theme-light #hu-ticket360-drawer.hu-drawer { background: #ffffff; color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-drawer-header { border-bottom-color: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-drawer-title { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-icon-btn { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-icon-btn:hover { background: #f1f4fa; color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sec { border-bottom-color: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sec-h { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-link { color: #2563eb; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-link:hover { color: #1d4ed8; }
      html.hu-theme-light #hu-ticket360-drawer .hu-ticket-id { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-ticket-summary { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-track { color: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center.is-ok,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-ok     { color: #15803d; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center.is-warn,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-warn   { color: #b45309; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center.is-danger,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-donut-center-icon.is-danger { color: #b91c1c; }
      html.hu-theme-light #hu-ticket360-drawer .hu-ticket-summary--editable:hover {
        background: #f1f4fa; outline-color: #e3e7ef;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-ticket-summary--editable.is-editing,
      html.hu-theme-light #hu-ticket360-drawer .hu-ticket-summary--editable:focus {
        background: #fffbeb; outline-color: #fcd34d;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-status { background: rgba(83,141,186,0.12); color: #2563eb; border-color: rgba(83,141,186,0.30); }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-priority-medium { background: rgba(245,158,11,0.12); color: #b07209; border-color: rgba(245,158,11,0.30); }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-priority-high { background: rgba(239,68,68,0.12); color: #c92626; border-color: rgba(239,68,68,0.30); }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-priority-critical { background: rgba(220,38,38,0.18); color: #9b1c1c; border-color: rgba(220,38,38,0.35); }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-priority-low { background: rgba(16,185,129,0.12); color: #047857; border-color: rgba(16,185,129,0.30); }
      html.hu-theme-light #hu-ticket360-drawer .hu-chip-category { background: #f1f4fa; color: #5e7290; border-color: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-aging { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-aging > span + span::before { color: #cbd5e1; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-quick-btn { color: #5e7290; background: #fbfcfe; border-color: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-quick-btn:hover { background: #f1f4fa; color: #172033; border-color: #c5cad3; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-name { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-step { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-seg { background: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-seg.is-on { background: #538dba; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-seg.is-current { background: #2563eb; }
      @keyframes hu-360-wf-pulse-light {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(37,99,235,0.45); }
        50%      { opacity: 0.1; box-shadow: 0 0 0 3px rgba(37,99,235,0); }
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-wf-bar.is-active .hu-360-wf-seg.is-current {
        animation-name: hu-360-wf-pulse-light;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-label { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-due { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-due.is-ok { color: #059669; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-due.is-warn { color: #d97706; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-due.is-danger { color: #dc2626; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-sla-track { background: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-dates { border-top-color: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-dates-k { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-dates-v { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person + .hu-360-person { border-top-color: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-avatar-customer { background: rgba(168,85,247,0.14); color: #7c3aed; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-avatar-agent { background: rgba(83,141,186,0.18); color: #2563eb; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-label { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-name { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-name a { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-name a:hover { color: #2563eb; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-sub { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-sub a:hover { color: #2563eb; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-cust-sep { color: #cbd5e1; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-cust-marker-vip {
        background: rgba(168,85,247,0.12); color: #7c3aed; border-color: rgba(168,85,247,0.30);
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-cust-marker-key {
        background: #ffedd5; color: #9a3412; border-color: #fb923c;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-assign-trigger { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-assign-trigger:hover { background: #f1f4fa; color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person--clickable:hover,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person--clickable:focus-visible {
        background: #f1f4fa;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person-caret { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-person--clickable:hover .hu-360-person-caret {
        color: #172033;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-dot { border-color: #fff; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-dot.is-muted { background: #cbd5e1; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-line { background: #e3e7ef; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-title { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-time { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-dur {
        color: #92400e; background: #fef3c7; border-color: #fcd34d;
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-dur.is-adjusted {
        color: #3730a3; background: #e0e7ff; border-color: #a5b4fc;
        text-decoration-color: rgba(55,48,163,0.45);
      }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-note { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-note strong { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-kv { background: #f8fafc; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-kv-k { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-tl-kv-v { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-card { border-bottom-color: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-section-title { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-cf-label,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-linked-label { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-cf-value,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-kb-title,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-similar-title { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-kb-abstract,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-similar-meta,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-trans-time { color: #5e7290; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-linked-chip { background: rgba(59,130,246,0.08); color: #2563eb; border-color: rgba(59,130,246,0.20); }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-linked-chip:hover { background: rgba(59,130,246,0.18); }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-trans-label { color: #172033; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-trans-arrow { color: #cbd5e1; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-similar-row { border-bottom-color: #edf0f5; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-similar-row:hover { background: #f8fafc; }
      html.hu-theme-light #hu-ticket360-drawer .hu-360-field-count,
      html.hu-theme-light #hu-ticket360-drawer .hu-360-linked-count { background: #f1f4fa; color: #5e7290; }
      html.hu-theme-light .hu-360-note-editor { background: #f8fafc; border-color: #e3e7ef; }
      html.hu-theme-light .hu-360-note-text { background: #fff; border-color: #d8dde8; color: #172033; }
      html.hu-theme-light .hu-360-note-text:focus { border-color: #2563eb; }
      html.hu-theme-light .hu-360-note-visibility { color: #5e7290; }
      html.hu-theme-light .hu-360-note-cancel { border-color: #d8dde8; color: #5e7290; }
      html.hu-theme-light .hu-360-note-cancel:hover { background: #f1f4fa; color: #172033; }
      html.hu-theme-light .hu-360-note-save { background: #2563eb; border-color: #2563eb; }
      html.hu-theme-light .hu-360-note-save:hover { background: #1d4ed8; }
      html.hu-theme-light .hu-360-note-status { color: #5e7290; }
      html.hu-theme-light .hu-360-choice-pop { background: #fff; border-color: #d8dde8; box-shadow: 0 12px 36px rgba(8,16,30,0.2); }
      html.hu-theme-light .hu-360-choice-row { color: #172033; }
      html.hu-theme-light .hu-360-choice-row:hover, html.hu-theme-light .hu-360-choice-row:focus { background: #f1f4fa; }
      html.hu-theme-light .hu-360-choice-row.is-current { background: rgba(59,130,246,0.10); color: #172033; }
      html.hu-theme-light .hu-360-choice-status { color: #5e7290; }
    `;
    document.documentElement.appendChild(style);
    applyThemeStyles();
  }

  function applyTheme(theme) {
    HU.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.classList.toggle('hu-theme-dark', HU.theme === 'dark');
    document.documentElement.classList.toggle('hu-theme-light', HU.theme !== 'dark');
    applyThemeStyles();
  }

  function applyThemeStyles() {
    let style = document.getElementById('haloplus-theme-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'haloplus-theme-styles';
      document.documentElement.appendChild(style);
    }

    if (HU.theme !== 'dark') {
      style.textContent = `
      html.hu-theme-light .hu-palette,
      html.hu-theme-light .hu-drawer { background: #fff; color: #172033; border-color: #d8dde8; }
      html.hu-theme-light .hu-palette-input { background: #fff; color: #101827; border-color: #e3e7ef; }
      html.hu-theme-light .hu-palette-footer { background: #fbfcff; border-color: #e3e7ef; color: #667085; }
      html.hu-theme-light .hu-palette-footer .hu-result-title { color: #172033; }
      html.hu-theme-light .hu-result,
      html.hu-theme-light .hu-row,
      html.hu-theme-light .hu-icon-btn,
      html.hu-theme-light .hu-copy { color: #172033; background: transparent; border-color: #d8dde8; }
      html.hu-theme-light .hu-result.hu-active,
      html.hu-theme-light .hu-result:hover,
      html.hu-theme-light .hu-row:hover { background: #eef4ff; }
      html.hu-theme-light .hu-result-sub,
      html.hu-theme-light .hu-row-sub { color: #667085; }
      html.hu-theme-light .hu-drawer-header,
      html.hu-theme-light .hu-toolbar-row { border-color: #edf0f5; }
      html.hu-theme-light .hu-json-formatted { color: #172033; }
      html.hu-theme-light .hu-json-toolbar { background: #fff; border-bottom-color: #e3e7ef; }
      html.hu-theme-light .hu-json-search { background: #fff; border-color: #d8dde8; color: #172033; }
      html.hu-theme-light .hu-json-view-toggle { border-color: #d8dde8; }
      html.hu-theme-light .hu-json-view-btn { background: #fff; color: #5e7290; }
      html.hu-theme-light .hu-json-view-btn.is-active { background: #25343f; color: #fff; }
      html.hu-theme-light .hu-json-action { background: #fff; border-color: #d8dde8; color: #25343f; }
      html.hu-theme-light .hu-json-key { color: #2259bc; }
      html.hu-theme-light .hu-json-string { color: #1f7a3a; }
      html.hu-theme-light .hu-json-children { border-left-color: #e3e7ef; }
      html.hu-theme-light .hu-section-row { background: #f3f6fc; border-color: #e3e7ef; }
      html.hu-theme-light .hu-section-label { color: #667085; }
      html.hu-theme-light .hu-api-row:hover { background: #f8fafc; }
      html.hu-theme-light .hu-card { background: #fff; border-color: #e3e7ef; box-shadow: 0 3px 10px rgba(8, 16, 30, 0.04); }
      html.hu-theme-light .hu-ticket-hero { background: linear-gradient(135deg, #25343f 0%, #314754 100%); border-color: rgba(255, 155, 81, 0.25); }
      html.hu-theme-light .hu-section-title,
      html.hu-theme-light .hu-section-title-row,
      html.hu-theme-light .hu-stat-value,
      html.hu-theme-light .hu-list-title,
      html.hu-theme-light .hu-list-note,
      html.hu-theme-light .hu-360-kpi-value,
      html.hu-theme-light .hu-360-tl-title { color: #172033; }
      html.hu-theme-light .hu-stat,
      html.hu-theme-light .hu-360-kpi { background: #fbfcfe; border-color: #edf0f5; }
      html.hu-theme-light .hu-stat-link:hover { border-color: #b8d7ff; background: #f5f9ff; }
      html.hu-theme-light .hu-list-row-link:hover { border-color: #b8d7ff; background: #f8fbff; }
      html.hu-theme-light .hu-stat-label,
      html.hu-theme-light .hu-stat-sub,
      html.hu-theme-light .hu-list-meta,
      html.hu-theme-light .hu-list-row-sub,
      html.hu-theme-light .hu-empty-note,
      html.hu-theme-light .hu-360-time-labels,
      html.hu-theme-light .hu-360-time-note,
      html.hu-theme-light .hu-360-act-label,
      html.hu-theme-light .hu-360-act-count,
      html.hu-theme-light .hu-360-tl-meta { color: #667085; }
      html.hu-theme-light .hu-list-row { background: #fff; border-color: #edf0f5; }
      html.hu-theme-light .hu-360-time-track,
      html.hu-theme-light .hu-360-act-track { background: #edf0f5; }
      html.hu-theme-light .hu-360-tl-line { background: #e3e7ef; }
      html.hu-theme-light .hu-360-tl-note { background: #f8fafc; border-color: #edf0f5; color: #5e7290; }
      html.hu-theme-light .hu-tbl-export-menu { background: #fff; border-color: #d8dde8; box-shadow: 0 6px 20px rgba(8,16,30,.14); }
      html.hu-theme-light .hu-tbl-export-item { color: #172033; }
      html.hu-theme-light .hu-tbl-export-item:hover { background: #eef4ff; }
      `;
      return;
    }

    style.textContent = `
      html.hu-theme-dark .hu-palette,
      html.hu-theme-dark .hu-drawer { background: #171b22; color: #edf1f7; border-color: #303744; }
      html.hu-theme-dark .hu-palette-input { background: #171b22; color: #edf1f7; border-color: #303744; }
      html.hu-theme-dark .hu-palette-footer { background: #151922; border-color: #303744; color: #a7afbd; }
      html.hu-theme-dark .hu-palette-footer .hu-result-title { color: #edf1f7; }
      html.hu-theme-dark .hu-result,
      html.hu-theme-dark .hu-row,
      html.hu-theme-dark .hu-icon-btn,
      html.hu-theme-dark .hu-copy { color: #edf1f7; background: transparent; border-color: #303744; }
      html.hu-theme-dark .hu-result.hu-active,
      html.hu-theme-dark .hu-result:hover,
      html.hu-theme-dark .hu-row:hover { background: #1d2a42; }
      html.hu-theme-dark .hu-result-sub,
      html.hu-theme-dark .hu-row-sub { color: #a7afbd; }
      html.hu-theme-dark .hu-palette .hu-type-pill {
        color: #a7afbd; background: #1d2a42; border-color: #303744;
      }
      html.hu-theme-dark .hu-drawer-header,
      html.hu-theme-dark .hu-toolbar-row { border-color: #303744; }
      html.hu-theme-dark .hu-json-formatted { color: #edf1f7; }
      html.hu-theme-dark .hu-json-toolbar { background: #151d2c; border-bottom-color: #303744; }
      html.hu-theme-dark .hu-json-search { background: #0f1626; border-color: #303744; color: #edf1f7; }
      html.hu-theme-dark .hu-json-search:focus { border-color: #ff9b51; }
      html.hu-theme-dark .hu-json-view-toggle { border-color: #303744; }
      html.hu-theme-dark .hu-json-view-btn { background: #1a2236; color: #a7afbd; }
      html.hu-theme-dark .hu-json-view-btn + .hu-json-view-btn { border-left-color: #303744; }
      html.hu-theme-dark .hu-json-view-btn:hover { color: #edf1f7; }
      html.hu-theme-dark .hu-json-view-btn.is-active { background: #ff9b51; color: #25343f; }
      html.hu-theme-dark .hu-json-action { background: #1a2236; border-color: #303744; color: #edf1f7; }
      html.hu-theme-dark .hu-json-action:hover { border-color: #45526a; }
      html.hu-theme-dark .hu-json-key { color: #6fa8ff; }
      html.hu-theme-dark .hu-json-string { color: #5dd699; }
      html.hu-theme-dark .hu-json-number { color: #ffb874; }
      html.hu-theme-dark .hu-json-boolean { color: #c89aff; }
      html.hu-theme-dark .hu-json-children { border-left-color: #303744; }
      html.hu-theme-dark .hu-json-node-header:hover,
      html.hu-theme-dark .hu-json-leaf:hover { background: rgba(255, 255, 255, 0.05); }
      html.hu-theme-dark .hu-json-mark { background: rgba(255, 200, 80, 0.35); color: #ffd87a; }
      html.hu-theme-dark .hu-json-node.is-match > .hu-json-node-header,
      html.hu-theme-dark .hu-json-node.is-match > .hu-json-leaf { background: rgba(255, 200, 80, 0.2); }
      html.hu-theme-dark .hu-json-count { color: #94a3b8; }
      html.hu-theme-dark .hu-section-row { background: #1a2236; border-color: #303744; }
      html.hu-theme-dark .hu-section-label { color: #a7afbd; }
      html.hu-theme-dark .hu-api-row:hover { background: #1d2533; }
      html.hu-theme-dark .hu-api-toolbar { background: #151d2c; border-bottom-color: #303744; }
      html.hu-theme-dark .hu-api-search { background: #0f1626; border-color: #303744; color: #edf1f7; }
      html.hu-theme-dark .hu-api-search:focus { border-color: #ff9b51; }
      html.hu-theme-dark .hu-api-method-chip { background: #1a2236; border-color: #303744; color: #a7afbd; }
      html.hu-theme-dark .hu-api-method-chip:hover { border-color: #45526a; color: #edf1f7; }
      html.hu-theme-dark .hu-api-method-chip.is-active { background: #ff9b51; color: #25343f; border-color: #ff9b51; }
      html.hu-theme-dark .hu-api-count { color: #94a3b8; }
      html.hu-theme-dark .hu-api-empty { color: #94a3b8; }
      html.hu-theme-dark .hu-api-row-v2 { border-bottom-color: #2b3548; }
      html.hu-theme-dark .hu-api-path { color: #cbd5e1; background: transparent; }
      html.hu-theme-dark .hu-api-summary { color: #94a3b8; }
      html.hu-theme-dark .hu-api-cat-count { background: rgba(255,155,81,0.18); color: #ffb37a; }
      html.hu-theme-dark .hu-api-methods-tag { background: rgba(99, 142, 220, 0.15); color: #9ab9ff; border-color: rgba(99, 142, 220, 0.35); }
      html.hu-theme-dark .hu-api-detail { background: #0f1626; border-color: #2b3548; }
      html.hu-theme-dark .hu-api-param-label { color: #6b7a8c; }
      html.hu-theme-dark .hu-api-param { background: #1a2236; border-color: #303744; color: #ffb37a; }
      html.hu-theme-dark .hu-api-noparams { color: #6b7a8c; }
      html.hu-theme-dark .hu-card { background: #1a2236; border-color: #303744; box-shadow: none; }
      html.hu-theme-dark .hu-ticket-hero { background: linear-gradient(135deg, #25343f 0%, #314754 100%); border-color: rgba(255, 155, 81, 0.24); }
      html.hu-theme-dark .hu-section-title,
      html.hu-theme-dark .hu-section-title-row,
      html.hu-theme-dark .hu-stat-value,
      html.hu-theme-dark .hu-list-title,
      html.hu-theme-dark .hu-list-note,
      html.hu-theme-dark .hu-360-kpi-value,
      html.hu-theme-dark .hu-360-tl-title { color: #edf1f7; }
      html.hu-theme-dark .hu-stat,
      html.hu-theme-dark .hu-360-kpi { background: #151d2c; border-color: #2b3548; }
      html.hu-theme-dark .hu-stat-link:hover,
      html.hu-theme-dark .hu-list-row-link:hover { background: #1d2533; border-color: #35507c; }
      html.hu-theme-dark .hu-stat-label,
      html.hu-theme-dark .hu-stat-sub,
      html.hu-theme-dark .hu-list-meta,
      html.hu-theme-dark .hu-list-row-sub,
      html.hu-theme-dark .hu-empty-note,
      html.hu-theme-dark .hu-360-time-labels,
      html.hu-theme-dark .hu-360-time-note,
      html.hu-theme-dark .hu-360-act-label,
      html.hu-theme-dark .hu-360-act-count,
      html.hu-theme-dark .hu-360-tl-meta { color: #a7afbd; }
      html.hu-theme-dark .hu-list-row { background: #151d2c; border-color: #2b3548; }
      html.hu-theme-dark .hu-360-time-track,
      html.hu-theme-dark .hu-360-act-track { background: #2b3548; }
      html.hu-theme-dark .hu-360-tl-line { background: #2b3548; }
      html.hu-theme-dark .hu-360-tl-note { background: #151d2c; border-color: #2b3548; color: #a7afbd; }
      html.hu-theme-dark #hu-ticket360-drawer .hu-section-title { color: #94a3b8; }
      html.hu-theme-dark .hu-360-meta-value,
      html.hu-theme-dark .hu-360-sla-label { color: #edf1f7; }
      html.hu-theme-dark .hu-360-meta-label { color: #94a3b8; }
      html.hu-theme-dark .hu-360-sla-due { color: #a7afbd; }
      html.hu-theme-dark .hu-360-sla-track { background: #2b3548; }
      html.hu-theme-dark .hu-360-status-bars { border-top-color: #2b3548; }
      html.hu-theme-dark .hu-360-aging-chip { background: #1d2a42; border-color: #2b3548; color: #a7afbd; }
      html.hu-theme-dark .hu-360-cf-label { color: #94a3b8; }
      html.hu-theme-dark .hu-360-cf-value { color: #edf1f7; }
      html.hu-theme-dark .hu-360-field-count { background: #1d2a42; color: #a7afbd; }
      html.hu-theme-dark .hu-360-trans-label { color: #edf1f7; }
      html.hu-theme-dark .hu-360-trans-arrow { color: #475569; }
      html.hu-theme-dark .hu-360-kb-title { color: #edf1f7; }
      html.hu-theme-dark .hu-360-kb-abstract { color: #a7afbd; }
      html.hu-theme-dark .hu-360-similar-title { color: #edf1f7; }
      html.hu-theme-dark .hu-360-similar-row { border-bottom-color: #2b3548; }
      html.hu-theme-dark .hu-360-similar-row:hover { background: #1d2a42; }
      html.hu-theme-dark .hu-360-linked-count { background: #1d2a42; color: #a7afbd; }
      html.hu-theme-dark .hu-360-cust-value,
      html.hu-theme-dark .hu-360-cust-text { color: #edf1f7; }
      html.hu-theme-dark .hu-360-cust-label { color: #94a3b8; }
      html.hu-theme-dark .hu-360-cust-link { color: #6aa8ff; }
      html.hu-theme-dark .hu-360-cust-sep { color: #475569; }
      html.hu-theme-dark .hu-360-assign-row { border-top-color: #2b3548; }
      html.hu-theme-dark .hu-360-assign-trigger { background: #1d2a42; border-color: #303744; color: #edf1f7; }
      html.hu-theme-dark .hu-360-assign-trigger:hover { background: #243154; border-color: #404b62; }
      html.hu-theme-dark .hu-360-assign-extras { color: #a7afbd; }
      html.hu-theme-dark .hu-360-agent-pop { background: #1a2236; border-color: #303744; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
      html.hu-theme-dark .hu-360-agent-search { background: transparent; color: #edf1f7; border-bottom-color: #303744; }
      html.hu-theme-dark .hu-360-agent-row { color: #edf1f7; }
      html.hu-theme-dark .hu-360-agent-row:hover,
      html.hu-theme-dark .hu-360-agent-row:focus { background: #1d2a42; }
      html.hu-theme-dark .hu-360-agent-team { color: #94a3b8; }
      html.hu-theme-dark .hu-360-agent-status { color: #94a3b8; }
      html.hu-theme-dark .hu-tbl-export-menu { background: #1a2236; border-color: #303744; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
      html.hu-theme-dark .hu-tbl-export-item { color: #d0d7e5; }
      html.hu-theme-dark .hu-tbl-export-item:hover { background: #1d2a42; }
      html.hu-theme-dark .hu-palette-tool { background: rgba(23,27,34,0.92); border-color: #303744; color: #c7cedb; }
      html.hu-theme-dark .hu-palette-tool:hover { background: #1d2a42; color: #edf1f7; border-color: #35507c; }
      html.hu-theme-dark .hu-palette-pos-menu { background: #171b22; border-color: #303744; box-shadow: 0 8px 22px rgba(0,0,0,0.35); }
      html.hu-theme-dark .hu-palette-pos-option { color: #edf1f7; }
      html.hu-theme-dark .hu-palette-pos-option:hover { background: #1d2a42; }
    `;
  }

  async function initTheme() {
    const data = await storageGet(['huTheme']);
    applyTheme(data?.huTheme === 'dark' ? 'dark' : 'light');
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.huTheme) return;
      applyTheme(changes.huTheme.newValue === 'dark' ? 'dark' : 'light');
    });
  }

  function loadSettings() {
    storageGet(['huSettings']).then(data => {
      Object.assign(HU.settings, data.huSettings || {});
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.huSettings) return;
      Object.assign(HU.settings, changes.huSettings.newValue || {});
    });
  }

  function loadPaletteSettings() {
    storageGet(['huPalette']).then(data => {
      Object.assign(HU.palette, data.huPalette || {});
      applyPaletteSettings();
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.huPalette) return;
      Object.assign(HU.palette, changes.huPalette.newValue || {});
      applyPaletteSettings();
    });
  }

  function applyPaletteSettings() {
    const palette = document.getElementById('hu-palette');
    if (!palette) return;
    palette.classList.remove('hu-palette-pos-left', 'hu-palette-pos-mid', 'hu-palette-pos-right');
    const placement = ['left', 'right', 'mid'].includes(HU.palette.placement) ? HU.palette.placement : 'mid';
    palette.classList.add(`hu-palette-pos-${placement}`);
    const scale = Number(HU.palette.fontScale) || 1;
    const clamped = Math.min(Math.max(scale, 0.8), 1.5);
    palette.style.setProperty('--hu-palette-font-scale', String(clamped));
  }

  function savePaletteSettings(patch) {
    Object.assign(HU.palette, patch);
    chrome.storage.local.set({ huPalette: { ...HU.palette } });
    applyPaletteSettings();
  }

  function loadReviewState() {
    storageGet(['huReview']).then(data => {
      Object.assign(HU.review, data.huReview || {});
    });
  }

  function saveReviewState(patch) {
    Object.assign(HU.review, patch);
    chrome.storage.local.set({ huReview: { ...HU.review } });
  }

  function recordPaletteActivity() {
    if (!HU.review.firstActiveAt) saveReviewState({ firstActiveAt: Date.now() });
  }

  function shouldShowReviewPrompt() {
    const r = HU.review;
    if (r.dismissed) return false;
    if (!r.firstActiveAt) return false;
    const now = Date.now();
    if (now < r.firstActiveAt + REVIEW_DELAY_MS) return false;
    if (r.snoozeUntil && now < r.snoozeUntil) return false;
    return true;
  }

  function injectReviewPromptIfDue(palette) {
    if (!shouldShowReviewPrompt()) return;
    const banner = document.createElement('div');
    banner.className = 'hu-palette-review';
    banner.innerHTML = `
      <span class="hu-palette-review-text">Enjoying HaloPlus? A quick Chrome Web Store review really helps.</span>
      <button type="button" class="hu-palette-review-btn hu-palette-review-go" data-action="review-go">Leave a review</button>
      <button type="button" class="hu-palette-review-btn" data-action="review-later">Later</button>
      <button type="button" class="hu-palette-review-btn hu-palette-review-no" data-action="review-no">No thanks</button>
    `;
    palette.insertBefore(banner, palette.firstChild);
    palette.classList.add('hu-has-review');

    banner.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'review-go') {
        chrome.runtime.sendMessage({ type: 'HU_OPEN_REVIEW' }, () => void chrome.runtime.lastError);
        saveReviewState({ dismissed: true });
      } else if (action === 'review-later') {
        saveReviewState({ snoozeUntil: Date.now() + REVIEW_SNOOZE_MS });
      } else if (action === 'review-no') {
        saveReviewState({ dismissed: true });
      }
      banner.remove();
      palette.classList.remove('hu-has-review');
    });
  }

  function paletteSettingsPlacementGlyph(placement) {
    if (placement === 'left') return '◧';
    if (placement === 'right') return '◨';
    return '▭';
  }

  function wirePaletteTools(palette) {
    const tools = palette.querySelector('.hu-palette-tools');
    if (!tools) return;

    tools.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
    });

    tools.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      const placement = event.target.closest('[data-placement]')?.dataset.placement;

      if (placement) {
        savePaletteSettings({ placement });
        tools.querySelectorAll('.hu-palette-pos-current').forEach(el => {
          el.textContent = paletteSettingsPlacementGlyph(placement);
        });
        return;
      }

      if (action === 'font-up') {
        savePaletteSettings({ fontScale: Math.min((HU.palette.fontScale || 1) + 0.1, 1.5) });
        return;
      }
      if (action === 'font-down') {
        savePaletteSettings({ fontScale: Math.max((HU.palette.fontScale || 1) - 0.1, 0.8) });
        return;
      }
      if (action === 'theme') {
        const next = HU.theme === 'dark' ? 'light' : 'dark';
        chrome.storage.local.set({ huTheme: next });
        applyTheme(next);
        const themeBtn = tools.querySelector('[data-action="theme"]');
        if (themeBtn) themeBtn.textContent = next === 'dark' ? '☼' : '☾';
        return;
      }
      if (action === 'settings') {
        chrome.runtime.sendMessage({ type: 'HU_OPEN_SETTINGS' }, () => void chrome.runtime.lastError);
        closePalette();
        return;
      }
    });
  }

  function initPalette() {
    ['keyup', 'keypress', 'beforeinput'].forEach(type => {
      document.addEventListener(type, suppressHaloSlashShortcut, true);
    });

    document.addEventListener('keydown', (event) => {
      if (shouldSuppressSlashEvent(event)) {
        consumeEvent(event);
        return;
      }

      if (HU.paletteOpen) {
        handlePaletteKey(event);
        return;
      }

      if (event.key === '/' && !isTypingTarget(event.target)) {
        HU.suppressSlashUntil = Date.now() + 600;
        consumeEvent(event);
        openPalette('/');
      }
    }, true);
  }

  function suppressHaloSlashShortcut(event) {
    if (shouldSuppressSlashEvent(event)) consumeEvent(event);
  }

  function shouldSuppressSlashEvent(event) {
    if (Date.now() > HU.suppressSlashUntil) return false;
    if (event.type === 'beforeinput') return event.data === '/';
    return event.key === '/' || event.code === 'Slash';
  }

  function consumeEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function recallHistoryBack() {
    const input = document.getElementById('hu-palette-input');
    if (!input) return;
    const next = HU.historyIndex + 1;
    if (next >= HU.commandHistory.length) return;
    if (HU.historyIndex === -1) HU.historyDraft = input.value;
    HU.historyIndex = next;
    input.value = HU.commandHistory[next];
    input.setSelectionRange(input.value.length, input.value.length);
    updatePaletteFooter(input.value);
    runPaletteSearch(input.value);
  }

  function resetHistoryNav() {
    HU.historyIndex = -1;
    HU.historyDraft = '';
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function openPalette(seed = '') {
    injectStyles();
    closePalette();

    HU.paletteOpen = true;
    HU.paletteShowAll = false;
    HU.selectedIndex = 0;
    resetHistoryNav();

    // Refresh custom commands from storage (re-renders palette if changed)
    loadCustomCommands().then(() => {
      if (HU.paletteOpen) {
        const input = document.getElementById('hu-palette-input');
        if (input) runPaletteSearch(input.value);
      }
    }).catch(() => {});

    // Counter / tag pre-fetches are now lazy — kicked off from
    // scheduleVisibleCommandFetches(), which runs after each render with
    // only the typeIds actually visible. Saves ~100 API calls on tenants
    // with many custom ticket types.

    const backdrop = document.createElement('div');
    backdrop.className = 'hu-palette-backdrop';
    backdrop.id = 'hu-palette-backdrop';
    backdrop.addEventListener('click', closePalette);

    const palette = document.createElement('div');
    palette.className = 'hu-palette';
    palette.id = 'hu-palette';
    palette.innerHTML = `
      <div class="hu-palette-tools" id="hu-palette-tools" aria-label="Palette settings">
        <button type="button" class="hu-palette-tool" data-action="font-down" title="Decrease font size">A-</button>
        <button type="button" class="hu-palette-tool" data-action="font-up" title="Increase font size">A+</button>
        <button type="button" class="hu-palette-tool" data-action="theme" title="Toggle light / dark">${HU.theme === 'dark' ? '☼' : '☾'}</button>
        <div class="hu-palette-tool hu-palette-tool-pos" data-action="placement" title="Palette placement">
          <span class="hu-palette-pos-current">${paletteSettingsPlacementGlyph(HU.palette.placement)}</span>
          <div class="hu-palette-pos-menu" role="menu">
            <button type="button" class="hu-palette-pos-option" data-placement="left" role="menuitem">${paletteSettingsPlacementGlyph('left')} Top left</button>
            <button type="button" class="hu-palette-pos-option" data-placement="mid" role="menuitem">${paletteSettingsPlacementGlyph('mid')} Center</button>
            <button type="button" class="hu-palette-pos-option" data-placement="right" role="menuitem">${paletteSettingsPlacementGlyph('right')} Top right</button>
          </div>
        </div>
        <button type="button" class="hu-palette-tool" data-action="settings" title="Open HaloPlus settings">⚙</button>
      </div>
      <input class="hu-palette-input" id="hu-palette-input" autocomplete="off" spellcheck="false" placeholder="/t 2937, /c acme, /a alex, /360, /r">
      <div class="hu-palette-list" id="hu-palette-list"></div>
      <div class="hu-palette-footer" id="hu-palette-footer"></div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(palette);
    applyPaletteSettings();
    wirePaletteTools(palette);
    recordPaletteActivity();
    injectReviewPromptIfDue(palette);
    updateDiscoveryIndicator();

    const input = document.getElementById('hu-palette-input');
    input.value = seed;
    focusPaletteInput(input);
    input.addEventListener('input', () => {
      HU.paletteShowAll = false;
      resetHistoryNav();
      updatePaletteFooter(input.value);
      schedulePaletteSearch(input.value);
    });
    runPaletteSearch(seed);
  }

  function focusPaletteInput(input) {
    const focus = () => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };

    focus();
    requestAnimationFrame(focus);
    setTimeout(focus, 50);
  }

  function closePalette() {
    document.getElementById('hu-palette')?.remove();
    document.getElementById('hu-palette-backdrop')?.remove();
    HU.paletteOpen = false;
    HU.paletteOpenOnlyScope = null;
    clearTimeout(HU.searchTimer);
  }

  function handlePaletteKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.min(HU.selectedIndex + 1, HU.paletteResults.length - 1);
      setPaletteSelection(next);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (HU.selectedIndex > 0) {
        setPaletteSelection(HU.selectedIndex - 1);
        return;
      }
      recallHistoryBack();
      return;
    }

    if (event.key === 'ArrowRight') {
      const input = document.getElementById('hu-palette-input');
      if (!input) return;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (!atEnd) return;

      const result = HU.paletteResults[HU.selectedIndex];
      if (!result) return;

      if (result.isCfgEntry) {
        event.preventDefault();
        input.value = '/cfg ';
        input.setSelectionRange(input.value.length, input.value.length);
        updatePaletteFooter(input.value);
        runPaletteSearch(input.value);
        return;
      }
      if (result.configSlug && !result.subSlug) {
        event.preventDefault();
        input.value = `/cfg ${result.configSlug} `;
        input.setSelectionRange(input.value.length, input.value.length);
        updatePaletteFooter(input.value);
        runPaletteSearch(input.value);
        return;
      }
      if (result.subSlug || result.isConfigDeepLink) {
        event.preventDefault();
        activateResult(result);
        return;
      }

      // Autocomplete: if the user typed a partial slash-command (no space yet)
      // and the highlighted result starts with it, fill in the full command
      // plus a trailing space so they can continue typing a scope-search term.
      // Example: "/peri" → ArrowRight → "/peripherals-request ".
      const typed = input.value;
      const completion = result.displayTitle || (result.id ? `/${result.id}` : '');
      if (completion && typed.startsWith('/') && !typed.includes(' ') &&
          typed.length < completion.length &&
          completion.toLowerCase().startsWith(typed.toLowerCase())) {
        event.preventDefault();
        input.value = `${completion} `;
        input.setSelectionRange(input.value.length, input.value.length);
        updatePaletteFooter(input.value);
        runPaletteSearch(input.value);
        return;
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const result = HU.paletteResults[HU.selectedIndex];
      if (result) activateResult(result);
    }
  }

  function schedulePaletteSearch(query) {
    clearTimeout(HU.searchTimer);
    HU.searchTimer = setTimeout(() => runPaletteSearch(query), 180);
  }

  function getEntitySearchQuery(query) {
    const normalized = normalizeQuery(query);
    const spaceIdx = normalized.indexOf(' ');
    if (spaceIdx === -1) return null;
    const keyword = normalized.slice(0, spaceIdx);
    const searchTerm = normalized.slice(spaceIdx + 1).trim();
    const def = ENTITY_SEARCH_MAP[keyword] || HU.ticketTypeSearchMap[keyword];
    // Allow an empty searchTerm for ticket-type scopes — "/laptop-request "
    // (trailing space) lists the latest 20 of that type. For other entities
    // an empty term has no meaning, so keep the guard.
    if (!def) return null;
    if (!searchTerm && !(def.typeId != null || def.typeMatch || def.sectionMatch)) return null;
    // ENTITY_COMMAND_IDS holds the static built-in keyword → commandId map.
    // Tenant-defined custom ticket types live in HU.ticketTypeSearchMap and
    // carry their own commandId, so fall back to that when the static map
    // doesn't know the keyword.
    const commandId = ENTITY_COMMAND_IDS[keyword] || def.commandId;
    if (!commandId) return null;
    // Open-only badge mode — set when the agent clicks the open-count chip.
    // Kept until the scope changes to a different command, then cleared so
    // typing into a different scope doesn't surprise the agent.
    let openOnly = false;
    if (HU.paletteOpenOnlyScope) {
      if (HU.paletteOpenOnlyScope === commandId) openOnly = true;
      else HU.paletteOpenOnlyScope = null;
    }
    return { def: { ...def, commandId, openOnly }, keyword, searchTerm };
  }

  async function searchEntityRecords(def, searchTerm) {
    if (def.commandId === 'rep') return searchReports(searchTerm);

    const primary = await runEntitySearchForDef(def, searchTerm);
    if (!def.combineWith?.length) return primary;

    const secondary = await Promise.allSettled(
      def.combineWith
        .map(keyword => ENTITY_SEARCH_MAP[keyword])
        .filter(Boolean)
        .map(secDef => runEntitySearchForDef(secDef, searchTerm))
    );
    const extra = secondary.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    const seen = new Set();
    return [...primary, ...extra].filter(row => {
      const key = `${row.kind}|${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);
  }

  async function runEntitySearchForDef(def, searchTerm) {
    // Try the entity API first (works for non-admin agents). Fall back to
    // /api/Report-based SQL search only if the entity-API path isn't
    // configured for this routeType or the call hits an unexpected error.
    if (ENTITY_API_CONFIG[def.route]) {
      try {
        const apiResults = await searchEntityViaApi(def, searchTerm);
        if (apiResults) return apiResults;
      } catch (e) {
        // 401/403/permission failures fall through to SQL — admins still have a
        // working path. For non-admins SQL also fails, so skip it entirely once
        // the report probe has confirmed no access (avoids guaranteed-403 floods).
        if (HU.reportApiOk === false) return [];
      }
    }

    // Same gate before the SQL section: if the agent can't run reports, return
    // empty rather than fire a doomed /api/Report POST.
    if (HU.reportApiOk === false) return [];

    const escaped = sqlEscape(searchTerm);
    const numeric = /^\d+$/.test(searchTerm);
    const searchColumns = numeric ? [] : await resolveSearchColumns(def.table, def.searchCols, def.optionalSearchCols);
    const baseWhere = numeric
      ? `${def.id} = ${Number(searchTerm)} OR CONVERT(nvarchar(max), ${def.id}) LIKE '%${escaped}%'`
      : buildTextSearchWhere(searchColumns, escaped);
    if (!baseWhere) return [];

    const sectionClause = buildSectionClause(def);
    const where = sectionClause ? `(${baseWhere})${sectionClause}` : baseWhere;

    const base = {
      kind: def.kind, routeType: def.route, table: def.table,
      idColumn: def.id, titleColumn: def.title, subtitleColumn: def.sub,
      extraCols: def.extraCols, searchTerm, emailTag: def.emailTag,
      ticketPrefix: def.ticketPrefix,
      typeId: sectionClause ? undefined : def.typeId
    };

    try {
      const results = await runSearchQuery({ ...base, where });
      if (results.length || numeric || !def.optionalSearchCols?.length) return results;
      return await searchOptionalEntityColumns(def, searchTerm, escaped, searchColumns, base, sectionClause);
    } catch (e) {
      if (numeric || !def.optionalSearchCols?.length) return [];
      return await searchOptionalEntityColumns(def, searchTerm, escaped, searchColumns, base, sectionClause);
    }
  }

  function buildSectionClause(def) {
    if (!def.sectionMatch?.length) return '';
    const parts = def.sectionMatch
      .map(needle => `CONVERT(nvarchar(max), Sectio_) LIKE '%${sqlEscape(String(needle))}%'`)
      .join(' OR ');
    return ` AND (${parts})`;
  }

  function buildTextSearchWhere(columns, escapedSearchTerm) {
    return (columns || [])
      .map(col => `CONVERT(nvarchar(max), ${col}) LIKE '%${escapedSearchTerm}%'`)
      .join(' OR ');
  }

  async function searchOptionalEntityColumns(def, searchTerm, escapedSearchTerm, existingColumns, base, sectionClause = '') {
    const tried = new Set((existingColumns || []).map(column => column.toLowerCase()));
    for (const column of def.optionalSearchCols || []) {
      if (tried.has(column.toLowerCase())) continue;
      const baseWhere = buildTextSearchWhere([...(def.searchCols || []), column], escapedSearchTerm);
      if (!baseWhere) continue;
      const where = sectionClause ? `(${baseWhere})${sectionClause}` : baseWhere;
      try {
        const results = await runSearchQuery({ ...base, where });
        if (results.length) return results;
      } catch (e) {
        // Optional column not available on this instance.
      }
    }
    return [];
  }

  async function runPaletteSearch(rawQuery) {
    const query = rawQuery.trim();
    updatePaletteFooter(query);

    const configQuery = getConfigQuery(query);
    if (configQuery) {
      HU.paletteResults = buildConfigResults(configQuery);
      HU.selectedIndex = 0;
      renderPaletteResults(HU.paletteResults, false);

      if (configQuery.exactSection) {
        const slug = configQuery.exactSection.slug;
        const cached = HU.configTree?.[slug];
        if ((!cached || !cached.length) && !HU.configDiscoveryInFlight.has(slug)) {
          discoverSectionSubnav(slug).then(() => {
            if (!HU.paletteOpen) return;
            const input = document.getElementById('hu-palette-input');
            if (input) runPaletteSearch(input.value);
          });
        }
      }
      return;
    }

    // Entity-scoped search: "/t 2937" or "/c Acme" searches within one record type.
    const entityQuery = getEntitySearchQuery(query);
    if (entityQuery) {
      const navCmd = BASE_COMMANDS.find(c => c.id === entityQuery.def.commandId)
        || HU.ticketTypeCommands.find(c => c.id === entityQuery.def.commandId);
      const disabled = isEntityCommandDisabled(entityQuery.keyword)
        || isEntityCommandDisabled(entityQuery.def.commandId);
      const navResults = navCmd ? [{
        ...navCmd,
        displayTitle: `/${entityQuery.keyword}`,
        kind: navCmd.kind || 'ITSM',
        disabled,
        disabledReason: disabled ? entityDisabledTooltip(entityQuery.keyword) : ''
      }] : [];
      HU.paletteResults = navResults;
      HU.selectedIndex = 0;
      renderPaletteResults(navResults, false);

      // Skip the API call entirely when the entity is gated — saves a guaranteed
      // 401/403 round-trip and keeps the disabled nav stub on screen.
      if (disabled) return;

      // Delay-show the loading row by 150ms so cached / fast responses don't
      // flicker a spinner. If the API hasn't returned within that window,
      // re-render with the loader added; otherwise it never appears.
      const loadingRow = { loading: true, title: 'Searching…', subtitle: '' };
      const loaderToken = ++HU.entityLoaderToken;
      const loaderTimer = setTimeout(() => {
        if (loaderToken === HU.entityLoaderToken && HU.paletteOpen) {
          renderPaletteResults([...navResults, loadingRow], false);
        }
      }, 150);

      const liveResults = await searchEntityRecords(entityQuery.def, entityQuery.searchTerm);
      clearTimeout(loaderTimer);
      if (!HU.paletteOpen) return;
      HU.paletteResults = mergeEntitySearchResults(navResults, liveResults, entityQuery.searchTerm).slice(0, 20);
      renderPaletteResults(HU.paletteResults, false);
      return;
    }

    const results = buildLocalPaletteResults(query);
    HU.paletteResults = results;
    HU.selectedIndex = 0;
    renderPaletteResults(results, false);

    const impersonationQuery = getImpersonationQuery(query);
    if (impersonationQuery !== null) {
      if (impersonationQuery.length >= 1) {
        const liveResults = await searchAgentsForImpersonation(impersonationQuery);
        if (!HU.paletteOpen) return;
        HU.paletteResults = [...results, ...liveResults].slice(0, 30);
        renderPaletteResults(HU.paletteResults, false);
      }
      return;
    }

    if (query.length >= 2) {
      // Only show the loader if open-ended SQL search will actually run —
      // for non-admin agents we skip it (reportApiOk === false), so no spinner.
      // Same 150ms delay as the entity-scope branch above to avoid flicker.
      let openLoaderTimer = null;
      const openLoaderToken = ++HU.openLoaderToken;
      if (HU.reportApiOk !== false) {
        const loadingRow = { loading: true, title: 'Searching across records…', subtitle: '' };
        openLoaderTimer = setTimeout(() => {
          if (openLoaderToken === HU.openLoaderToken && HU.paletteOpen) {
            renderPaletteResults([...results, loadingRow], false);
          }
        }, 150);
      }
      const liveResults = await searchHaloRecords(query);
      if (openLoaderTimer) clearTimeout(openLoaderTimer);
      if (!HU.paletteOpen) return;
      HU.paletteResults = [...results, ...liveResults].slice(0, 40);
      renderPaletteResults(HU.paletteResults, false);
    }
  }

  async function resolveSearchColumns(table, requiredColumns, optionalColumns = []) {
    const required = [...new Set(requiredColumns || [])].filter(Boolean);
    const optional = [...new Set(optionalColumns || [])].filter(Boolean);
    if (!required.length && !optional.length) return [];
    if (!optional.length) return required;

    const available = await getTableColumnSet(table);
    if (!available?.size) return required;

    const existingColumns = [
      ...required,
      ...optional.filter(column => available.has(column.toLowerCase()))
    ].filter(column => available.has(column.toLowerCase()));
    return existingColumns.length ? existingColumns : required;
  }

  async function getTableColumnSet(table) {
    const cacheKey = table.toLowerCase();
    if (!HU.schemaColumnCache[cacheKey]) {
      HU.schemaColumnCache[cacheKey] = await loadTableColumns(table);
    }
    return HU.schemaColumnCache[cacheKey];
  }

  async function loadTableColumns(table) {
    try {
      const sql = `
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE LOWER(TABLE_NAME) = '${sqlEscape(table.toLowerCase())}'
`.trim();
      const payload = await runHaloReport(sql, `HaloPlus ${table} Column Discovery`);
      const columns = extractRows(payload)
        .map(row => getRowValue(row, 'COLUMN_NAME'))
        .filter(Boolean)
        .map(column => column.toLowerCase());
      return new Set(columns);
    } catch (e) {
      return new Set();
    }
  }

  async function searchReports(searchTerm) {
    const discovered = await discoverReportSearchCandidates();
    for (const candidate of discovered) {
      try {
        const rows = await runReportSearchCandidate(candidate, searchTerm);
        if (rows.length) return rows;
      } catch (e) {
        // Try the next discovered table shape.
      }
    }

    const candidates = [
      { table: 'report', id: 'rid', title: 'rname', subtitle: 'rdesc' },
      { table: 'report', id: 'ReportID', title: 'ReportName', subtitle: 'ReportDescription' },
      { table: 'report', id: 'ID', title: 'Name', subtitle: 'Description' },
      { table: 'reports', id: 'id', title: 'name', subtitle: 'description' },
      { table: 'reportlist', id: 'id', title: 'name', subtitle: 'description' },
      { table: 'reportlist', id: 'ReportID', title: 'ReportName', subtitle: 'ReportDescription' }
    ].filter((candidate, index, all) =>
      all.findIndex(item => `${item.table}.${item.id}.${item.title}.${item.subtitle}`.toLowerCase() ===
        `${candidate.table}.${candidate.id}.${candidate.title}.${candidate.subtitle}`.toLowerCase()) === index
    );

    for (const candidate of candidates) {
      try {
        const rows = await runReportSearchCandidate({
          ...candidate,
          searchColumns: [candidate.title, candidate.subtitle].filter(Boolean)
        }, searchTerm);
        if (rows.length) return rows;
      } catch (e) {
        // Try the next common report table shape.
      }
    }

    return [];
  }

  async function runReportSearchCandidate(candidate, searchTerm) {
    const escaped = sqlEscape(searchTerm);
    const numeric = /^\d+$/.test(searchTerm);
    const searchColumns = [...new Set(candidate.searchColumns || [candidate.title, candidate.subtitle].filter(Boolean))];
    const textWhere = searchColumns
      .map(column => `CONVERT(nvarchar(max), ${sqlIdent(column)}) LIKE '%${escaped}%'`)
      .join(' OR ');
    if (!numeric && !textWhere) return [];
    const where = numeric
        ? `${sqlIdent(candidate.id)} = ${Number(searchTerm)} OR CONVERT(nvarchar(max), ${sqlIdent(candidate.id)}) LIKE '%${escaped}%' OR CONVERT(nvarchar(max), ${sqlIdent(candidate.title)}) LIKE '%${escaped}%'`
        : textWhere;
    const sql = `
SELECT TOP 10
  ${sqlIdent(candidate.id)} AS [id],
  CONVERT(nvarchar(max), ${sqlIdent(candidate.title)}) AS [title],
  CONVERT(nvarchar(max), ${sqlIdent(candidate.subtitle || candidate.title)}) AS [subtitle]
FROM
  ${sqlIdent(candidate.table)}
WHERE
  ${where}
ORDER BY
  ${buildSqlSearchOrder(sqlIdent(candidate.id), sqlIdent(candidate.title), sqlIdent(candidate.subtitle || candidate.title), searchTerm)}
`.trim();
    const payload = await runHaloReport(sql, 'HaloPlus Report Search');
    return extractRows(payload).map(row => ({
      id: row.id,
      recordId: row.id,
      title: row.title || `Report ${row.id}`,
      subtitle: row.subtitle || `${candidate.table}.${candidate.id} = ${row.id}`,
      kind: 'Report',
      type: 'navigate',
      url: new URL(routeDetail('report', row.id), window.location.origin).href
    }));
  }

  async function discoverReportSearchCandidates() {
    try {
      const sql = `
SELECT TABLE_NAME, COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE LOWER(TABLE_NAME) LIKE '%report%'
ORDER BY TABLE_NAME, ORDINAL_POSITION
`.trim();
      const payload = await runHaloReport(sql, 'HaloPlus Report Search Discovery');
      const grouped = new Map();
      extractRows(payload).forEach(row => {
        const table = getRowValue(row, 'TABLE_NAME');
        const column = getRowValue(row, 'COLUMN_NAME');
        if (!table || !column) return;
        if (!grouped.has(table)) grouped.set(table, []);
        grouped.get(table).push(column);
      });

      return [...grouped.entries()]
        .map(([table, columns]) => {
          const id = pickColumn(columns, [/^reportid$/i, /^report_id$/i, /^rid$/i, /^rptid$/i, /^id$/i, /report.*id/i, /(^|_)id$/i, /id$/i]);
          const title = pickColumn(columns, [/^reportname$/i, /^report_name$/i, /^rname$/i, /^rptname$/i, /^name$/i, /title/i, /summary/i, /description/i, /desc/i]);
          const subtitle = pickColumn(columns, [/description/i, /desc/i, /group/i, /category/i, /folder/i, /name/i]);
          if (!id || !title) return null;
          const searchColumns = columns.filter(column => /(name|title|desc|description|summary|query|sql|group|category|folder)/i.test(column));
          return { table, id, title, subtitle: subtitle || title, searchColumns };
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function pickColumn(columns, patterns) {
    return patterns.reduce((found, pattern) => found || columns.find(column => pattern.test(column)), '');
  }

  function getRowValue(row, wantedKey) {
    const key = Object.keys(row || {}).find(candidate => candidate.toLowerCase() === wantedKey.toLowerCase());
    return key ? String(row[key] ?? '') : '';
  }

  function sqlIdent(name) {
    return `[${String(name).replace(/]/g, ']]')}]`;
  }

  function mergeEntitySearchResults(navResults, liveResults, searchTerm) {
    const rankedLiveResults = rankScopedSearchResults(liveResults, searchTerm);
    if (rankedLiveResults.length) return [...rankedLiveResults, ...navResults];
    return navResults;
  }

  function rankScopedSearchResults(results, searchTerm) {
    const normalized = normalizeSearchValue(searchTerm);
    return [...results].sort((a, b) =>
      scopedSearchScore(b, normalized) - scopedSearchScore(a, normalized) ||
      String(a.title || '').localeCompare(String(b.title || ''))
    );
  }

  function scopedSearchScore(item, normalizedSearchTerm) {
    if (!normalizedSearchTerm) return 0;

    const title = normalizeSearchValue(item.title);
    const subtitle = normalizeSearchValue(item.subtitle);
    const id = normalizeSearchValue(item.id || item.recordId);
    const haystack = `${title} ${subtitle}`.trim();
    const numericTerm = normalizeNumericValue(normalizedSearchTerm);
    const numericId = normalizeNumericValue(id);
    let score = 0;

    if (numericTerm && numericId === numericTerm) score += 1000;
    if (numericTerm && numericId.includes(numericTerm)) score += 800;
    if (id === normalizedSearchTerm || title === normalizedSearchTerm) score += 900;
    if (title.startsWith(normalizedSearchTerm)) score += 700;
    if (id.startsWith(normalizedSearchTerm)) score += 650;
    if (id.includes(normalizedSearchTerm)) score += 550;
    if (haystack.includes(normalizedSearchTerm)) score += 500;

    const words = normalizedSearchTerm.split(/\s+/).filter(Boolean);
    if (words.length) {
      const titleWords = title.split(/\s+/).filter(Boolean);
      const matchedWords = words.filter(word => haystack.includes(word)).length;
      score += matchedWords * 80;
      if (matchedWords === words.length) score += 200;
      if (words.every((word, index) => titleWords[index] === word)) score += 120;
    }

    return score;
  }

  function normalizeSearchValue(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeNumericValue(value) {
    const normalized = String(value || '').match(/\d+/)?.[0] || '';
    return normalized ? String(Number(normalized)) : '';
  }

  function getCommandAliasId(query) {
    return COMMAND_ALIASES[normalizeQuery(query)] || '';
  }

  function rankMatch(title, id, keywords, normalized) {
    if (!normalized) return 0;
    const t = String(title || '').toLowerCase();
    const i = String(id   || '').toLowerCase();
    if (i === normalized || t === normalized) return 3;
    if (i.startsWith(normalized) || t.startsWith(normalized)) return 2;
    if ((keywords || []).some(k => String(k).toLowerCase().startsWith(normalized))) return 1;
    return 0;
  }

  function buildLocalPaletteResults(query) {
    const normalized = normalizeQuery(query);
    const impersonationQuery = getImpersonationQuery(query);

    const commands = [...BASE_COMMANDS, ...HU.ticketTypeCommands]
      .filter(isPaletteCommandAvailable)
      .map(item => ({
        ...item,
        aliasMatch: getCommandAliasId(normalized) === item.id,
        kind: item.kind || 'Tools'
      }))
      .filter(item => impersonationQuery === null && (item.aliasMatch || fuzzyMatch(`${item.id} ${item.title} ${item.subtitle} ${(item.keywords || []).join(' ')}`, normalized)));
    // Lazy fetch for any visible-after-filter commands.
    setTimeout(() => scheduleVisibleCommandFetches(commands), 0);
    const decorated = commands
      .map(item => {
        const disabled = isEntityCommandDisabled(item.id);
        const openCount = getCommandOpenCount(item.id);
        return {
          ...item,
          displayTitle: `/${item.aliasMatch ? normalized : item.id}`,
          kind: openCount != null ? `${openCount} open` : item.kind,
          subCount: openCount != null ? openCount : undefined,
          disabled,
          disabledReason: disabled ? entityDisabledTooltip(item.id) : '',
          ...(item.id === 'cfg'
            ? { isCfgEntry: true, subCount: CONFIG_SECTIONS.length, kind: `${CONFIG_SECTIONS.length} ›` }
            : {})
        };
      })
      .sort((a, b) =>
        Number(a.disabled) - Number(b.disabled) ||
        Number(b.aliasMatch) - Number(a.aliasMatch) ||
        rankMatch(b.title, b.id, b.keywords, normalized) - rankMatch(a.title, a.id, a.keywords, normalized)
      );

    const customCmds = HU.customCommands
      .filter(cmd => impersonationQuery === null && fuzzyMatch(`${cmd.title} ${cmd.subtitle || ''} ${cmd.category || ''}`, normalized))
      .map(cmd => ({
        id: cmd.id,
        title: cmd.title,
        subtitle: cmd.subtitle || (cmd.type === 'sql' ? 'SQL command' : cmd.url || ''),
        kind: cmd.category || (cmd.type === 'navigation' ? 'Navigation' : 'SQL'),
        type: cmd.type,
        url: cmd.url,
        sql: cmd.sql
      }))
      .sort((a, b) => rankMatch(b.title, b.title, [], normalized) - rankMatch(a.title, a.title, [], normalized));

    const shortcuts = HU.shortcuts
      .filter(item => fuzzyMatch(`${item.title} ${item.url}`, normalized))
      .slice(0, 8)
      .map(item => ({
        title: item.title,
        subtitle: item.url,
        kind: 'Shortcuts',
        type: 'navigate',
        url: item.url
      }));

    const recent = getCachedRecent()
      .filter(item => impersonationQuery === null && fuzzyMatch(`${item.title} ${item.type} ${item.url}`, normalized))
      .slice(0, 8)
      .map(item => ({
        title: item.title,
        subtitle: item.url,
        kind: 'Recent',
        type: 'navigate',
        url: item.url
      }));

    if (impersonationQuery !== null) {
      if (!impersonationQuery && HU.impersonatedAgentId) {
        return [{
          title: 'Exit impersonation',
          subtitle: `Switch back from impersonated agent ${HU.impersonatedAgentId}`,
          kind: 'Tools',
          type: 'command',
          run: exitImpersonation
        }];
      }
      return [];
    }
    const ticketTypeCmds = [];

    if (!normalized) return getDefaultCommandResults();
    return [...decorated, ...ticketTypeCmds, ...customCmds, ...shortcuts, ...recent].slice(0, 28);
  }

  function updatePaletteFooter(query) {
    const footer = document.getElementById('hu-palette-footer');
    if (!footer) return;

    const impersonationQuery = getImpersonationQuery(query);
    const entityQuery = getEntitySearchQuery(query);
    const configQuery = getConfigQuery(query);
    let title, subtitle;

    if (impersonationQuery !== null) {
      title = getImpersonationFooterTitle(impersonationQuery);
      subtitle = getImpersonationFooterSubtitle(impersonationQuery);
    } else if (configQuery) {
      if (configQuery.exactSection && configQuery.subpath) {
        title = `Open ${configQuery.exactSection.label} / ${configQuery.subpath}`;
        subtitle = 'Press Enter to jump directly to this configuration page.';
      } else if (configQuery.rawSearch) {
        title = `Filtering configuration sections by "${configQuery.rawSearch}"`;
        subtitle = 'Type a section name, then optionally a subsection path (e.g. /cfg tickets tickettype).';
      } else {
        title = 'Browse Halo configuration sections';
        subtitle = 'Type to filter, or add a subsection (e.g. /cfg tickets tickettype) for a deep link.';
      }
    } else if (entityQuery) {
      title = `Searching ${entityQuery.def.kind} records for "${entityQuery.searchTerm}"`;
      subtitle = `Press Enter to open the top match, or keep typing to refine. Use /${entityQuery.def.commandId} alone to open the list.`;
    } else {
      title = 'Tip: type /h for HaloPlus commands';
      subtitle = 'Try "/t 2937", "/c Acme", or "/a alex" to search within a record type.';
    }

    footer.innerHTML = `
      <span>
        <span class="hu-result-title">${escapeHtml(title)}</span>
        <span class="hu-result-sub">${escapeHtml(subtitle)}</span>
      </span>
      <span id="hu-palette-env-slot"></span>
    `;

    // Env chip — only when the host is configured. Async storage read; if
    // the host isn't configured, leave the slot empty.
    resolveHostConfig(location.hostname).then(config => {
      const slot = document.getElementById('hu-palette-env-slot');
      if (!slot) return;
      if (!config) { slot.innerHTML = ''; return; }
      const spec = ENVIRONMENT_SPECS[config.env] || ENVIRONMENT_SPECS.unknown;
      const label = (config.label && config.label.trim()) || spec.label;
      slot.innerHTML = `<span class="hu-palette-env" style="background:${spec.bg};color:${spec.text};border-color:${spec.color}" title="Environment label">${escapeHtml(label)}</span>`;
    }).catch(() => {});
  }

  function getImpersonationQuery(query) {
    const normalized = normalizeQuery(query);
    if (normalized === 'imp') return '';
    if (normalized.startsWith('imp ')) return normalized.replace(/^imp\s+/, '').trim();
    return null;
  }

  function getConfigQuery(query) {
    const normalized = normalizeQuery(query);
    const m = normalized.match(/^(?:cfg|config)(?:\s+(.+))?$/);
    if (!m) return null;
    const tail = (m[1] || '').trim();
    if (!tail) return { rawSearch: '', subpath: '', exactSection: null };

    const tokens = tail.split(/\s+/);
    for (let n = tokens.length; n >= 1; n--) {
      const leading = tokens.slice(0, n).join(' ');
      const section = findConfigSection(leading);
      if (section) {
        const subpath = tokens.slice(n).join('/');
        return { rawSearch: tail, subpath, exactSection: section };
      }
    }
    return { rawSearch: tail, subpath: '', exactSection: null };
  }

  function findConfigSection(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return null;
    return (
      CONFIG_SECTIONS.find(c => c.slug === t) ||
      CONFIG_SECTIONS.find(c => c.label.toLowerCase() === t) ||
      CONFIG_SECTIONS.find(c => c.keywords.includes(t)) ||
      null
    );
  }

  function loadConfigTree() {
    storageGet(['huConfigTree']).then(data => {
      HU.configTree = data.huConfigTree || {};
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.huConfigTree) return;
      HU.configTree = changes.huConfigTree.newValue || {};
    });
  }

  function maybeScrapeConfigPage() {
    const m = location.pathname.match(/^\/config\/([a-z0-9_-]+)/i);
    if (!m) return;
    const section = m[1].toLowerCase();
    if (!CONFIG_SECTIONS.find(c => c.slug === section)) return;
    clearTimeout(HU.configScrapeTimer);
    HU.configScrapeTimer = setTimeout(() => scrapeAndCacheConfigSubnav(section), 1200);
  }

  function scrapeAndCacheConfigSubnav(section) {
    const subs = scrapeSubnavFromDoc(document, section);
    if (!subs.length) return;
    saveConfigTreeSection(section, subs);
  }

  function scrapeSubnavFromDoc(doc, section) {
    const prefix = `/config/${section}/`;
    const seen = new Set();
    const subs = [];
    doc.querySelectorAll('a[href]').forEach(a => {
      const path = a.pathname || '';
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length).replace(/\/+$/, '');
      if (!rest || rest.includes('/')) return;
      const slug = rest.toLowerCase();
      if (seen.has(slug)) return;
      const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 80) return;
      seen.add(slug);
      subs.push({ slug, label });
    });
    return subs;
  }

  function saveConfigTreeSection(section, subs) {
    HU.configTree = HU.configTree || {};
    HU.configTree[section] = subs;
    chrome.storage.local.set({ huConfigTree: { ...HU.configTree } });
  }

  function updateDiscoveryIndicator() {
    const palette = document.getElementById('hu-palette');
    if (!palette) return;
    let el = document.getElementById('hu-palette-discovery');

    const inFlightSize = HU.configDiscoveryInFlight.size;
    const warmup = HU.configWarmupProgress;
    const active = inFlightSize > 0 || warmup.total > 0;

    if (!active) {
      if (el) el.remove();
      return;
    }

    if (!el) {
      el = document.createElement('div');
      el.id = 'hu-palette-discovery';
      el.className = 'hu-palette-discovery';
      palette.appendChild(el);
    }

    let label;
    if (warmup.total > 0) {
      label = `Indexing ${warmup.sectionLabel || 'configuration'} (${warmup.current}/${warmup.total})`;
    } else {
      const slug = [...HU.configDiscoveryInFlight][0];
      const section = slug && CONFIG_SECTIONS.find(c => c.slug === slug);
      label = section ? `Indexing ${section.label}…` : 'Indexing…';
    }
    el.innerHTML = `<span class="hu-spinner"></span><span>${escapeHtml(label)}</span>`;
  }

  function discoverSectionSubnav(slug, settleMs = 1500, timeoutMs = 6000) {
    return new Promise(resolve => {
      if (!CONFIG_SECTIONS.find(c => c.slug === slug)) return resolve([]);
      if (HU.configDiscoveryInFlight.has(slug)) return resolve([]);
      HU.configDiscoveryInFlight.add(slug);
      updateDiscoveryIndicator();

      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-100000px;top:0;width:1280px;height:800px;border:0;visibility:hidden;pointer-events:none;';
      iframe.src = `/config/${slug}`;
      let done = false;
      const finish = (subs) => {
        if (done) return;
        done = true;
        HU.configDiscoveryInFlight.delete(slug);
        updateDiscoveryIndicator();
        try { iframe.remove(); } catch (_) {}
        resolve(subs || []);
      };
      iframe.addEventListener('load', () => {
        setTimeout(() => {
          let subs = [];
          try {
            const doc = iframe.contentDocument;
            if (doc) subs = scrapeSubnavFromDoc(doc, slug);
          } catch (_) {}
          if (subs.length) saveConfigTreeSection(slug, subs);
          finish(subs);
        }, settleMs);
      });
      iframe.addEventListener('error', () => finish([]));
      setTimeout(() => finish([]), timeoutMs);
      document.body.appendChild(iframe);
    });
  }

  async function warmupConfigDiscovery() {
    const data = await storageGet(['huConfigDiscovery', 'huConfigDiscoveryLock', 'huConfigTree']);
    if (data.huConfigDiscovery?.warmupDone) return;
    const lockAge = Date.now() - (data.huConfigDiscoveryLock || 0);
    if (lockAge < 180000) return;
    await new Promise(r => chrome.storage.local.set({ huConfigDiscoveryLock: Date.now() }, r));

    HU.configTree = data.huConfigTree || {};
    const total = CONFIG_SECTIONS.length;
    for (let i = 0; i < total; i++) {
      const section = CONFIG_SECTIONS[i];
      if (HU.configTree[section.slug]?.length) continue;
      HU.configWarmupProgress = { current: i + 1, total, sectionLabel: section.label };
      updateDiscoveryIndicator();
      try { await discoverSectionSubnav(section.slug); } catch (_) {}
      await new Promise(r => setTimeout(r, 800));
    }
    HU.configWarmupProgress = { current: 0, total: 0, sectionLabel: '' };
    updateDiscoveryIndicator();

    chrome.storage.local.set({ huConfigDiscovery: { warmupDone: true, warmupAt: Date.now() } });
    chrome.storage.local.remove('huConfigDiscoveryLock');
  }

  function buildConfigResults(configQuery) {
    const tree = HU.configTree || {};

    if (configQuery.exactSection) {
      const sec = configQuery.exactSection;
      const cachedSubs = tree[sec.slug] || [];

      if (configQuery.subpath) {
        const subLower = configQuery.subpath.toLowerCase();
        const matching = cachedSubs.filter(s =>
          s.slug.includes(subLower) || s.label.toLowerCase().includes(subLower)
        );
        if (matching.length) {
          return matching.map(s => buildSubsectionResult(sec, s));
        }
        const url = new URL(`/config/${sec.slug}/${configQuery.subpath}`, window.location.origin).href;
        return [{
          title: `${sec.label} / ${configQuery.subpath}`,
          subtitle: `/config/${sec.slug}/${configQuery.subpath}`,
          kind: 'Config',
          type: 'navigate',
          url,
          isConfigDeepLink: true
        }];
      }

      const sectionResult = {
        title: sec.label,
        subtitle: `/config/${sec.slug}`,
        kind: 'Config',
        type: 'navigate',
        url: new URL(`/config/${sec.slug}`, window.location.origin).href,
        configSlug: sec.slug
      };
      return [sectionResult, ...cachedSubs.map(s => buildSubsectionResult(sec, s))];
    }

    const search = configQuery.rawSearch.toLowerCase();
    const matches = CONFIG_SECTIONS.filter(c => {
      if (!search) return true;
      const hay = `${c.slug} ${c.label} ${c.keywords.join(' ')}`.toLowerCase();
      return hay.includes(search);
    });

    return matches.map(c => {
      const cached = tree[c.slug] || [];
      const kind = cached.length ? `${cached.length} ›` : 'Config';
      return {
        title: c.label,
        subtitle: `/config/${c.slug}`,
        kind,
        type: 'navigate',
        url: new URL(`/config/${c.slug}`, window.location.origin).href,
        configSlug: c.slug,
        subCount: cached.length
      };
    });
  }

  function buildSubsectionResult(section, sub) {
    return {
      title: `${section.label} / ${sub.label}`,
      subtitle: `/config/${section.slug}/${sub.slug}`,
      kind: 'Config',
      type: 'navigate',
      url: new URL(`/config/${section.slug}/${sub.slug}`, window.location.origin).href,
      configSlug: section.slug,
      subSlug: sub.slug
    };
  }

  function getImpersonationFooterTitle(query) {
    if (!query && HU.impersonatedAgentId) return 'Press Enter to switch back';
    return query ? `Searching agents for "${query}"` : 'Type an agent name or ID';
  }

  function getImpersonationFooterSubtitle(query) {
    if (!query && HU.impersonatedAgentId) return `Currently impersonating agent ${HU.impersonatedAgentId}`;
    return 'Select an agent to start Halo impersonation';
  }

  async function runImpersonationCommand() {
    if (HU.impersonatedAgentId) {
      await exitImpersonation();
      return;
    }
    openPalette('imp ');
  }

  async function searchAgentsForImpersonation(query) {
    // Entity-API path (works for non-admin agents who have the Can_Impersonate
    // claim). Falls back to SQL only when entity API throws something other
    // than a permission/404 (admins still benefit from the SQL path if they
    // hit a network blip on /api/agent).
    try {
      const term = String(query || '').trim();
      const params = new URLSearchParams();
      if (term) params.set('search', term);
      params.set('count', '10');
      const response = await haloApiRequest(`/api/agent?${params.toString()}`);
      const records = extractEntityList(response, 'agents');
      const mapped = records.map(record => {
        const id = record.id != null ? record.id : record.uid;
        if (id == null) return null;
        const title = record.name || record.username || `Agent ${id}`;
        const email = record.email || record.emailaddress || record.jobtitle || '';
        return {
          title,
          subtitle: `${email || 'Agent'} - id ${id}`,
          kind: 'Impersonate',
          type: 'impersonate',
          agentId: id
        };
      }).filter(Boolean);

      // Numeric query: ensure exact-id hit isn't missed by the server search.
      if (/^\d+$/.test(term)) {
        try {
          const exact = await haloApiRequest(`/api/agent/${Number(term)}`);
          if (exact && exact.id != null) {
            const dup = mapped.find(m => String(m.agentId) === String(exact.id));
            if (!dup) {
              mapped.unshift({
                title: exact.name || exact.username || `Agent ${exact.id}`,
                subtitle: `${exact.email || exact.emailaddress || 'Agent'} - id ${exact.id}`,
                kind: 'Impersonate',
                type: 'impersonate',
                agentId: exact.id
              });
            }
          }
        } catch (_) {}
      }

      return mapped.slice(0, 10);
    } catch (_) {
      // SQL fallback — only useful for admins. Non-admins will get an empty
      // array since /api/Report 403s.
    }

    if (HU.reportApiOk === false) return [];

    const escaped = sqlEscape(query);
    const numeric = /^\d+$/.test(query);
    const where = numeric
      ? `UNum = ${Number(query)} OR UName LIKE '%${escaped}%' OR USMTP LIKE '%${escaped}%'`
      : `UName LIKE '%${escaped}%' OR USMTP LIKE '%${escaped}%' OR CAST(UNum AS nvarchar(30)) LIKE '%${escaped}%'`;
    const sql = `
SELECT TOP 10
  UNum AS [id],
  UName AS [title],
  USMTP AS [subtitle]
FROM
  uname
WHERE
  ${where}
ORDER BY
  UName
`.trim();

    const payload = await runHaloReport(sql, 'HaloPlus Impersonation Agent Search');
    return extractRows(payload).map(row => ({
      title: row.title || `Agent ${row.id}`,
      subtitle: `${row.subtitle || 'Agent'} - UName.UNum = ${row.id}`,
      kind: 'Impersonate',
      type: 'impersonate',
      agentId: row.id
    }));
  }

  async function searchHaloRecords(query) {
    // Open-ended palette search relies entirely on /api/Report SQL. Non-admin
    // agents 403 on every keystroke — skip the whole batch so we don't flood
    // the network tab with guaranteed failures.
    if (HU.reportApiOk === false) return [];

    const escaped = sqlEscape(query);
    const numeric = /^\d+$/.test(query);
    const clauses = numeric ? [] : [
      searchSql('Ticket',     'ticket',   'faults',   'Faultid', 'Symptom',   'Username', `CAST(Faultid AS nvarchar(30)) LIKE '%${escaped}%' OR Symptom LIKE '%${escaped}%' OR Username LIKE '%${escaped}%'`),
      searchSql('Customer',   'customer', 'area',     'AArea',   'AAreaDesc', 'AMemo',    `CAST(AArea AS nvarchar(30)) LIKE '%${escaped}%' OR AAreaDesc LIKE '%${escaped}%'`),
      searchSql('Agent',      'agent',    'uname',    'UNum',    'UName',     'USMTP',    `CAST(UNum AS nvarchar(30)) LIKE '%${escaped}%' OR UName LIKE '%${escaped}%' OR USMTP LIKE '%${escaped}%'`),
      searchSql('User',       'user',     'users',    'uid',     'UUsername', 'UEmail',   `CAST(uid AS nvarchar(30)) LIKE '%${escaped}%' OR UUsername LIKE '%${escaped}%' OR UEmail LIKE '%${escaped}%'`),
      searchSql('Asset',      'asset',    'device',   'DID',     'DInvNo',    'DID',      `DID LIKE '%${escaped}%' OR DInvNo LIKE '%${escaped}%'`),
      searchSql('KB Article', 'kb',       'kbentry',  'kbid',    'Abstract',  'Abstract', `Abstract LIKE '%${escaped}%'`),
      searchSql('Invoice',    'invoice',  'invoiceheader', 'ihid', 'IH3rdPartyInvoiceNumber', 'IHname', `CAST(ihid AS nvarchar(30)) LIKE '%${escaped}%' OR IH3rdPartyInvoiceNumber LIKE '%${escaped}%' OR IHname LIKE '%${escaped}%'`),
      searchSql('Quote',      'quote',    'quotationheader', 'qhid', 'QHtitle', 'QHPORef', `CAST(qhid AS nvarchar(30)) LIKE '%${escaped}%' OR QHtitle LIKE '%${escaped}%' OR QHPORef LIKE '%${escaped}%'`),
      searchSql('Purchase Order', 'purchase', 'supplierorderheader', 'SHid', 'SHtitle', 'SHPORef', `CAST(SHid AS nvarchar(30)) LIKE '%${escaped}%' OR SHtitle LIKE '%${escaped}%' OR SHPORef LIKE '%${escaped}%'`)
    ];

    if (numeric) {
      clauses.push(searchSql('Ticket',     'ticket',   'faults',  'Faultid', 'Symptom',   'Username', `Faultid = ${Number(query)}`));
      clauses.push(searchSql('Customer',   'customer', 'area',    'AArea',   'AAreaDesc', 'AMemo',    `AArea = ${Number(query)}`));
      clauses.push(searchSql('Agent',      'agent',    'uname',   'UNum',    'UName',     'USMTP',    `UNum = ${Number(query)}`));
      clauses.push(searchSql('User',       'user',     'users',   'uid',     'UUsername', 'UEmail',   `uid = ${Number(query)}`));
      clauses.push(searchSql('KB Article', 'kb',       'kbentry', 'kbid',    'Abstract',  'Abstract', `kbid = ${Number(query)}`));
      clauses.push(searchSql('Invoice',    'invoice',  'invoiceheader', 'ihid', 'IH3rdPartyInvoiceNumber', 'IHname', `ihid = ${Number(query)}`));
      clauses.push(searchSql('Quote',      'quote',    'quotationheader', 'qhid', 'QHtitle', 'QHPORef', `qhid = ${Number(query)}`));
      clauses.push(searchSql('Purchase Order', 'purchase', 'supplierorderheader', 'SHid', 'SHtitle', 'SHPORef', `SHid = ${Number(query)}`));
    }

    const batches = await Promise.allSettled(clauses.map(item => runSearchQuery(item)));
    return batches.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, 20);
  }

  function searchSql(kind, routeType, table, idColumn, titleColumn, subtitleColumn, where) {
    return { kind, routeType, table, idColumn, titleColumn, subtitleColumn, where };
  }

  function buildSearchSql(def, withExtras, withType) {
    const extraCols = withExtras ? (def.extraCols || []) : [];
    const extraSelect = extraCols.map((expr, i) => `  ${expr} AS [extra${i}]`).join(',\n');
    const typeClause = withType && def.typeId ? ` AND RequestTypeNew = ${Number(def.typeId)}` : '';
    const fullWhere = typeClause ? `(${def.where})${typeClause}` : def.where;
    const orderBy = def.searchTerm
      ? `\nORDER BY\n  ${buildSqlSearchOrder(def.idColumn, def.titleColumn, def.subtitleColumn, def.searchTerm)}`
      : '';
    return {
      sql: `
SELECT TOP 5
  ${def.idColumn} AS [id],
  ${def.titleColumn} AS [title],
  ${def.subtitleColumn} AS [subtitle]${extraSelect ? ',\n' + extraSelect : ''}
FROM
  ${def.table}
WHERE
  ${fullWhere}
${orderBy}
`.trim(),
      extraCols
    };
  }

  async function runSearchQuerySql(def, withExtras, withType) {
    const built = buildSearchSql(def, withExtras, withType);
    const payload = await runHaloReport(built.sql, `HaloPlus ${def.kind} Search`);
    const err = getReportLoadError(payload);
    if (err) throw new Error(err);
    return { payload, extraCols: built.extraCols };
  }

  async function runSearchQuery(def) {
    const hasExtras = (def.extraCols || []).length > 0;
    const hasType = !!def.typeId;
    // Degrade: extras and type, then no extras, then no type.
    const attempts = [];
    if (hasExtras && hasType) attempts.push([true, true]);
    if (hasType)              attempts.push([false, true]);
                              attempts.push([false, false]);
    let lastErr;
    for (const [extras, type] of attempts) {
      try {
        const { payload, extraCols } = await runSearchQuerySql(def, extras, type);
        return extractRows(payload).map(row => {
          const parts = [row.subtitle, ...extraCols.map((_, i) => row[`extra${i}`])]
            .map(v => (v == null ? '' : String(v)).trim())
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);
          return {
            id: row.id,
            recordId: row.id,
            title: formatSearchResultTitle(def, row),
            subtitle: parts.join(' | ') || `${def.table}.${def.idColumn} = ${row.id}`,
            kind: def.kind,
            type: 'navigate',
            url: new URL(routeDetail(def.routeType, row.id), window.location.origin).href
          };
        });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function formatSearchResultTitle(def, row) {
    if (def.routeType === 'ticket' || def.route === 'ticket') {
      const num = formatTicketNumber(row.id);
      if (def.emailTag) {
        const tag = typeof def.emailTag === 'object' ? def.emailTag : { start: def.emailTag, end: ']' };
        return `${tag.start}${num}${tag.end} ${row.title || 'Untitled ticket'}`;
      }
      if (def.ticketPrefix) {
        return `[${def.ticketPrefix}-${num}] ${row.title || 'Untitled ticket'}`;
      }
      return `[#${num}] ${row.title || 'Untitled ticket'}`;
    }
    return row.title || `${def.kind} ${row.id}`;
  }

  function formatTicketNumber(value) {
    const id = String(value || '').replace(/\D/g, '');
    return id ? id.padStart(7, '0') : String(value || '');
  }

  function makePaletteButton(item, index) {
    const button = document.createElement('button');
    if (item.loading) {
      button.className = 'hu-result hu-result-loading';
      button.dataset.resultIndex = String(index);
      button.setAttribute('aria-busy', 'true');
      button.type = 'button';
      button.innerHTML = `
        <span>
          <span class="hu-result-title"><span class="hu-spinner"></span>${escapeHtml(item.title || 'Searching…')}</span>
          <span class="hu-result-sub">${escapeHtml(item.subtitle || '')}</span>
        </span>
        <span class="hu-result-kind"></span>
      `;
      return button;
    }
    const disabled = !!item.disabled;
    button.className = `hu-result ${index === HU.selectedIndex ? 'hu-active' : ''} ${disabled ? 'hu-disabled' : ''}`.trim();
    button.dataset.resultIndex = String(index);
    if (disabled) {
      button.setAttribute('aria-disabled', 'true');
      if (item.disabledReason) button.title = item.disabledReason;
    }
    const kindClass = item.subCount > 0 ? 'hu-result-kind hu-result-kind-accent' : 'hu-result-kind';
    const kindLabel = disabled ? 'No access' : (item.kind || item.type || 'Action');
    // Ticket-status pill: small coloured chip prepended to the subtitle. Colour
    // comes from Halo's cache_status; sanitised to a hex/rgb match so the
    // user-controlled string can't break out into other CSS rules.
    let statusHtml = '';
    if (item.status && item.status.name) {
      const raw = String(item.status.colour || '').trim();
      const safeColor = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw
                      : /^rgb(a)?\([^)]+\)$/i.test(raw) ? raw
                      : '#5b6478';
      statusHtml = `<span class="hu-status-pill" style="background:${safeColor}">${escapeHtml(item.status.name)}</span>`;
    }
    const ticketTypeHtml = item.ticketType
      ? `<span class="hu-type-pill">${escapeHtml(item.ticketType)}</span>`
      : '';
    button.innerHTML = `
      <span>
        <span class="hu-result-title">${escapeHtml(item.displayTitle || item.title)}</span>
        <span class="hu-result-sub">${statusHtml}${ticketTypeHtml}${escapeHtml(disabled && item.disabledReason ? item.disabledReason : (item.subtitle || ''))}</span>
      </span>
      <span class="${kindClass}">${escapeHtml(kindLabel)}</span>
    `;
    button.addEventListener('mousemove', () => {
      if (HU.selectedIndex !== index) setPaletteSelection(index);
    });
    if (!disabled) button.addEventListener('click', () => activateResult(item));

    // Secondary action on the right-side chip — opens whichever submenu is
    // appropriate for the row type:
    //   - /cfg row (isCfgEntry)              → cfg section list
    //   - cfg section row with subsections   → that section's subsections
    //   - ticket-scoped command with count   → open tickets in that scope
    if (!disabled) {
      const chip = button.querySelector('.hu-result-kind');
      const drillsCfg = !!item.isCfgEntry;
      const drillsCfgSection = !!item.configSlug && !item.subSlug && Number(item.subCount) > 0;
      const drillsOpenScope = item.type === 'command' &&
        Number(item.subCount) > 0 &&
        isTicketScopedCommandId(item.id);
      if (chip && (drillsCfg || drillsCfgSection || drillsOpenScope)) {
        chip.classList.add('hu-result-kind-clickable');
        chip.setAttribute('title',
          drillsCfg         ? 'Open sub-sections' :
          drillsCfgSection  ? 'Open this section' :
                              'Show open tickets');
        chip.addEventListener('click', e => {
          e.stopPropagation();
          if (drillsCfg)        drillPaletteIntoCfg();
          else if (drillsCfgSection) drillPaletteIntoCfgSection(item.configSlug);
          else                  drillPaletteIntoOpenScope(item.id);
        });
      }
    }
    return button;
  }

  function drillPaletteIntoCfgSection(sectionSlug) {
    const input = document.getElementById('hu-palette-input');
    if (!input || !sectionSlug) return;
    HU.paletteOpenOnlyScope = null;
    input.value = `/cfg ${sectionSlug} `;
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    updatePaletteFooter(input.value);
    runPaletteSearch(input.value);
  }

  // True for commands whose scoped form runs against /api/tickets — i.e.
  // any built-in ticket route (/t, /i, /chg, /prob, ...) and every custom
  // ticket type discovered on the tenant.
  function isTicketScopedCommandId(commandId) {
    if (!commandId) return false;
    if (HU.ticketTypeSearchMap && HU.ticketTypeSearchMap[commandId]) return true;
    const def = ENTITY_SEARCH_MAP[commandId];
    return !!(def && def.route === 'ticket');
  }

  function drillPaletteIntoCfg() {
    const input = document.getElementById('hu-palette-input');
    if (!input) return;
    HU.paletteOpenOnlyScope = null;
    input.value = '/cfg ';
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    updatePaletteFooter(input.value);
    runPaletteSearch(input.value);
  }

  function drillPaletteIntoOpenScope(commandId) {
    const input = document.getElementById('hu-palette-input');
    if (!input) return;
    HU.paletteOpenOnlyScope = commandId;
    input.value = `/${commandId} `;
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    updatePaletteFooter(input.value);
    runPaletteSearch(input.value);
  }

  function makeShowAllButton(item, index) {
    const button = makePaletteButton(item, index);
    button.classList.add('hu-show-all-result');
    return button;
  }

  function setPaletteSelection(index) {
    HU.selectedIndex = index;
    const list = document.getElementById('hu-palette-list');
    if (!list) return;
    let activeNode = null;
    list.querySelectorAll('.hu-result').forEach(node => {
      const isActive = Number(node.dataset.resultIndex) === index;
      node.classList.toggle('hu-active', isActive);
      if (isActive) activeNode = node;
    });
    if (activeNode && typeof activeNode.scrollIntoView === 'function') {
      activeNode.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderPaletteResults(results, grouped = false) {
    const list = document.getElementById('hu-palette-list');
    if (!list) return;
    HU.paletteGrouped = grouped;

    if (!results.length) {
      const input = document.getElementById('hu-palette-input');
      if (getImpersonationQuery(input?.value || '') !== null) {
        list.innerHTML = '';
        return;
      }
      list.innerHTML = '<div class="hu-row"><span class="hu-row-title">No matches</span><span class="hu-row-sub">Try a ticket number, customer name, setting name, or built-in command.</span></div>';
      return;
    }

    list.innerHTML = '';

    if (grouped) {
      const groups = new Map();
      results.forEach((item, index) => {
        const g = item.kind || 'Tools';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ item, index });
      });
      groups.forEach((entries, group) => {
        const section = document.createElement('div');
        section.className = 'hu-row hu-section-row';
        section.innerHTML = `<span class="hu-section-label">${escapeHtml(group)}</span>`;
        list.appendChild(section);
        entries.forEach(({ item, index }) => list.appendChild(makePaletteButton(item, index)));
      });
    } else {
      results.forEach((item, index) => {
        const button = item.type === 'show-all' ? makeShowAllButton(item, index) : makePaletteButton(item, index);
        list.appendChild(button);
      });
    }
  }

  async function activateResult(item) {
    if (item.disabled) return;

    if (item.type === 'show-all') {
      HU.paletteShowAll = true;
      HU.paletteResults = getDefaultCommandResults();
      HU.selectedIndex = Math.min(HU.selectedIndex, HU.paletteResults.length - 1);
      renderPaletteResults(HU.paletteResults, false);
      return;
    }

    const inputEl = document.getElementById('hu-palette-input');
    if (inputEl) pushCommandHistory(inputEl.value);
    closePalette();
    await trackRecentCommand(item).catch(() => {});
    if (item.type === 'command') { item.run(); return; }
    if (item.type === 'navigation' && item.url) { navigateTo(item.url); return; }
    if (item.type === 'navigate' && item.url) { navigateTo(item.url); return; }
    if (item.type === 'sql' && item.sql) { runCustomSqlCommand(item.title, item.sql); return; }
    if (item.type === 'impersonate') { impersonateAgent(item.agentId, item.title); }
  }

  async function runCustomSqlCommand(title, sql) {
    injectStyles();
    closeDrawer('hu-sql-drawer');
    const drawer = createDrawer('hu-sql-drawer', `/${escapeHtml(title)}`);
    const body = drawer.querySelector('.hu-drawer-body');
    body.innerHTML = '<div class="hu-row"><span class="hu-row-title">Running query...</span></div>';
    openDrawer(drawer);

    try {
      const payload = await runHaloReport(sql, `HaloPlus /${title}`);
      const rows = extractRows(payload);
      if (!rows.length) {
        body.innerHTML = '<div class="hu-row"><span class="hu-row-title">No results</span><span class="hu-row-sub">The query returned no rows.</span></div>';
        return;
      }
      body.innerHTML = '';
      const columns = Object.keys(rows[0]);
      const wrap = document.createElement('div');
      wrap.style.cssText = 'overflow:auto;';
      const table = document.createElement('table');
      table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        th.style.cssText = 'padding:5px 8px;text-align:left;border-bottom:2px solid #e3e7ef;font-size:11px;color:#667085;font-weight:600;white-space:nowrap;';
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      const tbody = document.createElement('tbody');
      rows.forEach((row, ri) => {
        const tr = document.createElement('tr');
        tr.style.background = ri % 2 ? '#f8fafc' : '';
        columns.forEach(col => {
          const td = document.createElement('td');
          td.textContent = row[col] ?? '';
          td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #edf0f5;font-size:12px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      wrap.appendChild(table);
      body.appendChild(wrap);
      const meta = document.createElement('div');
      meta.style.cssText = 'padding:7px 10px;font-size:11px;color:#667085;border-top:1px solid #e3e7ef;flex-shrink:0;';
      meta.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`;
      drawer.appendChild(meta);
    } catch (err) {
      body.innerHTML = `<div class="hu-row"><span class="hu-row-title">Query failed</span><span class="hu-row-sub">${escapeHtml(err.message)}</span></div>`;
    }
  }

  async function impersonateAgent(agentId, agentName) {
    if (!agentId) {
      toast('No agent selected');
      return;
    }

    try {
      toast(`Starting impersonation for ${agentName || `agent ${agentId}`}...`);
      const payload = await postHaloJson('/api/ImpersonationRequest', { agent: String(agentId) });
      const redirect = findImpersonationRedirect(payload);
      HU.impersonatedAgentId = String(agentId);
      await storageSet({ huImpersonatedAgentId: String(agentId) });
      window.location.assign(buildCurrentPageImpersonationUrl(redirect));
    } catch (error) {
      toast(`Could not impersonate agent: ${error.message}`);
    }
  }

  function buildCurrentPageImpersonationUrl(redirect) {
    const url = new URL(window.location.href);
    url.searchParams.delete('switchback');

    const actAs = extractActAsToken(redirect);
    if (actAs) url.searchParams.set('act_as', actAs);

    return url.href;
  }

  function extractActAsToken(redirect) {
    if (!redirect) return '';

    try {
      const parsed = new URL(redirect, window.location.origin);
      const actAs = parsed.searchParams.get('act_as');
      if (actAs) return actAs;
    } catch (e) {
      // Fall through to raw query parsing.
    }

    const query = String(redirect).includes('?')
      ? String(redirect).split('?').slice(1).join('?')
      : String(redirect);
    const params = new URLSearchParams(query);
    return params.get('act_as') || '';
  }

  function findImpersonationRedirect(payload) {
    const strings = [];
    const visit = value => {
      if (!value) return;
      if (typeof value === 'string') {
        strings.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(payload);

    const url = strings.find(value => /^https?:\/\//i.test(value) || value.startsWith('/') || value.includes('act_as='));
    if (url) return url.includes('act_as=') && !/^https?:\/\//i.test(url) && !url.startsWith('/') ? `/home?${url}` : url;

    const jwt = strings.find(value => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value));
    return jwt ? `/home?act_as=${encodeURIComponent(jwt)}` : '';
  }

  async function exitImpersonation() {
    const url = new URL(window.location.href);

    url.searchParams.delete('act_as');
    url.searchParams.set('switchback', 'true');
    HU.impersonatedAgentId = '';
    await storageSet({ huImpersonatedAgentId: '' });
    window.location.assign(url.href);
  }

  async function loadImpersonationState() {
    const data = await storageGet(['huImpersonatedAgentId']);
    HU.impersonatedAgentId = data.huImpersonatedAgentId || '';
    if (new URL(window.location.href).searchParams.get('switchback') === 'true') {
      HU.impersonatedAgentId = '';
      await storageSet({ huImpersonatedAgentId: '' });
    }
  }

  function fuzzyMatch(haystack, query) {
    if (!query) return true;
    const normalizedHaystack = normalizeQuery(haystack);
    return query.split(/\s+/).every(part => normalizedHaystack.includes(part));
  }

  function normalizeQuery(value) {
    return String(value || '').toLowerCase().trim().replace(/^\/+/, '');
  }

  function sqlEscape(value) {
    return String(value).replace(/'/g, "''");
  }

  async function loadShortcuts() {
    const data = await storageGet(['huShortcuts']);
    HU.shortcuts = data.huShortcuts || [];
    return HU.shortcuts;
  }

  async function loadCustomCommands() {
    const data = await storageGet(['huCustomCommands']);
    HU.customCommands = data.huCustomCommands || [];
  }

  async function loadRecentCommands() {
    const data = await storageGet(['huRecentCommands']);
    HU.recentCommands = data.huRecentCommands || [];
    return HU.recentCommands;
  }

  async function loadCommandHistory() {
    const data = await storageGet(['huCommandHistory']);
    HU.commandHistory = Array.isArray(data.huCommandHistory) ? data.huCommandHistory : [];
  }

  function pushCommandHistory(rawQuery) {
    const trimmed = String(rawQuery || '').trim();
    if (!trimmed || trimmed === '/') return;
    HU.commandHistory = [trimmed, ...HU.commandHistory.filter(q => q !== trimmed)].slice(0, 50);
    chrome.storage.local.set({ huCommandHistory: HU.commandHistory });
  }

  function getRecentCommandResults() {
    return (HU.recentCommands || [])
      .map(entry => resolveRecentCommand(entry))
      .filter(Boolean)
      .slice(0, 10);
  }

  function getDefaultCommandResults() {
    const allCommands = getPaletteCommandCatalog();
    if (HU.paletteShowAll || allCommands.length <= 10) return allCommands;

    const visible = allCommands.slice(0, 10);
    const hiddenCount = allCommands.length - visible.length;
    return [
      ...visible,
      {
        title: `+${hiddenCount}`,
        subtitle: 'Show all commands',
        kind: '',
        type: 'show-all'
      }
    ];
  }

  function getPaletteCommandCatalog() {
    const seen = new Set();
    const addUnique = (items, output) => {
      items.forEach(item => {
        const key = getRecentCommandKey(item) || `${item.type}:${item.id || item.title}`;
        if (!key || seen.has(key)) return;
        if (!isPaletteCommandAvailable(item)) return;
        seen.add(key);
        output.push(item);
      });
    };

    const output = [];
    addUnique(getRecentCommandResults(), output);
    addUnique(getBuiltinCommandResults(), output);
    addUnique(getCustomCommandResults(), output);
    return output;
  }

  function getBuiltinCommandResults() {
    const all = [...BASE_COMMANDS, ...HU.ticketTypeCommands].filter(isPaletteCommandAvailable);
    // Lazy: kick off count/tag fetches for these commands' typeIds. Already-
    // fetched IDs are skipped, and the fetcher re-renders the palette when
    // new data arrives. Scheduled async so it doesn't block this synchronous
    // render path.
    setTimeout(() => scheduleVisibleCommandFetches(all), 0);
    return all
      .map(command => {
        const disabled = isEntityCommandDisabled(command.id);
        const openCount = getCommandOpenCount(command.id);
        return {
          ...command,
          displayTitle: `/${command.id}`,
          subtitle: command.subtitle ? `${command.title} - ${command.subtitle}` : command.title,
          kind: openCount != null ? `${openCount} open` : (command.kind || 'Tools'),
          subCount: openCount != null ? openCount : undefined,
          disabled,
          disabledReason: disabled ? entityDisabledTooltip(command.id) : '',
          ...(command.id === 'cfg'
            ? { isCfgEntry: true, subCount: CONFIG_SECTIONS.length, kind: `${CONFIG_SECTIONS.length} ›` }
            : {})
        };
      })
      .sort((a, b) => Number(a.disabled) - Number(b.disabled));
  }

  function isPaletteCommandAvailable(item) {
    if (!item) return false;
    if (['360', 'tl'].includes(item.id)) return Boolean(getCurrentTicketId());
    if (item.id === 'j') return Boolean(detectRecordFromUrl());
    if (item.id === 'f') return Boolean(document.body);

    // Permission gating for admin-only or claim-gated commands. Hidden entirely
    // for users who can't run them — entity-search greying applies to typed
    // searches; these are action commands with no useful "preview" state.
    const perms = readHaloPermissions();
    if (item.id === 'imp' && !perms.canImpersonate) return false;
    if (item.id === 'xi'  && !perms.isImpersonating) return false;
    if (item.id === 'cfg' && !perms.isAdmin) return false;

    return true;
  }

  function getCustomCommandResults() {
    return HU.customCommands.map(cmd => ({
      id: cmd.id,
      displayTitle: `/${cmd.title}`,
      title: cmd.title,
      subtitle: cmd.subtitle || (cmd.type === 'sql' ? 'SQL command' : cmd.url || ''),
      kind: cmd.category || (cmd.type === 'navigation' ? 'Navigation' : 'SQL'),
      type: cmd.type,
      url: cmd.url,
      sql: cmd.sql
    }));
  }

  function buildSqlSearchOrder(idColumn, titleColumn, subtitleColumn, searchTerm) {
    const escaped = sqlEscape(searchTerm);
    const numeric = /^\d+$/.test(searchTerm);
    const idExpr = `CONVERT(nvarchar(max), ${idColumn})`;
    const titleExpr = `CONVERT(nvarchar(max), ${titleColumn})`;
    const subtitleExpr = `CONVERT(nvarchar(max), ${subtitleColumn})`;
    const numericExact = numeric ? `WHEN ${idColumn} = ${Number(searchTerm)} THEN 0` : '';
    return `
  CASE
    ${numericExact}
    WHEN ${idExpr} = '${escaped}' THEN 1
    WHEN ${idExpr} LIKE '${escaped}%' THEN 2
    WHEN ${idExpr} LIKE '%${escaped}%' THEN 3
    WHEN ${titleExpr} = '${escaped}' THEN 4
    WHEN ${titleExpr} LIKE '${escaped}%' THEN 5
    WHEN ${subtitleExpr} LIKE '${escaped}%' THEN 6
    WHEN ${titleExpr} LIKE '%${escaped}%' THEN 7
    WHEN ${subtitleExpr} LIKE '%${escaped}%' THEN 8
    ELSE 9
  END,
  ${titleExpr}
`.trim();
  }

  function resolveRecentCommand(entry) {
    if (!entry?.key) return null;

    if (entry.key.startsWith('base:')) {
      const id = entry.key.slice(5);
      const command = BASE_COMMANDS.find(item => item.id === id)
        || HU.ticketTypeCommands.find(item => item.id === id);
      if (!isPaletteCommandAvailable(command)) return null;
      if (!command) return null;
      const disabled = isEntityCommandDisabled(command.id);
      const openCount = getCommandOpenCount(command.id);
      return {
        ...command,
        displayTitle: entry.displayTitle || `/${command.id}`,
        subtitle: command.subtitle ? `${command.title} - ${command.subtitle}` : command.title,
        kind: openCount != null ? `${openCount} open` : (command.kind || 'Tools'),
        subCount: openCount != null ? openCount : undefined,
        disabled,
        disabledReason: disabled ? entityDisabledTooltip(command.id) : '',
        ...(command.id === 'cfg'
          ? { isCfgEntry: true, subCount: CONFIG_SECTIONS.length, kind: `${CONFIG_SECTIONS.length} ›` }
          : {})
      };
    }

    if (entry.key.startsWith('custom:')) {
      const id = entry.key.slice(7);
      const cmd = HU.customCommands.find(item => item.id === id);
      if (!cmd) return null;
      return {
        id: cmd.id,
        displayTitle: entry.displayTitle || `/${cmd.title}`,
        title: cmd.title,
        subtitle: cmd.subtitle || (cmd.type === 'sql' ? 'SQL command' : cmd.url || ''),
        kind: cmd.category || (cmd.type === 'navigation' ? 'Navigation' : 'SQL'),
        type: cmd.type,
        url: cmd.url,
        sql: cmd.sql
      };
    }

    return null;
  }

  async function trackRecentCommand(item) {
    const key = getRecentCommandKey(item);
    if (!key) return;

    const entry = {
      key,
      title: item.title || '',
      displayTitle: item.displayTitle || '',
      subtitle: item.subtitle || '',
      kind: item.kind || '',
      usedAt: new Date().toISOString()
    };
    const next = [entry, ...HU.recentCommands.filter(command => command.key !== key)].slice(0, 10);
    HU.recentCommands = next;
    await storageSet({ huRecentCommands: next });
  }

  function getRecentCommandKey(item) {
    if (!item) return '';
    const isBaseCommand = item.type === 'command' && item.id;
    if (isBaseCommand) return `base:${item.id}`;
    const isCustomCommand = (item.type === 'navigation' || item.type === 'sql') && item.id;
    return isCustomCommand ? `custom:${item.id}` : '';
  }

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function getTicketAreaForType(typeId, name) {
    const normalized = String(name || '').toLowerCase();
    if (normalized.includes('major incident')) return 13;
    if (normalized.includes('article draft')) return 10;
    if (normalized.includes('facilities') || normalized.includes('facility') ||
      normalized.includes('air con') || normalized.includes('building') ||
      normalized.includes('electrical') || normalized.includes('parking') ||
      normalized.includes('plumbing') || normalized.includes('event request')) return 9;
    if (normalized.includes('hr ') || normalized.includes('human resources') ||
      normalized.includes('payroll') || normalized.includes('employment') ||
      normalized.includes('absence') || normalized.includes('benefit') ||
      normalized.includes('employee') || normalized.includes('grievance') ||
      normalized.includes('retirement')) return 8;
    if (normalized.includes('project')) return 7;
    if (normalized.includes('change')) return 3;
    if (normalized.includes('problem')) return 2;
    if (normalized.includes('incident')) return 1;
    return 4;
  }

  async function loadTicketTypes() {
    try {
      let types = [];

      // 1. SQL is the richest source — includes rtGID/rtGIDEND email tag overrides
      // that the localStorage cache doesn't carry. Admins succeed here.
      try {
        const rows = extractRows(await runHaloReport(
          `SELECT RTid AS [id], rtdesc AS [name], ISNULL(rtGID, '') AS [rtGID], ISNULL(rtGIDEND, '') AS [rtGIDEND] FROM requesttype`,
          'HaloPlus Request Types'
        ));
        if (rows.length) types = rows;
      } catch (_) {}

      // 2. Halo entity API — returns the full TicketType list. includedetails=true
      // is required for tag-override fields (email_start_tag_override etc.) on
      // many Halo tenants; without it the list is the same skinny shape as
      // localStorage.cache_tickettype. Works for non-admin agents.
      if (!types.length) {
        try {
          const response = await haloApiRequest('/api/TicketType?count=200&includedetails=true');
          const arr = extractEntityList(response, 'tickettypes');
          if (Array.isArray(arr) && arr.length) {
            types = arr.map(t => ({
              id: t.id != null ? t.id : t.RTid,
              name: t.name || t.RTDesc || '',
              rtGID: t.email_start_tag_override || t.start_tag || '',
              rtGIDEND: t.email_end_tag_override || t.end_tag || ']'
            })).filter(t => t.id != null && t.name);
          }
        } catch (_) {
          // /api/TicketType may not exist on older Halo tenants; fall through.
        }
      }

      // 3. Halo's localStorage cache. Populated on every page load and contains
      // the tenant's full ticket-type list. Email tag fields may be present
      // under shorter names than the API exposes (cache is space-optimized).
      // If a tag is missing we fall back to the 2-letter slug prefix later.
      if (!types.length) {
        try {
          const cacheRaw = localStorage.getItem('cache_tickettype');
          const cacheArr = cacheRaw ? JSON.parse(cacheRaw) : null;
          if (Array.isArray(cacheArr) && cacheArr.length) {
            types = cacheArr.map(t => ({
              id: t.id != null ? t.id : t.RTid,
              name: t.name || t.RTDesc || '',
              rtGID: t.email_start_tag_override || t.override_email_start_tag ||
                     t.overrideEmailStartTag || t.start_tag || t.starttag ||
                     t.prefix || t.rtGID || '',
              rtGIDEND: t.email_end_tag_override || t.override_email_end_tag ||
                        t.overrideEmailEndTag || t.end_tag || t.endtag ||
                        t.suffix || t.rtGIDEND || ']'
            })).filter(t => t.id != null && t.name);
          }
        } catch (_) {}
      }

      // 4. Static schema as last resort (built-in types only, no custom types).
      if (!types.length) {
        const resp = await fetch(chrome.runtime.getURL('schema/requesttypes.json'));
        types = await resp.json();
      }

      HU.ticketTypeCommands = [];
      HU.ticketTypeSearchMap = {};

      types.forEach((type) => {
        const id = type.id || type.RTID;
        const name = type.name || type.RTDesc || type.Name || '';
        const gidStart = type.rtGID || type.override_email_start_tag || type.overrideEmailStartTag || type.OverrideEmailStartTag || null;
        const gidEnd = type.rtGIDEND || ']';
        const emailTag = gidStart ? { start: gidStart, end: gidEnd } : null;
        const slug = slugify(name);
        const typeId = Number(id);
        const areaId = getTicketAreaForType(typeId, name);

        // Halo's "All Ticket Types" area lets us filter to one specific type
        // via selid=<typeId>, regardless of which Halo area the type lives in.
        // Confirmed working for Laptop Request (typeId 10 → area=12&selid=10).
        const typeListUrl = `/tickets?area=12&mainview=tickettype&viewid=1` +
                            `&selid=${encodeURIComponent(typeId)}` +
                            `&sellevel=1&selparentid=${encodeURIComponent('All Ticket Types')}`;

        HU.ticketTypeCommands.push({
          id: slug,
          title: name,
          subtitle: `Open ${name} ticket list`,
          run: () => navigateTo(typeListUrl),
          keywords: [slug],
          type: 'command',
          kind: 'Ticket Types',
          typeId
        });

        HU.ticketTypeSearchMap[slug] = {
          commandId: slug,
          kind: name,
          route: 'ticket',
          table: 'faults',
          id: 'Faultid',
          title: 'Symptom',
          sub: 'Username',
          extraCols: ['AAreaDesc'],
          searchCols: ['Symptom', 'Username'],
          optionalSearchCols: ['Symptom2', 'FDescription'],
          emailTag,
          ticketPrefix: emailTag ? null : getTicketTypePrefix(name),
          typeId,
          areaId
        };
      });

      patchTicketEntryEmailTags(types);
    } catch (e) {
      // Non-critical - extension works without ticket type data
    }
  }

  function patchTicketEntryEmailTags(types) {
    const tagByName = {};
    const idByName = {};

    types.forEach(type => {
      const name = String(type.name || type.RTDesc || type.Name || '').toLowerCase().trim();
      if (!name) return;
      const id = type.id || type.RTid || type.RTID;
      if (id) idByName[name] = Number(id);
      const gidStart = type.rtGID || type.override_email_start_tag || type.overrideEmailStartTag || type.OverrideEmailStartTag || null;
      if (gidStart) tagByName[name] = { start: gidStart, end: type.rtGIDEND || ']' };
    });

    // [typeNames, keywords, opts], where opts.applyTypeId defaults to true.
    const nameMappings = [
      [['incident'],                            ['incident', 'incidents', 'i']],
      [['incident'],                            ['ticket', 'tickets', 't'],    { applyTypeId: false, applyEmailTag: false }],
      [['problem'],                             ['prob']],
      [['change request', 'change'],            ['chg']],
      [['service request', 'request'],          ['req']],
      [['hr enquiry', 'hr', 'human resources'], ['hr']],
      [['facilities change request', 'facilities', 'facility'], ['fac']],
      [['article draft', 'draft'],              ['dft']],
      [['project'],                             ['prj']],
      [['major incident'],                      ['mi']],
    ];

    nameMappings.forEach(([typeNames, keywords, opts = {}]) => {
      const tag = typeNames.reduce((found, n) => found || tagByName[n], null);
      const typeId = typeNames.reduce((found, n) => found || idByName[n], null);
      if (!tag && !typeId) return;
      keywords.forEach(kw => {
        if (!ENTITY_SEARCH_MAP[kw]) return;
        const patch = {};
        if (tag && opts.applyEmailTag !== false) patch.emailTag = tag;
        else if (opts.applyEmailTag === false) { patch.emailTag = null; patch.ticketPrefix = null; }
        if (typeId && opts.applyTypeId !== false) patch.typeId = typeId;
        ENTITY_SEARCH_MAP[kw] = { ...ENTITY_SEARCH_MAP[kw], ...patch };
      });
    });
  }

  async function addCurrentPageShortcut() {
    const title = cleanTitle(document.title) || window.location.pathname;
    const shortcut = {
      title,
      url: window.location.href,
      createdAt: new Date().toISOString()
    };
    const existing = await loadShortcuts();
    const next = [shortcut, ...existing.filter(item => item.url !== shortcut.url)].slice(0, 50);
    await storageSet({ huShortcuts: next });
    HU.shortcuts = next;
    toast('Shortcut added');
  }

  function getCachedRecent() {
    return HU.recent || [];
  }

  function getTicketTypePrefix(name) {
    const normalized = String(name || '').trim();
    const known = {
      incident: 'INC',
      problem: 'PRB',
      'change request': 'CHG',
      'service request': 'REQ',
      project: 'PRJ',
      'major incident': 'MI',
      'article draft': 'DFT'
    };
    const exact = known[normalized.toLowerCase()];
    if (exact) return exact;

    const words = normalized.match(/[A-Za-z0-9]+/g) || [];
    if (!words.length) return 'TKT';
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    return words
      .filter(word => !/^(and|or|for|of|the|a|an)$/i.test(word))
      .slice(0, 3)
      .map(word => word[0])
      .join('')
      .toUpperCase() || 'TKT';
  }

  async function loadRecent() {
    const data = await storageGet(['huRecentRecords']);
    HU.recent = data.huRecentRecords || [];
    return HU.recent;
  }

  async function trackRecentRecord() {
    const record = detectRecordFromUrl();
    if (!record || record.url === HU.lastTrackedUrl) return;
    HU.lastTrackedUrl = record.url;

    const recent = await loadRecent();
    const next = [record, ...recent.filter(item => item.url !== record.url)].slice(0, 20);
    HU.recent = next;
    await storageSet({ huRecentRecords: next });
  }

  function detectRecordFromUrl() {
    const url = new URL(window.location.href);
    const text = url.href.toLowerCase();
    const id = url.searchParams.get('agentid') ||
      url.searchParams.get('userid') ||
      url.searchParams.get('clientid') ||
      url.searchParams.get('assetid') ||
      url.searchParams.get('id') ||
      url.searchParams.get('faultid') ||
      url.searchParams.get('selid') ||
      '';
    const title = cleanTitle(document.title) || `${url.pathname}${id ? ` ${id}` : ''}`;
    let type = '';

    if (text.includes('/ticket') || text.includes('/fault')) type = 'ticket';
    else if (text.includes('/customer') || text.includes('/area') || text.includes('/client')) type = 'customer';
    else if (text.includes('/agent') || text.includes('/uname')) type = 'agent';
    else if (text.includes('/user')) type = 'user';
    else if (text.includes('/asset') || text.includes('/device')) type = 'asset';
    else if (text.includes('/report')) type = 'report';
    else if (text.includes('/config')) type = 'config';

    if (!type) return null;
    return {
      type,
      id,
      title,
      url: window.location.href,
      visitedAt: new Date().toISOString()
    };
  }

  // Maps raw SQL column names (Halo stores audit `value` as the column
  // identifier) to friendly labels an agent would recognise. Anything not
  // in this map falls through to the raw value with first-letter cleanup.
  const AUDIT_FIELD_LABELS = {
    agent_id:       'Assignee',
    agent:          'Assignee',
    status_id:      'Status',
    status:         'Status',
    priority_id:    'Priority',
    priority:       'Priority',
    tickettype_id:  'Ticket type',
    tickettype:     'Ticket type',
    team_id:        'Team',
    team:           'Team',
    client_id:      'Customer',
    customer:       'Customer',
    site_id:        'Site',
    site:           'Site',
    user_id:        'End user',
    user:           'End user',
    workflow_id:    'Workflow',
    workflow_step:  'Workflow step',
    category_1:     'Category',
    category_2:     'Subcategory',
    category_3:     'Sub-subcategory',
    category_4:     'Category L4',
    dateassigned:   'Assigned date',
    fixbydate:      'Fix-by date',
    respondbydate:  'Respond-by date',
    dateoccurred:   'Opened',
    dateclosed:     'Closed',
    datecleared:    'Cleared',
    summary:        'Summary',
    details:        'Details',
    sla_id:         'SLA',
    sla:            'SLA',
    flagged:        'Flagged',
    impact_id:      'Impact',
    urgency_id:     'Urgency',
    review_date:    'Review date'
  };

  // Fields whose `from`/`to` values are IDs we can resolve to names via
  // Halo's localStorage caches. The cache lookup is best-effort: when the
  // cache doesn't contain the id (or is empty), we fall through to the
  // raw value so the diff still reads.
  const AUDIT_ID_CACHES = {
    agent_id:      'cache_agent',
    status_id:     'cache_status',
    priority_id:   'cache_priority',
    tickettype_id: 'cache_tickettype',
    team_id:       'cache_team'
  };

  // Lookup-backed audit resolvers. Each entry describes how to fetch a
  // Map<id, name> for one or more audit field names that store IDs but
  // don't have a Halo localStorage cache to resolve them from. Loaded
  // once per session, cached in HU.auditLookupMaps keyed by `kind`.
  //
  // Halo's `/api/Lookup` returns array of { id, value, ... } where `value`
  // is the friendly name. The lookupid varies by tenant (impact/urgency
  // both surface as numbered lookup tables), so we surface whatever Halo
  // returns and fall through to the raw id when there's no match.
  const AUDIT_API_RESOLVERS = {
    workflow_id: {
      kind: 'workflow',
      url: '/api/Workflow?includeinactive=true',
      arrayKeys: ['workflows', 'flowheaders'],
      nameOf: w => w.name || w.description
    },
    // Priority falls back to the API when cache_priority isn't populated
    // (happens on direct-URL ticket loads before Halo's React app has
    // warmed up its localStorage caches).
    priority_id: {
      kind: 'priority',
      url: '/api/Priority',
      arrayKeys: ['priorities', 'policies', 'items'],
      nameOf: w => w.name || w.description
    },
    // Halo's impact/urgency live in /api/Lookup but the lookupid varies
    // per tenant. We try the two most-common defaults; the first one
    // that returns any rows wins.
    impact_id: {
      kind: 'impact',
      // Halo's standard impact lookup is typically lookupid=10 in the
      // out-of-the-box config; some tenants use 110 or other ids.
      url: '/api/Lookup?lookupid=10',
      arrayKeys: ['lookups', 'partslookups', 'items'],
      nameOf: w => w.name || w.value || w.text || w.description
    },
    urgency_id: {
      kind: 'urgency',
      url: '/api/Lookup?lookupid=11',
      arrayKeys: ['lookups', 'partslookups', 'items'],
      nameOf: w => w.name || w.value || w.text || w.description
    }
  };

  function loadAuditApiLookup(fieldKey) {
    const cfg = AUDIT_API_RESOLVERS[fieldKey];
    if (!cfg) return Promise.resolve(null);
    if (!HU.auditLookupMaps) HU.auditLookupMaps = {};
    if (!HU.auditLookupPromises) HU.auditLookupPromises = {};
    if (HU.auditLookupMaps[cfg.kind] instanceof Map) return Promise.resolve(HU.auditLookupMaps[cfg.kind]);
    if (HU.auditLookupPromises[cfg.kind]) return HU.auditLookupPromises[cfg.kind];
    HU.auditLookupPromises[cfg.kind] = haloApiRequest(cfg.url).then(resp => {
      let arr = Array.isArray(resp) ? resp : null;
      if (!arr) {
        for (const k of cfg.arrayKeys) {
          if (Array.isArray(resp?.[k])) { arr = resp[k]; break; }
        }
      }
      if (!arr) arr = [];
      const map = new Map();
      arr.forEach(item => {
        if (item == null) return;
        // /api/Priority exposes a GUID at `id` and the numeric audit-id at `priorityid` (no underscore). Halo's other lookup endpoints follow the same no-underscore convention.
        const candidates = [
          item.priorityid, item.statusid, item.workflowid, item.lookupid, item.tid, item.code,
          item.priority_id, item.lookup_id, item.workflow_id
        ];
        let rawId = null;
        for (const c of candidates) {
          if (c != null && Number.isFinite(Number(c))) { rawId = c; break; }
        }
        if (rawId == null && item.id != null && Number.isFinite(Number(item.id))) {
          rawId = item.id;
        }
        const id = rawId != null ? Number(rawId) : null;
        if (id == null || !Number.isFinite(id)) return;
        const name = cfg.nameOf(item)
                  || item.name || item.value || item.text || item.description;
        map.set(id, String(name || (cfg.kind.charAt(0).toUpperCase() + cfg.kind.slice(1) + ' #' + id)));
      });
      HU.auditLookupMaps[cfg.kind] = map;
      return map;
    }).catch(() => {
      const empty = new Map();
      HU.auditLookupMaps[cfg.kind] = empty;
      return empty;
    });
    return HU.auditLookupPromises[cfg.kind];
  }

  function prettyAuditField(raw) {
    if (!raw) return '';
    const key = String(raw).trim().toLowerCase();
    if (AUDIT_FIELD_LABELS[key]) return AUDIT_FIELD_LABELS[key];
    // Generic fallback: snake_case → "Snake case"
    return key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  }

  // Halo dumps multi-field summaries into the `to` column for creation
  // rows: "Action Date/Time: ... - Action Note: ... Subject: ... Type:
  // ... Start: ... End: ...". Parse those into structured key/value
  // pairs so we can render them as a clean list instead of one wall of
  // text. Returns null when the input doesn't look structured.
  //
  // `minPairs` lets the caller relax the threshold: a Ticket-Created
  // row may only have "Symptom: wefe" (single pair) yet still benefits
  // from the KV layout, while a regular field-change line shouldn't
  // accidentally get re-formatted.
  function parseStructuredAuditValue(text, minPairs) {
    if (!text || typeof text !== 'string') return null;
    const threshold = Number.isFinite(minPairs) ? minPairs : 2;
    // A "key:" is a Title-Cased word (or multi-word phrase) followed by a
    // colon. Allow `/` (Action Date/Time), spaces, and parentheses.
    const re = /([A-Z][A-Za-z][A-Za-z ()\/]{0,40}?):\s?/g;
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ start: m.index, keyEnd: m.index + m[0].length, key: m[1].trim() });
    }
    if (hits.length < threshold) return null;
    const pairs = [];
    for (let i = 0; i < hits.length; i++) {
      const next = hits[i + 1];
      const valueStart = hits[i].keyEnd;
      const valueEnd = next ? next.start : text.length;
      let value = text.slice(valueStart, valueEnd).trim();
      // Strip trailing " - " separator Halo inserts between segments.
      value = value.replace(/\s*-\s*$/, '').trim();
      if (value) pairs.push({ key: hits[i].key, value });
    }
    return pairs.length >= threshold ? pairs : null;
  }

  function resolveAuditValue(field, raw, apiMaps) {
    if (raw == null || raw === '') return '';
    const key = String(field).trim().toLowerCase();
    const id = Number(raw);

    // Try Halo localStorage caches first (fast, no fetch).
    const cacheKey = AUDIT_ID_CACHES[key];
    if (cacheKey && Number.isFinite(id) && id > 0) {
      const name = getCachedName(cacheKey, id);
      if (name) return name;
    }

    // Then API-backed lookup maps the caller pre-fetched.
    if (apiMaps && Number.isFinite(id) && id > 0) {
      const apiCfg = AUDIT_API_RESOLVERS[key];
      if (apiCfg && apiMaps[apiCfg.kind] instanceof Map) {
        const name = apiMaps[apiCfg.kind].get(id);
        if (name) return name;
      }
    }

    return String(raw);
  }

  // Map a row from the SQL AUDIT table into the same shape the rest of the
  // audit renderer expects (originally written against the /api/tickets
  // audit_log array). Field correspondence verified against a live tenant.
  function normaliseSqlAuditRow(r) {
    return {
      id: Number(r.AID || 0),
      ticket_id: Number(r.AFaultid || 0),
      agent_id: Number(r.AUnum || 0),
      date: r.ADate,
      value: r.AValue || '',
      to: r.ATo || '',
      from: r.AFrom || '',
      table_name: r.atablename || '',
      actoutcome: r.aactoutcome || '',
      user_id: Number(r.auserid || 0),
      isintegrator: r.aisintegrator === true || r.aisintegrator === 'true' || r.aisintegrator === 'True' || r.aisintegrator === '1',
      // username is empty; the renderer falls back to cache_agent lookup by agent_id.
      username: '',
      __source: 'audit'
    };
  }

  // Map an Actions row (notes, emails, time logs, status changes via outcomes)
  // into the same shape, so the audit drawer can show a unified activity log.
  // Halo's AUDIT table only captures field-level changes — Actions captures
  // the conversational layer (notes, emails) which other agents most often
  // make. Both belong in the audit timeline.
  function normaliseActionRow(r) {
    const noteSnippet = (r.note || r.emailbody || '').toString().slice(0, 300);
    return {
      id: Number(r.actionnumber || 0),
      ticket_id: Number(r.Faultid || 0),
      agent_id: Number(r.ActionUserdef || 0),
      date: r.Whe_,
      // Put the outcome (e.g. "Note Added", "Public Note", "Re-Assign") as the
      // field-label / value, and the note body as the "to" side so it renders.
      value: r.Actoutcome || 'Action',
      to: noteSnippet,
      from: '',
      table_name: 'actions',
      actoutcome: r.Actoutcome || '',
      user_id: 0,
      isintegrator: false,
      // The "who" column already carries a friendly display name, which the
      // renderer prefers over agent_id when present.
      username: r.who || '',
      __source: 'action'
    };
  }

  // Audit log — on-demand fetch. Two paths:
  //   1. Admin path (HU.reportApiOk): query the AUDIT SQL table via /api/Report.
  //      Returns the FULL multi-agent history. The /api/tickets endpoint filters
  //      audit rows to current-user + system only; SQL bypasses that filter.
  //   2. API path (fallback): /api/tickets/{id}?include_auditing=true. Current-user
  //      and system rows only, with a UI note explaining the limitation.
  async function openAuditLogDrawer(ticketId) {
    injectStyles();
    closeDrawer('hu-audit-drawer');

    const drawer = createDrawer('hu-audit-drawer', `Audit log · #${ticketId}`);
    const body = drawer.querySelector('.hu-drawer-body');
    body.innerHTML = '<div class="hu-row"><span class="hu-row-title">Loading audit log…</span></div>';
    openDrawer(drawer);

    let rows = [];
    let usedSqlPath = false;

    // Try the SQL path unless we already know /api/Report is blocked.
    // The probe runs at boot+500ms, so a freshly-loaded page may still have
    // reportApiOk === null; in that case we try anyway and let the try/catch
    // sort it out, rather than falling through to the filtered API.
    //
    // The activity log merges two sources:
    //   AUDIT   — field-level changes (status, priority, assignee, CFs, etc.)
    //   Actions — conversational layer (notes, emails, time logs, re-assigns)
    // Halo's per-user filter applies to /api/tickets but NOT to /api/Report,
    // so the SQL path gives the full multi-agent activity history.
    if (HU.reportApiOk !== false) {
      try {
        const tid = Number(ticketId);
        // TOP N is required: Halo wraps user SQL in a subquery, and SQL Server
        // disallows ORDER BY in subqueries unless paired with TOP/OFFSET/FOR XML.
        // 500 is generous for any single ticket's history without risk of cut-off.
        const auditSql = `SELECT TOP 500 AID, AFaultid, AUnum, ADate, AValue, ATo, AFrom, atablename, aactoutcome, auserid, aisintegrator FROM AUDIT WHERE AFaultid = ${tid} ORDER BY ADate DESC`;
        const actionSql = `SELECT TOP 500 actionnumber, Faultid, Whe_, Actoutcome, who, note, emailbody, ActionUserdef FROM Actions WHERE Faultid = ${tid} AND ISNULL(ActionHide, 0) = 0 ORDER BY Whe_ DESC`;
        const [auditData, actionData] = await Promise.all([
          runHaloReport(auditSql, 'HaloPlus Audit Log').catch(() => null),
          runHaloReport(actionSql, 'HaloPlus Actions Log').catch(() => null)
        ]);
        const auditRows = (auditData?.report?.rows || []).map(normaliseSqlAuditRow);
        const actionRows = (actionData?.report?.rows || []).map(normaliseActionRow);
        if (auditRows.length || actionRows.length) {
          rows = [...auditRows, ...actionRows].sort((a, b) => {
            const da = a.date ? Date.parse(String(a.date).endsWith('Z') ? a.date : a.date + 'Z') : 0;
            const db = b.date ? Date.parse(String(b.date).endsWith('Z') ? b.date : b.date + 'Z') : 0;
            return db - da;
          });
          usedSqlPath = true;
        }
      } catch (e) {
        // SQL path failed entirely — could be permission, network, or syntax. Fall through to API.
      }
    }

    // API path — used for non-admins and as a fallback if the SQL path returns no rows.
    if (!rows.length) {
      let ticket;
      try {
        ticket = await haloApiRequest(
          `/api/tickets/${ticketId}?include_auditing=true&nocache=true`
        );
      } catch (e) {
        body.innerHTML = `<div class="hu-row"><span class="hu-row-title">Couldn't load audit log</span><span class="hu-row-sub">${escapeHtml(String(e?.message || e))}</span></div>`;
        return;
      }

      // Halo returns four parallel audit arrays on the ticket payload:
      //   audit_log    — general entries (status changes, field edits, etc.)
      //   auditstatus  — status-only changes
      //   auditunum    — agent / assignee changes
      //   auditdate    — date-field changes
      const candidateKeys = ['audit_log', 'auditstatus', 'auditunum', 'auditdate',
                             'auditing', 'audit', 'audits', 'audit_trail', 'audit_history'];
      candidateKeys.forEach(k => {
        const v = ticket && ticket[k];
        if (Array.isArray(v)) v.forEach(r => rows.push(r));
      });
    }

    // Stash the path used so the header renderer can show a label.
    HU.auditUsedSqlPath = usedSqlPath;

    // Pre-fetch API-backed lookups for any field in the rows that we
    // resolve via /api (workflow, impact, urgency). Halo's localStorage
    // caches handle status/priority/agent/etc. synchronously.
    const usedApiFields = new Set();
    rows.forEach(r => {
      const k = String(r.value || '').trim().toLowerCase();
      if (AUDIT_API_RESOLVERS[k]) usedApiFields.add(k);
    });
    const apiMapEntries = await Promise.all(
      [...usedApiFields].map(k =>
        loadAuditApiLookup(k).then(map => [AUDIT_API_RESOLVERS[k].kind, map])
      )
    );
    const apiMaps = Object.fromEntries(apiMapEntries);
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = '<div class="hu-row"><span class="hu-row-title">No audit entries</span><span class="hu-row-sub">Halo did not return an audit trail for this ticket. The ticket may be too new, or your role may not have audit access.</span></div>';
      return;
    }

    // Sort newest first by full timestamp.
    const sorted = rows.slice().sort((a, b) => {
      const da = parseHaloDate(a.date || '').getTime() || 0;
      const db = parseHaloDate(b.date || '').getTime() || 0;
      return db - da;
    });

    // Group by date header (DD/MM/YYYY). All entries from the same day
    // cluster under one heading; within a group they stay newest-first.
    const formatDateHeading = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      const today = new Date();
      const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const tStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const dayDiff = Math.round((tStart - dStart) / 86400000);
      const dmy = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
      if (dayDiff === 0) return 'Today · ' + dmy;
      if (dayDiff === 1) return 'Yesterday · ' + dmy;
      return dmy;
    };
    const formatTime = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}.${pad(d.getMinutes())}`;
    };

    const groups = [];           // [{ heading, rows: [] }]
    const byHeading = new Map();
    sorted.forEach(r => {
      const d = parseHaloDate(r.date || '');
      if (!d || isNaN(d.getTime())) return;
      const heading = formatDateHeading(d);
      if (!byHeading.has(heading)) {
        const g = { heading, rows: [] };
        byHeading.set(heading, g);
        groups.push(g);
      }
      byHeading.get(heading).rows.push({ row: r, when: d });
    });

    body.innerHTML = '';

    // Header + filter input. The filter matches against field labels,
    // raw values, the resolved from/to text, and the username — so the
    // user can search by anything they see on screen. Below the text
    // input we render one chip per distinct field that's been changed,
    // so the user can drill in on a specific field without typing.
    const header = document.createElement('div');
    header.className = 'hu-audit-header';
    const visibilityNote = HU.auditUsedSqlPath
      ? ''
      : '<div class="hu-row hu-audit-vis-note" style="border-bottom:0;color:#7a6a3c;background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;padding:6px 10px;margin-bottom:6px"><span class="hu-row-sub" style="color:#7a6a3c">Showing your changes + system changes. Halo\'s API filters the audit log to the calling agent; the full multi-agent history is only available to roles with /api/Report access.</span></div>';
    header.innerHTML = `
      ${visibilityNote}
      <div class="hu-row" style="border-bottom:0">
        <span class="hu-row-title" id="hu-audit-headline">Loading audit summary…</span>
        <span class="hu-row-sub">Newest first. Filter below to drill in.</span>
      </div>
      <div class="hu-audit-filter-row">
        <input type="text" class="hu-audit-filter" id="hu-audit-filter" placeholder="Filter by field, value, or who…" autocomplete="off" />
        <span class="hu-audit-filter-count" id="hu-audit-filter-count"></span>
      </div>
      <div class="hu-audit-field-chips" id="hu-audit-field-chips"></div>
      <div class="hu-audit-field-chips" id="hu-audit-agent-chips" style="margin-top:6px"></div>
    `;
    body.appendChild(header);

    // Pre-resolve the friendly + raw text per row, then fold rows that
    // came from the same "save transaction" — same user, same table,
    // same timestamp (or same audit_num/auditnum if Halo exposes one) —
    // into one entry with multiple field changes.
    //
    // Halo doesn't ship a stable audit-batch id in the v1 schema we
    // see (id, ticket_id, agent_id, date, value, to, from, table_name,
    // id1, actoutcome, user_id, username, isintegrator), but multiple
    // fields edited in one save share the exact same `date` timestamp
    // because they're written in the same transaction. We bucket by
    // (date + username + table_name) which is precise enough in practice.
    const txKey = (r) => {
      const explicit = r.auditnum || r.audit_num || r.audit_id || r.batch_id;
      if (explicit) return 'tx:' + explicit;
      const ms = parseHaloDate(r.date || '').getTime() || 0;
      // Round to the second so two writes a few ms apart still group.
      const sec = Math.floor(ms / 1000);
      const who = String(r.username || r.agent_id || '');
      const tbl = String(r.table_name || '');
      return `t:${sec}|w:${who}|b:${tbl}`;
    };

    // Convert one Halo audit row into a normalised "change" record.
    // Halo's `value` for creation events is usually "<Entity> ID <n> Created"
    // (e.g. "Action ID 7 Created", "Ticket ID 3174 Created"). When the row
    // also carries an `actoutcome` we use that as the friendly label —
    // "Appointment Created" reads better than "Action ID 7 Created" — and
    // drop the duplicate outcome chip below. Same for plain "<Entity>
    // Created" with no outcome (becomes "Action created", "Ticket created").
    const CREATED_RE = /^(\w+(?:\s+\w+)*?)\s+id\s+\d+\s+created$/i;
    const toChange = (r) => {
      const rawField = String(r.value || '').trim();
      const outcome = String(r.actoutcome || '').trim();
      let fieldLabel;
      let outcomeUsedAsLabel = false;
      const isCreation = CREATED_RE.test(rawField);
      if (isCreation) {
        const createdMatch = rawField.match(CREATED_RE);
        if (outcome) {
          // Outcome already typically reads "Appointment Created" — use as-is
          // but normalise the case of the second word.
          fieldLabel = outcome.replace(/\bCreated\b/i, 'created');
          outcomeUsedAsLabel = true;
        } else {
          const entity = createdMatch[1];
          fieldLabel = entity.charAt(0).toUpperCase() + entity.slice(1).toLowerCase() + ' created';
        }
      } else {
        fieldLabel = prettyAuditField(rawField);
      }
      const rawOld = r.from != null ? String(r.from) : '';
      const rawNew = r.to   != null ? String(r.to)   : '';
      const oldV = resolveAuditValue(rawField, rawOld, apiMaps);
      const newV = resolveAuditValue(rawField, rawNew, apiMaps);
      return { fieldLabel, rawField, oldV, newV, rawOld, rawNew, outcome, outcomeUsedAsLabel, isCreation };
    };

    const enriched = [];
    const txByKey = new Map();
    groups.forEach(g => {
      g.rows.forEach(({ row: r, when }) => {
        const who = String(r.username || '').trim()
                  || (r.agent_id ? (getCachedName('cache_agent', r.agent_id) || ('Agent #' + r.agent_id)) : 'System');
        const tableQual = String(r.table_name || '').trim();
        const key = txKey(r);
        let tx = txByKey.get(key);
        if (!tx) {
          tx = {
            groupHeading: g.heading, when, who, tableQual,
            changes: [],
            searchBlob: ''
          };
          txByKey.set(key, tx);
          enriched.push(tx);
        }
        const change = toChange(r);
        tx.changes.push(change);
        tx.searchBlob += ` ${change.fieldLabel} ${change.rawField} ${change.oldV} ${change.newV} ${change.rawOld} ${change.rawNew} ${change.outcome} ${tableQual} ${who}`.toLowerCase();
      });
    });

    // Fill in the headline now that we know the transaction count.
    const headline = document.getElementById('hu-audit-headline');
    if (headline) {
      const txCount = enriched.length;
      const changeCount = enriched.reduce((n, tx) => n + tx.changes.length, 0);
      const dayCount = groups.length;
      headline.textContent = `${txCount} ${txCount === 1 ? 'save' : 'saves'}`
        + ` · ${changeCount} field change${changeCount === 1 ? '' : 's'}`
        + ` across ${dayCount} day${dayCount === 1 ? '' : 's'}`;
    }

    // Build the inferred "initial state" snapshot for the ticket itself.
    // Halo only writes audit rows for *changes*, not for the initial save —
    // so a field that was set at creation and never changed has no row.
    // But for fields that DID change later, the earliest row's `from` is
    // the value the ticket had at creation. Collect those and we can
    // attach them as a "Set at creation" extra block to the Ticket
    // Created transaction.
    //
    // We sort changes oldest-first per field; only consider rows on the
    // ticket itself (table_name = faults/fault). Skip change rows whose
    // raw column is a creation-marker (`X ID N Created`) or whose `from`
    // is empty.
    const fieldFirstFrom = new Map(); // fieldLabel → first `oldV` value
    const ticketTableRows = [];
    enriched.forEach(tx => {
      const isTicketTable = !tx.tableQual || /^(faults?|fault)$/i.test(tx.tableQual);
      if (!isTicketTable) return;
      tx.changes.forEach(c => {
        if (c.isCreation) return;
        if (!c.fieldLabel || !c.oldV) return;
        ticketTableRows.push({ when: tx.when, label: c.fieldLabel, oldV: c.oldV });
      });
    });
    ticketTableRows.sort((a, b) => a.when - b.when);
    ticketTableRows.forEach(r => {
      if (!fieldFirstFrom.has(r.label)) fieldFirstFrom.set(r.label, r.oldV);
    });
    // Surface as a sorted array of {key,value} for rendering.
    const inferredInitialFields = [...fieldFirstFrom.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key));

    // Fold the inferred fields onto the Ticket Created transaction so
    // they participate in BOTH the text filter and the field-chip filter
    // (e.g. typing "priority" or clicking the Priority chip should also
    // surface the creation row when priority was set at creation).
    if (inferredInitialFields.length) {
      const ticketCreationTx = enriched.find(tx =>
        tx.changes.some(c => c.isCreation && /^ticket\b/i.test(c.rawField.match(CREATED_RE)?.[1] || ''))
      );
      if (ticketCreationTx) {
        ticketCreationTx.virtualFields = inferredInitialFields.map(f => f.key);
        inferredInitialFields.forEach(f => {
          ticketCreationTx.searchBlob += ` ${f.key} ${f.value}`.toLowerCase();
        });
      }
    }

    // Collect every distinct field touched by any change, with counts so
    // we can sort by frequency. Skip empty/system labels so the chip row
    // stays clean. Virtual fields (inferred initial state on the Ticket
    // Created tx) count too — clicking "Priority" should surface the
    // creation row when priority was set at creation.
    //
    // Suppress the "Ticket created" chip itself when its tx has virtual
    // fields, since the inferred subfield chips (Priority, Status, …)
    // already let the user drill in. Other creation outcomes like
    // "Appointment created" stay because they don't have virtual fields.
    const fieldCounts = new Map();
    enriched.forEach(tx => {
      const hasVirtual = !!(tx.virtualFields && tx.virtualFields.length);
      tx.changes.forEach(c => {
        const label = (c.fieldLabel || '').trim();
        if (!label) return;
        if (c.isCreation && hasVirtual) return;
        fieldCounts.set(label, (fieldCounts.get(label) || 0) + 1);
      });
      (tx.virtualFields || []).forEach(label => {
        const k = String(label || '').trim();
        if (!k) return;
        fieldCounts.set(k, (fieldCounts.get(k) || 0) + 1);
      });
    });
    const fieldList = [...fieldCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const selectedFields = new Set();
    const chipsHost = document.getElementById('hu-audit-field-chips');
    if (chipsHost && fieldList.length) {
      const allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'hu-audit-chip is-active';
      allChip.dataset.field = '';
      allChip.textContent = 'All fields';
      chipsHost.appendChild(allChip);

      fieldList.forEach(([label, count]) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'hu-audit-chip';
        chip.dataset.field = label;
        chip.innerHTML = `${escapeHtml(label)} <span class="hu-audit-chip-count">${count}</span>`;
        chipsHost.appendChild(chip);
      });

      chipsHost.addEventListener('click', (e) => {
        const chip = e.target.closest('.hu-audit-chip');
        if (!chip) return;
        const field = chip.dataset.field;
        if (field === '') {
          selectedFields.clear();
        } else if (selectedFields.has(field)) {
          selectedFields.delete(field);
        } else {
          selectedFields.add(field);
        }
        chipsHost.querySelectorAll('.hu-audit-chip').forEach(el => {
          const isAll = el.dataset.field === '';
          const active = isAll ? selectedFields.size === 0 : selectedFields.has(el.dataset.field);
          el.classList.toggle('is-active', active);
        });
        render(document.getElementById('hu-audit-filter')?.value || '');
      });
    }

    // Agent chips — same UX as field chips, lets the user filter to one or
    // more people. tx.who is already the resolved display name (username
    // string or cache_agent lookup or "System"), so the chip labels match
    // exactly what the user sees in the timeline.
    const agentCounts = new Map();
    enriched.forEach(tx => {
      const who = String(tx.who || '').trim() || 'Unknown';
      agentCounts.set(who, (agentCounts.get(who) || 0) + 1);
    });
    const agentList = [...agentCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const selectedAgents = new Set();
    const agentHost = document.getElementById('hu-audit-agent-chips');
    if (agentHost && agentList.length > 1) {
      const allChip = document.createElement('button');
      allChip.type = 'button';
      allChip.className = 'hu-audit-chip is-active';
      allChip.dataset.agent = '';
      allChip.textContent = 'All people';
      agentHost.appendChild(allChip);

      agentList.forEach(([who, count]) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'hu-audit-chip';
        chip.dataset.agent = who;
        chip.innerHTML = `${escapeHtml(who)} <span class="hu-audit-chip-count">${count}</span>`;
        agentHost.appendChild(chip);
      });

      agentHost.addEventListener('click', (e) => {
        const chip = e.target.closest('.hu-audit-chip');
        if (!chip) return;
        const who = chip.dataset.agent;
        if (who === '') {
          selectedAgents.clear();
        } else if (selectedAgents.has(who)) {
          selectedAgents.delete(who);
        } else {
          selectedAgents.add(who);
        }
        agentHost.querySelectorAll('.hu-audit-chip').forEach(el => {
          const isAll = el.dataset.agent === '';
          const active = isAll ? selectedAgents.size === 0 : selectedAgents.has(el.dataset.agent);
          el.classList.toggle('is-active', active);
        });
        render(document.getElementById('hu-audit-filter')?.value || '');
      });
    }

    const listsHost = document.createElement('div');
    body.appendChild(listsHost);

    // Render with the active filter applied. Always rebuild the entire
    // grouped list so empty groups can disappear cleanly when filtered.
    // Filters compose: text filter AND (no fields selected OR transaction
    // touches at least one selected field).
    // Predicate helpers — defined here so we can apply subsets of the filters
    // when computing chip counts (e.g. field chip counts should respect text+agent
    // filters but NOT the field filter itself, otherwise selecting one field
    // would zero every other field chip).
    function matchesText(tx, lower) { return !lower || tx.searchBlob.includes(lower); }
    function matchesAgents(tx, agentSet) {
      if (!agentSet || !agentSet.size) return true;
      const who = String(tx.who || '').trim() || 'Unknown';
      return agentSet.has(who);
    }
    function matchesFields(tx, fieldSet) {
      if (!fieldSet || !fieldSet.size) return true;
      if (tx.changes.some(c => fieldSet.has((c.fieldLabel || '').trim()))) return true;
      return (tx.virtualFields || []).some(f => fieldSet.has((f || '').trim()));
    }

    function render(filterText) {
      const lower = (filterText || '').trim().toLowerCase();
      listsHost.innerHTML = '';
      const hasFieldFilter = selectedFields.size > 0;
      const hasAgentFilter = selectedAgents.size > 0;

      const filtered = enriched.filter(tx =>
        matchesText(tx, lower) && matchesAgents(tx, selectedAgents) && matchesFields(tx, selectedFields)
      );

      // Chip count recomputes — each chip set excludes its own filter from
      // the upstream filter chain, so selecting one field doesn't hide the
      // other field chips, and selecting one agent doesn't hide the other
      // agents. Same pattern as e-commerce faceted search.
      const forFieldCounts = enriched.filter(tx =>
        matchesText(tx, lower) && matchesAgents(tx, selectedAgents)
      );
      const forAgentCounts = enriched.filter(tx =>
        matchesText(tx, lower) && matchesFields(tx, selectedFields)
      );

      const liveFieldCounts = new Map();
      forFieldCounts.forEach(tx => {
        const hasVirtual = !!(tx.virtualFields && tx.virtualFields.length);
        tx.changes.forEach(c => {
          const label = (c.fieldLabel || '').trim();
          if (!label) return;
          if (c.isCreation && hasVirtual) return;
          liveFieldCounts.set(label, (liveFieldCounts.get(label) || 0) + 1);
        });
        (tx.virtualFields || []).forEach(label => {
          const k = String(label || '').trim();
          if (k) liveFieldCounts.set(k, (liveFieldCounts.get(k) || 0) + 1);
        });
      });

      const liveAgentCounts = new Map();
      forAgentCounts.forEach(tx => {
        const who = String(tx.who || '').trim() || 'Unknown';
        liveAgentCounts.set(who, (liveAgentCounts.get(who) || 0) + 1);
      });

      // Apply to existing chips: update count, hide chips with zero matches
      // unless they're currently selected (so the user can always deselect).
      chipsHost?.querySelectorAll('.hu-audit-chip').forEach(el => {
        const field = el.dataset.field;
        if (field == null || field === '') return;
        const count = liveFieldCounts.get(field) || 0;
        const sel = selectedFields.has(field);
        el.classList.toggle('is-empty', count === 0 && !sel);
        const cEl = el.querySelector('.hu-audit-chip-count');
        if (cEl) cEl.textContent = count;
      });

      agentHost?.querySelectorAll('.hu-audit-chip').forEach(el => {
        const who = el.dataset.agent;
        if (who == null || who === '') return;
        const count = liveAgentCounts.get(who) || 0;
        const sel = selectedAgents.has(who);
        el.classList.toggle('is-empty', count === 0 && !sel);
        const cEl = el.querySelector('.hu-audit-chip-count');
        if (cEl) cEl.textContent = count;
      });

      const countEl = document.getElementById('hu-audit-filter-count');
      if (countEl) {
        const showCount = lower || hasFieldFilter || hasAgentFilter;
        countEl.textContent = showCount
          ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
          : '';
      }

      if (!filtered.length) {
        listsHost.innerHTML = '<div class="hu-row"><span class="hu-row-title">No entries match</span><span class="hu-row-sub">Clear the filter to see everything.</span></div>';
        return;
      }

      // Regroup the filtered set by date heading, preserving original order.
      const byHeading = new Map();
      const orderedHeadings = [];
      filtered.forEach(e => {
        if (!byHeading.has(e.groupHeading)) {
          byHeading.set(e.groupHeading, []);
          orderedHeadings.push(e.groupHeading);
        }
        byHeading.get(e.groupHeading).push(e);
      });

      orderedHeadings.forEach(heading => {
        const entries = byHeading.get(heading);
        const groupEl = document.createElement('div');
        groupEl.className = 'hu-audit-group';
        groupEl.innerHTML = `<div class="hu-audit-group-h">${escapeHtml(heading)}</div>`;
        const list = document.createElement('div');
        list.className = 'hu-audit-list';

        entries.forEach(tx => {
          const whenStr = formatTime(tx.when);

          // Find a "Ticket created" change in this transaction so we can
          // optionally tack the inferred-initial-state block onto its KV
          // list (only one such marker per ticket lifecycle).
          const ticketCreationChange = tx.changes.find(c =>
            c.isCreation && CREATED_RE.test(c.rawField) &&
            /^ticket\b/i.test(c.rawField.match(CREATED_RE)?.[1] || '')
          );

          // Per-change visibility under the active filters. The outer tx
          // filter has already kept this tx because *something* matches;
          // we now narrow to just the matching changes so sibling fields
          // don't leak through when the user filtered by chip / text.
          const txHasVirtual = !!(tx.virtualFields && tx.virtualFields.length);
          const changeVisible = (c) => {
            if (c === ticketCreationChange && txHasVirtual) {
              // The Ticket Created change is kept whenever any of its
              // inferred virtual fields pass the filter — its KV list is
              // filtered separately below.
              const matchingVirtualField = tx.virtualFields.find(vf => {
                const labelOk = !hasFieldFilter || selectedFields.has(vf);
                if (!labelOk) return false;
                if (!lower) return true;
                const inferredKv = (inferredInitialFields.find(f => f.key === vf) || {}).value || '';
                return `${vf} ${inferredKv}`.toLowerCase().includes(lower);
              });
              return !!matchingVirtualField;
            }
            const labelOk = !hasFieldFilter || selectedFields.has((c.fieldLabel || '').trim());
            if (!labelOk) return false;
            if (!lower) return true;
            const blob = `${c.fieldLabel} ${c.rawField} ${c.oldV} ${c.newV} ${c.rawOld} ${c.rawNew} ${c.outcome}`.toLowerCase();
            return blob.includes(lower);
          };
          const visibleChanges = tx.changes.filter(changeVisible);
          // Belt-and-braces: if nothing visible (shouldn't happen given
          // the outer filter), skip the tx entirely.
          if (!visibleChanges.length) return;

          // Build one diff line per field change in the transaction.
          const changeLinesHtml = visibleChanges.map(c => {
            // Detect Halo's multi-field "Key: value - Key: value" dumps
            // (creation rows for actions, appointments, etc.) and render
            // them as a structured key/value list instead of inline diff.
            // Use a relaxed threshold for known creation rows so a
            // single "Symptom: wefe" still renders cleanly.
            const minPairs = c.isCreation ? 1 : 2;
            const structured = c.oldV ? null : parseStructuredAuditValue(c.newV, minPairs);
            if (structured) {
              const head = c.fieldLabel
                ? `<div class="hu-audit-change-head"><strong>${escapeHtml(c.fieldLabel)}</strong></div>`
                : '';
              // For the Ticket Created change, merge in the inferred
              // initial state for any other audited field so the user
              // can see the full picture of what the ticket looked like
              // at creation time. When filters are active, narrow the
              // inferred items to just those matching the filters so the
              // KV list isn't padded with unrelated siblings.
              let itemList = structured.slice();
              if (c === ticketCreationChange && inferredInitialFields.length) {
                const present = new Set(itemList.map(p => p.key.toLowerCase()));
                inferredInitialFields.forEach(extra => {
                  if (!present.has(extra.key.toLowerCase())) itemList.push(extra);
                });
                if (hasFieldFilter || lower) {
                  itemList = itemList.filter(p => {
                    const labelOk = !hasFieldFilter || selectedFields.has(p.key);
                    if (!labelOk) return false;
                    if (!lower) return true;
                    return `${p.key} ${p.value}`.toLowerCase().includes(lower);
                  });
                }
              }
              const items = itemList.map(p => `
                <div class="hu-audit-kv-row">
                  <span class="hu-audit-kv-key">${escapeHtml(p.key)}</span>
                  <span class="hu-audit-kv-val">${escapeHtml(p.value)}</span>
                </div>
              `).join('');
              const inferredNote = (c === ticketCreationChange && inferredInitialFields.length && !hasFieldFilter && !lower)
                ? '<div class="hu-audit-inferred-note">Inferred from later changes — fields that have audit rows.</div>'
                : '';
              return `<div class="hu-audit-change">${head}<div class="hu-audit-kv">${items}</div>${inferredNote}</div>`;
            }

            const bits = [];
            if (c.fieldLabel) bits.push(`<strong>${escapeHtml(c.fieldLabel)}</strong>`);
            if (c.oldV || c.newV) {
              const oldHtml = c.oldV
                ? `<span class="hu-audit-old">${escapeHtml(c.oldV)}</span>`
                : '<span class="hu-audit-old hu-audit-empty">(empty)</span>';
              const newHtml = c.newV
                ? `<span class="hu-audit-new">${escapeHtml(c.newV)}</span>`
                : '<span class="hu-audit-new hu-audit-empty">(empty)</span>';
              bits.push(`${oldHtml} &rarr; ${newHtml}`);
            }
            // Skip the duplicate outcome chip when the outcome is already
            // doing duty as the field label (Halo's creation rows).
            if (c.outcome && !c.outcomeUsedAsLabel) {
              bits.push(`<span class="hu-audit-outcome">${escapeHtml(c.outcome)}</span>`);
            }
            const body = bits.length
              ? bits.join(' &nbsp;·&nbsp; ')
              : '<em class="hu-audit-empty">No detail</em>';
            return `<div class="hu-audit-change">${body}</div>`;
          }).join('');

          const tableLabel = tx.tableQual && !/^(faults?|fault)$/i.test(tx.tableQual)
            ? ` <span class="hu-audit-table">on ${escapeHtml(tx.tableQual.toLowerCase())}</span>` : '';
          const txMeta = tx.changes.length > 1
            ? ` <span class="hu-audit-tx-count">${tx.changes.length} changes</span>`
            : '';

          const rowEl = document.createElement('div');
          rowEl.className = 'hu-audit-row';
          rowEl.innerHTML = `
            <div class="hu-audit-head">
              <span class="hu-audit-time">${escapeHtml(whenStr)}</span>
              <span class="hu-audit-who">${escapeHtml(tx.who)}</span>
              ${txMeta}${tableLabel}
            </div>
            <div class="hu-audit-detail">${changeLinesHtml}</div>
          `;

          list.appendChild(rowEl);
        });

        groupEl.appendChild(list);
        listsHost.appendChild(groupEl);
      });
    }

    render('');
    const filterInput = document.getElementById('hu-audit-filter');
    if (filterInput) {
      let debounceTimer;
      filterInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => render(filterInput.value), 60);
      });
      // Autofocus the filter so the user can start typing immediately.
      setTimeout(() => filterInput.focus(), 80);
    }
  }

  function showRecentPanel() {
    injectStyles();
    closeDrawer('hu-json-drawer');
    closeDrawer('hu-recent-drawer');

    const drawer = createDrawer('hu-recent-drawer', 'Recent records');
    const body = drawer.querySelector('.hu-drawer-body');
    const recent = getCachedRecent();

    if (!recent.length) {
      body.innerHTML = '<div class="hu-row"><span class="hu-row-title">No recent records yet</span><span class="hu-row-sub">Visit tickets, customers, agents, assets, reports, or config pages and they will appear here.</span></div>';
    } else {
      recent.forEach(item => {
        const row = document.createElement('button');
        row.className = 'hu-row';
        row.innerHTML = `
          <span class="hu-row-title">${escapeHtml(item.title)}</span>
          <span class="hu-row-sub">${escapeHtml(item.type)}${item.id ? ` ${escapeHtml(item.id)}` : ''} - ${escapeHtml(item.url)}</span>
        `;
        row.addEventListener('click', () => navigateTo(item.url));
        body.appendChild(row);
      });
    }
    openDrawer(drawer);
  }

  // Catalog ships as content/api-catalog.json — generated from swagger.json.
  // Lazy-loaded once per session; the file is web-accessible via the manifest.
  let API_CATALOG = null;
  let API_CATALOG_LOADING = null;

  async function loadApiCatalog() {
    if (API_CATALOG) return API_CATALOG;
    if (API_CATALOG_LOADING) return API_CATALOG_LOADING;
    API_CATALOG_LOADING = (async () => {
      try {
        const url = chrome.runtime.getURL('content/api-catalog.json');
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        API_CATALOG = data;
        return data;
      } catch (e) {
        API_CATALOG_LOADING = null;
        throw e;
      }
    })();
    return API_CATALOG_LOADING;
  }

  function endpointMatchesFilter(ep, lower, methodFilters) {
    if (methodFilters && methodFilters.size) {
      const methods = (ep.m || '').split(/\s+/);
      let any = false;
      for (const m of methods) { if (methodFilters.has(m)) { any = true; break; } }
      if (!any) return false;
    }
    if (!lower) return true;
    if ((ep.p || '').toLowerCase().includes(lower)) return true;
    if ((ep.s || '').toLowerCase().includes(lower)) return true;
    if ((ep.t || '').toLowerCase().includes(lower)) return true;
    if ((ep.c || '').toLowerCase().includes(lower)) return true;
    // Param-name matching: helps users find endpoints by query-param.
    if (Array.isArray(ep.params)) {
      for (const p of ep.params) {
        if (typeof p === 'string' && p.toLowerCase().includes(lower)) return true;
      }
    }
    return false;
  }

  function buildApiParamsHtml(ep) {
    if (!Array.isArray(ep.params) || ep.params.length === 0) {
      return '<div class="hu-api-noparams">No documented parameters.</div>';
    }
    const pathParams = [];
    const queryParams = [];
    for (const p of ep.params) {
      if (typeof p !== 'string') continue;
      const [name, where] = p.split('|');
      const html = `<code class="hu-api-param">${escapeHtml(name)}</code>`;
      if (where === 'path') pathParams.push(html);
      else queryParams.push(html);
    }
    const parts = [];
    if (pathParams.length) parts.push(`<div class="hu-api-param-row"><span class="hu-api-param-label">Path</span>${pathParams.join(' ')}</div>`);
    if (queryParams.length) parts.push(`<div class="hu-api-param-row"><span class="hu-api-param-label">Query</span>${queryParams.join(' ')}</div>`);
    return parts.join('');
  }

  function showApiReference() {
    injectStyles();
    closeDrawer('hu-json-drawer');
    closeDrawer('hu-recent-drawer');
    closeDrawer('hu-help-drawer');
    closeDrawer('hu-api-drawer');

    const drawer = createDrawer('hu-api-drawer', 'Halo REST API reference');
    const body = drawer.querySelector('.hu-drawer-body');

    // Toolbar: search input + method filter chips + count.
    const toolbar = document.createElement('div');
    toolbar.className = 'hu-api-toolbar';
    toolbar.innerHTML = `
      <input type="text" class="hu-api-search" placeholder="Search endpoints, params, or tags…" aria-label="Search API endpoints">
      <div class="hu-api-methods" role="group" aria-label="Filter by HTTP method">
        ${['GET','POST','PUT','DELETE','PATCH'].map(m => `<button type="button" class="hu-api-method-chip" data-method="${m}">${m}</button>`).join('')}
      </div>
      <div class="hu-api-count" aria-live="polite"></div>
    `;
    body.appendChild(toolbar);

    const resultsHost = document.createElement('div');
    resultsHost.className = 'hu-api-results';
    resultsHost.innerHTML = '<div class="hu-api-empty">Loading catalog…</div>';
    body.appendChild(resultsHost);

    const searchEl = toolbar.querySelector('.hu-api-search');
    const methodBtns = toolbar.querySelectorAll('.hu-api-method-chip');
    const countEl = toolbar.querySelector('.hu-api-count');
    const methodFilters = new Set();

    function renderList(catalog) {
      const lower = searchEl.value.trim().toLowerCase();
      const endpoints = catalog.endpoints || [];
      const matched = endpoints.filter(ep => endpointMatchesFilter(ep, lower, methodFilters));
      countEl.textContent = `${matched.length} of ${endpoints.length}`;

      if (!matched.length) {
        resultsHost.innerHTML = '<div class="hu-api-empty">No endpoints match.</div>';
        return;
      }
      // Group by category, preserving the catalog's category order.
      const groups = new Map();
      for (const ep of matched) {
        const key = ep.c || 'Other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ep);
      }
      const orderedCats = (catalog.categories || []).filter(c => groups.has(c));
      // Append any unexpected categories at the end.
      for (const k of groups.keys()) { if (!orderedCats.includes(k)) orderedCats.push(k); }

      const frag = document.createDocumentFragment();
      orderedCats.forEach(cat => {
        const heading = document.createElement('div');
        heading.className = 'hu-row hu-section-row';
        heading.innerHTML = `<span class="hu-section-label">${escapeHtml(cat)} <span class="hu-api-cat-count">${groups.get(cat).length}</span></span>`;
        frag.appendChild(heading);

        groups.get(cat).forEach(ep => {
          const row = document.createElement('div');
          row.className = 'hu-row hu-api-row hu-api-row-v2';
          row.innerHTML = `
            <div class="hu-api-row-head">
              <button type="button" class="hu-api-toggle" aria-label="Toggle parameter detail">
                <span class="hu-api-arrow">▸</span>
                <code class="hu-api-path">${escapeHtml(ep.p)}</code>
              </button>
              <div class="hu-api-meta">
                ${ep.s ? `<span class="hu-api-summary">${escapeHtml(ep.s)}</span>` : ''}
                <span class="hu-api-methods-tag">${escapeHtml(ep.m || '')}</span>
                <button class="hu-copy hu-api-copy" type="button" title="Copy path">Copy</button>
              </div>
            </div>
            <div class="hu-api-detail" hidden></div>
          `;

          const toggle = row.querySelector('.hu-api-toggle');
          const arrow  = row.querySelector('.hu-api-arrow');
          const detail = row.querySelector('.hu-api-detail');
          let loaded = false;
          toggle.addEventListener('click', () => {
            const open = !detail.hidden;
            if (open) {
              detail.hidden = true;
              arrow.textContent = '▸';
            } else {
              if (!loaded) {
                detail.innerHTML = buildApiParamsHtml(ep);
                loaded = true;
              }
              detail.hidden = false;
              arrow.textContent = '▾';
            }
          });

          const copyBtn = row.querySelector('.hu-api-copy');
          copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(ep.p).then(() => {
              const orig = copyBtn.textContent;
              copyBtn.textContent = 'Copied!';
              setTimeout(() => { copyBtn.textContent = orig; }, 1200);
            });
          });

          frag.appendChild(row);
        });
      });

      resultsHost.innerHTML = '';
      resultsHost.appendChild(frag);
    }

    loadApiCatalog().then(catalog => {
      renderList(catalog);
      searchEl.addEventListener('input', () => renderList(catalog));
      methodBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const m = btn.dataset.method;
          if (methodFilters.has(m)) { methodFilters.delete(m); btn.classList.remove('is-active'); }
          else { methodFilters.add(m); btn.classList.add('is-active'); }
          renderList(catalog);
        });
      });
      // Focus the search so the user can type immediately.
      setTimeout(() => searchEl.focus(), 50);
    }).catch(err => {
      resultsHost.innerHTML = `<div class="hu-api-empty">Could not load catalog: ${escapeHtml(String(err.message || err))}</div>`;
    });

    openDrawer(drawer);
  }

  function showHelpPanel() {
    injectStyles();
    closeDrawer('hu-json-drawer');
    closeDrawer('hu-recent-drawer');
    closeDrawer('hu-help-drawer');

    const drawer = createDrawer('hu-help-drawer', 'HaloPlus help');
    const body = drawer.querySelector('.hu-drawer-body');
    const items = [
      ['/', 'Open the command palette'],
      ['Enter', 'Open the selected result'],
      ['Esc', 'Close the palette or panel'],
      ['Arrow Up / Down', 'Move through results'],
      ['Arrow Right', 'Autocomplete the highlighted command (e.g. /peri → /peripherals-request)'],
      ['/t 2937', 'Open or search tickets by ID or text — partial IDs work too'],
      ['/i 2937', 'Open or search incidents by ID or text'],
      ['/c acme', 'Search customers by name or ID'],
      ['/a alex', 'Search agents by name or ID'],
      ['/u sam', 'Search users by name or ID'],
      ['/s london', 'Search sites by name or ID'],
      ['/asset abc', 'Search assets by tag or ID'],
      ['/prob', 'Open problems'],
      ['/chg', 'Open change requests'],
      ['/req', 'Open requests'],
      ['/prj', 'Open projects'],
      ['Custom types', 'Every tenant ticket type gets its own slash command (e.g. /laptop-request). Type the slug or use Arrow Right to autocomplete.'],
      ['Open count chip', 'Ticket-scoped commands show the number of open tickets — green chip on the right side of the row.'],
      ['Status pill', 'Ticket result rows show a coloured status pill matching Halo\'s per-status colour.'],
      ['/cfg', 'Open configuration (admin only)'],
      ['/rep', 'Open reports'],
      ['/kb', 'Search the knowledge base'],
      ['/r', 'Open recent Halo records'],
      ['/360', 'Open Ticket 360 for the current ticket'],
      ['/tl', 'Open the current ticket action timeline'],
      ['/f', 'Toggle API field names'],
      ['/j', 'Inspect the current record payload'],
      ['/api', 'Browse all Halo REST API endpoints'],
      ['/imp alex', 'Search agents and impersonate the selected (admin only)'],
      ['/xi', 'Exit the impersonated Halo session'],
      ['/sc', 'Save the current page as a shortcut']
    ];

    items.forEach(([title, description]) => {
      const isCommand = title.startsWith('/');
      const row = document.createElement(isCommand ? 'button' : 'div');
      row.className = 'hu-row';
      if (!isCommand) row.style.cursor = 'default';
      row.innerHTML = `
        <span class="hu-row-title">${escapeHtml(title)}</span>
        <span class="hu-row-sub">${escapeHtml(description)}</span>
      `;
      if (isCommand) {
        row.addEventListener('click', () => {
          closeDrawer('hu-help-drawer');
          openPalette(title.replace(/^\//, '').split(' ')[0]);
        });
      }
      body.appendChild(row);
    });

    openDrawer(drawer);
  }

  function slaArcSvg(openedStr, dueStr, closedStr, slaState) {
    const r = 30, circ = 2 * Math.PI * r, arc = circ / 2, offset = -(circ / 4);
    let pct = 0, color = '#94a3b8', label = '--';
    const opened = openedStr ? parseHaloDate(openedStr).getTime() : 0;
    const due    = dueStr    ? parseHaloDate(dueStr).getTime()    : 0;
    if (opened && due) {
      const now = closedStr ? parseHaloDate(closedStr).getTime() : Date.now();
      pct   = Math.min(Math.max((now - opened) / (due - opened), 0), 1);
      label = slaState === 'O' ? 'Over' : slaState === 'E' ? 'Excl' : `${Math.round(pct * 100)}%`;
      color = slaState === 'O' ? '#ef4444' : slaState === 'E' ? '#94a3b8'
            : pct >= 1 ? '#ef4444' : pct >= 0.85 ? '#f59e0b' : '#10b981';
    } else if (slaState) {
      const sc = { I: '#10b981', O: '#ef4444', E: '#94a3b8' };
      color = sc[slaState] || '#94a3b8';
      label = { I: 'OK', O: 'Over', E: 'Excl' }[slaState] || '--';
      pct   = slaState === 'O' ? 1 : slaState === 'I' ? 0.5 : 0;
    }
    const fill = pct * arc;
    return `<svg width="80" height="54" viewBox="0 0 80 54" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
      <circle cx="40" cy="44" r="${r}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${arc} ${circ}" stroke-dashoffset="${offset}"/>
      <circle cx="40" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${fill} ${circ}" stroke-dashoffset="${offset}"/>
      <text x="40" y="44" text-anchor="middle" dominant-baseline="middle" style="font-size:12px;font-weight:800;fill:#fff;font-family:-apple-system,sans-serif">${escapeHtml(label)}</text>
      <text x="40" y="57" text-anchor="middle" style="font-size:9px;fill:rgba(255,255,255,0.50);font-family:-apple-system,sans-serif">SLA</text>
    </svg>`;
  }

  function priorityDot(s) {
    const p = String(s || '').toLowerCase();
    if (/critical|urgent|p1/.test(p)) return '#ef4444';
    if (/high|p2/.test(p))            return '#f59e0b';
    if (/low|p4/.test(p))             return '#10b981';
    return '#3b82f6';
  }

  // Look up an action outcome's tenant-configured colour from Halo's cache.
  // Tries cache_actionoutcome first (Halo's canonical key) then cache_outcome
  // (older / alternative). Matches by id first, then case-insensitive name.
  // Returns a sanitised hex/rgb string or '' when nothing usable was found.
  function lookupOutcomeColour(outcomeId, outcomeName) {
    const candidates = ['cache_actionoutcome', 'cache_outcome'];
    const nameKey = String(outcomeName || '').trim().toLowerCase();
    const idNum = Number(outcomeId);
    for (const key of candidates) {
      const cache = readHaloCacheLookup(key);
      if (!cache) continue;
      let row = Number.isFinite(idNum) ? cache.get(idNum) : null;
      if (!row && nameKey) {
        for (const v of cache.values()) {
          if (String(v?.name || v?.outcome || '').trim().toLowerCase() === nameKey) {
            row = v;
            break;
          }
        }
      }
      if (!row) continue;
      const raw = String(row.colour || row.color || '').trim();
      if (/^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw)) return raw;
    }
    return '';
  }

  // Accepts either a plain outcome string (legacy callers) or the flattened
  // action object so the tenant-configured cache colour can be applied.
  function classifyAction(outcomeOrAction) {
    let outcome = '';
    let cacheColour = '';
    if (outcomeOrAction && typeof outcomeOrAction === 'object') {
      outcome = outcomeOrAction['Outcome'] || '';
      cacheColour = lookupOutcomeColour(outcomeOrAction['Outcome ID'], outcome);
    } else {
      outcome = outcomeOrAction;
    }
    const o = String(outcome || '').toLowerCase();
    let base;
    if (/email|mail|sent/.test(o))                          base = { label: 'Email',         color: '#3b82f6' };
    else if (/status|changed|closed|resolved|opened/.test(o)) base = { label: 'Status change', color: '#f59e0b' };
    else if (/time|spent|logged/.test(o))                   base = { label: 'Time entry',     color: '#8b5cf6' };
    else                                                    base = { label: 'Note',           color: '#10b981' };
    return cacheColour ? { ...base, color: cacheColour } : base;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '--';
    const d = parseHaloDate(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)  return `${days}d ago`;
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
  }

  // ---------- Ticket 360 v2 helper renderers ----------

  // Single top-of-panel banner. Highest-priority condition wins so the
  // section stays compact (multi-row banner stacks look noisy in the dark
  // drawer). Approval > VIP > Important > Major incident.
  function renderTicket360Banners(ticket) {
    const SVG = {
      approval:  '<svg class="hu-360-banner-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h6M5 14h6M5 2v3l3 3-3 3v3M11 2v3l-3 3 3 3v3"/></svg>',
      vip:       '<svg class="hu-360-banner-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l1.85 4.4 4.65.4-3.5 3.1L12.1 14 8 11.6 3.9 14l1.1-4.6L1.5 6.3l4.65-.4z"/></svg>',
      important: '<svg class="hu-360-banner-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11v0.5"/></svg>',
      major:     '<svg class="hu-360-banner-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l6 11H2z"/><path d="M8 7v3M8 11.5v0.5"/></svg>'
    };

    let kind = null, text = '';
    // Awaiting approval: requires both a current step number AND a non-empty
    // step name. Halo keeps approval_process_step/_id populated on tickets
    // that USED to require approval but are now approved, so the empty
    // step_name is our signal that approval has actually completed.
    const apprStepName = String(ticket.approval_process_step_name || '').trim();
    if (ticket.approval_process_id && Number(ticket.approval_process_step) > 0 && apprStepName) {
      kind = 'approval';
      const group = String(ticket.approval_process_group_name || '').trim();
      const parts = [apprStepName, group].filter(Boolean).join(' · ');
      text = `Awaiting approval — ${parts}`;
    } else if (ticket.is_vip || ticket.user?.is_vip || ticket.user?.client?.is_vip) {
      kind = 'vip';
      text = 'VIP customer — this ticket is from a high-priority account.';
    } else if (ticket.isimportantcontact || ticket.user?.isimportantcontact) {
      kind = 'important';
      text = 'Key contact at this client — handle communications with extra care.';
    } else if (/major.?incident/i.test(String(ticket.tickettype?.name || ''))) {
      kind = 'major';
      text = 'Major Incident — alert subscribers as needed.';
    }
    if (!kind) return null;

    const el = document.createElement('div');
    el.className = `hu-360-banner hu-360-banner-${kind}`;
    el.innerHTML = `${SVG[kind]}<span class="hu-360-banner-text">${escapeHtml(text)}</span>`;
    return el;
  }

  // Popup notes attached to the requester / site / client. Halo's own UI
  // surfaces them as modal dialogs on form open; we render them as
  // banners at the top of Ticket 360 so the agent sees them without
  // having to open the customer record. Field names match the AreaPopup
  // swagger schema (note, date_created, displayhtml, displaymodal,
  // dismissable, limitdaterange, startdate, enddate).
  //
  // Honouring Halo's flags:
  //   • limitdaterange — filter notes outside their active window
  //   • displayhtml    — render note body as HTML when true, escape otherwise
  //   • displaymodal   — stronger "alert" styling, requires explicit ack
  //   • dismissable    — show an X button; non-dismissable notes stay visible
  function renderTicket360PopupNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return null;
    // Dismissed-this-session set (in-memory). Re-opening the 360 drawer
    // re-fetches notes, but ones the agent already dismissed this
    // session stay hidden.
    if (!HU.dismissedPopupNotes) HU.dismissedPopupNotes = new Set();

    const wrap = document.createElement('div');
    wrap.className = 'hu-360-banners hu-360-popup-banners';

    const now = Date.now();
    const active = notes.filter(n => {
      if (!n) return false;
      if (n.id != null && HU.dismissedPopupNotes.has(n.id)) return false;
      if (n.limitdaterange) {
        const s = n.startdate ? parseHaloDate(n.startdate).getTime() : null;
        const e = n.enddate   ? parseHaloDate(n.enddate).getTime()   : null;
        if (s && s > now) return false;
        if (e && e < now) return false;
      }
      return true;
    });

    active.slice(0, 4).forEach(note => {
      const body = String(note?.note || note?.note_text || note?.text || '').trim();
      if (!body) return;
      const dateRaw = note?.date_created || note?.datecreated || note?.date || '';
      const date = dateRaw ? formatDateTime(dateRaw) : '';
      const scope = (() => {
        if (note?.user_id   || note?.userid)   return 'this user';
        if (note?.site_id   || note?.siteid)   return 'this site';
        if (note?.client_id || note?.clientid) return 'this customer';
        return 'this account';
      })();

      const isModal = note.displaymodal === true;
      const isDismissable = note.dismissable === true;

      const ban = document.createElement('div');
      ban.className = 'hu-360-banner hu-360-banner-popupnote'
                    + (isModal ? ' hu-360-banner-popupnote-modal' : '');

      const bodyHtml = note.displayhtml === true ? body : escapeHtml(body);
      const titlePrefix = isModal ? 'Important — ' : '';
      const closeBtnHtml = isDismissable
        ? '<button type="button" class="hu-360-popup-close" aria-label="Dismiss note" title="Dismiss for this session">×</button>'
        : '';

      ban.innerHTML =
        '<svg class="hu-360-banner-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          (isModal
            ? '<path d="M8 2l6 11H2z"/><path d="M8 7v3M8 11.5v0.5"/>'
            : '<path d="M3 3h10v8H6l-3 3z"/><path d="M5 6h6M5 8h4"/>') +
        '</svg>' +
        '<div class="hu-360-popup-content">' +
          `<div class="hu-360-banner-text">${escapeHtml(titlePrefix)}Popup note about ${escapeHtml(scope)}</div>` +
          `<div class="hu-360-popup-body">${bodyHtml}</div>` +
          (date ? `<div class="hu-360-popup-meta">Added ${escapeHtml(date)}</div>` : '') +
        '</div>' +
        closeBtnHtml;

      if (isDismissable) {
        ban.querySelector('.hu-360-popup-close').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (note.id != null) HU.dismissedPopupNotes.add(note.id);
          ban.remove();
          // If the wrapper is now empty, remove it so layout collapses cleanly.
          if (!wrap.childElementCount) wrap.remove();
        });
      }

      wrap.appendChild(ban);
    });
    return wrap.childElementCount ? wrap : null;
  }

  // Aging + activity badges. Compact "open 3d · 7 actions · last touched 2h"
  // chip row that sits in the hero, gives the agent an instant temperature read.
  // SLA half-donut: single ring showing the most critical SLA. We rank
  // by worst state class (danger > warn > ok), then by highest percent
  // used so the agent always sees the SLA closest to (or past) breach.
  // Center shows time-remaining; label below names the SLA + percent.
  function renderTicket360SlaDonut(ticket) {
    const opened = ticket.dateoccurred || ticket.datecreated;
    const closed = (() => {
      const c = ticket.dateclosed || ticket.datecleared;
      if (!c || !opened) return c;
      return parseHaloDate(c).getTime() < parseHaloDate(opened).getTime() ? '' : c;
    })();
    if (!opened) return '';
    const od = parseHaloDate(opened).getTime();
    const cd = closed ? parseHaloDate(closed).getTime() : null;
    const now = cd || Date.now();

    // Halo exposes the actual response timestamp as `responsedate` (plus a
    // categorical `slaresponsestate`: "I" inside / "O" outside / "E" excluded
    // / "A" awaiting). When `responsedate` is present, calc compares it to
    // respondbydate and produces the correct met-on-time vs met-late split.
    // metFlag is only used as a fallback when we know the stage completed
    // but lack a timestamp — and we suppress it when Halo explicitly flags
    // the Respond SLA as breached ('O'), so a closed-late ticket stops
    // showing as Met.
    const respondDueIso = ticket.respondbydate || ticket.first_respond_by_date;
    const respondMetIso = ticket.responsedate || null;
    const respondState = String(ticket.slaresponsestate || '').toUpperCase();
    const respondMet = !respondMetIso && respondState !== 'O' && !!respondDueIso && (
      respondState === 'I' ||
      !!closed ||
      (ticket.slaactiondate && parseHaloDate(ticket.slaactiondate).getTime() > parseHaloDate(respondDueIso).getTime())
    );

    const calc = (dueIso, name, metIso, metFlag) => {
      if (!dueIso) return null;
      const dd = parseHaloDate(dueIso).getTime();
      if (!dd || dd <= od) return null;
      const md = metIso ? parseHaloDate(metIso).getTime() : null;
      const validMd = Number.isFinite(md) && md > od;
      const stopTime = validMd ? md : (cd || null);
      const stopNow = stopTime || Date.now();
      const usedPct = Math.min(Math.max((stopNow - od) / (dd - od), 0), 1);

      // Two-band fill: pctUsed is what was actually consumed; pctTotal is
      // the full extent of the segment we want to colour (used + spare).
      // For closed-and-met SLAs, pctUsed < pctTotal=1 so the bar/donut
      // shows the consumed portion in primary colour with the remaining
      // headroom as a lighter overlay. For active or breached SLAs, both
      // equal so a single fill renders.
      let cls, note, isMet = false, pctUsed, pctTotal, noteState = 'plain', overshootMs = 0;
      if (validMd) {
        isMet = true;
        if (md <= dd) {
          cls = 'is-ok'; note = ''; noteState = 'met';
          pctUsed = usedPct;   // stopTime was md, so this is the real consumed fraction
          pctTotal = 1;
        } else {
          cls = 'is-danger'; note = `${formatDurationShort(md - dd)} over`; noteState = 'breached';
          pctUsed = 1; pctTotal = 1;
          overshootMs = md - dd;
        }
      } else if (metFlag) {
        isMet = true;
        cls = 'is-ok'; note = ''; noteState = 'met';
        // No exact met timestamp — we can't honestly show "how much was
        // consumed". Render a full bar; the icon still tells the user it's met.
        pctUsed = 1; pctTotal = 1;
      } else {
        cls = usedPct < 0.5 ? 'is-ok' : usedPct < 0.9 ? 'is-warn' : 'is-danger';
        const diffMs = dd - Date.now();
        if (cd) {
          note = 'Closed';
          pctUsed = usedPct; pctTotal = usedPct;
        } else if (diffMs > 0) {
          note = `${formatDurationShort(diffMs)} left`;
          pctUsed = usedPct; pctTotal = usedPct;
        } else {
          note = `${formatDurationShort(-diffMs)} over`;
          noteState = 'breached';
          pctUsed = 1; pctTotal = 1;
          overshootMs = -diffMs;
        }
      }
      // `pct` aliases pctTotal so the active-critical sort below can compare
      // active SLAs by usage. `overshootMs` is the magnitude of the breach,
      // used by the closed-verdict picker to surface the worst late SLA.
      return { name, pct: pctTotal, pctUsed, pctTotal, cls, note, isMet, noteState, overshootMs, durationMs: dd - od };
    };
    const slas = [
      calc(respondDueIso, 'Respond', respondMetIso, respondMet),
      calc(ticket.fixbydate, 'Fix', cd ? new Date(cd).toISOString() : null, false)
    ].filter(Boolean);
    if (!slas.length) return '';

    // Closed-ticket summary: instead of arbitrarily surfacing one of two
    // finished SLAs, collapse to a verdict that reflects how the ticket
    // landed. "All SLAs met" if every SLA closed on time, "Closed late"
    // (with the worst overshoot) if any breached.
    let critical;
    if (cd) {
      const breaches = slas.filter(s => s.cls === 'is-danger');
      if (breaches.length) {
        // Worst breach wins by overshoot magnitude (pct is 1 for any
        // breached SLA so it doesn't distinguish them). The red cross icon
        // already conveys "late", so we drop the "Closed late ·" prefix
        // and just show the offending SLA + overshoot — keeps the centre
        // text inside the donut bowl.
        const worst = breaches.slice().sort((a, b) => b.overshootMs - a.overshootMs)[0];
        critical = { name: worst.name, pct: 1, cls: 'is-danger', note: `${worst.name} ${worst.note || 'over'}`, isMet: true, noteState: 'breached' };
      } else {
        critical = { name: 'All', pct: 1, cls: 'is-ok', note: 'All met', isMet: true, noteState: 'met' };
      }
    } else {
      // Pick the most critical: active SLAs always beat met ones (no point
      // surfacing a finished deadline), then worst class, then highest %.
      const classOrder = { 'is-ok': 0, 'is-warn': 1, 'is-danger': 2 };
      critical = slas.slice().sort((a, b) => {
        // Active (not met) wins over met.
        if (a.isMet !== b.isMet) return a.isMet ? 1 : -1;
        const co = classOrder[b.cls] - classOrder[a.cls];
        return co !== 0 ? co : b.pct - a.pct;
      })[0];
    }

    const W = 140, H = 48;
    const cx = W / 2, cy = H - 4;
    const r = 40, stroke = 8;
    const arcLen = Math.PI * r;
    // Half-arc parameterisation: f=0 at the left end, f=1 at the right end.
    // The arc runs counter-clockwise from left → top → right.
    const pointAt = f => {
      const theta = Math.PI * (1 - f);
      return [cx + r * Math.cos(theta), cy - r * Math.sin(theta)];
    };
    const arcPathFromTo = (f1, f2) => {
      const [x1, y1] = pointAt(f1);
      const [x2, y2] = pointAt(f2);
      return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
    };

    // Fixed 40/60 split between Respond and Fix to match the SLA bars.
    // A single SLA (e.g. tickets with only a Fix target) takes the full
    // arc. A 4% gap on either side of each segment keeps the boundary
    // visually distinct (~8% total between Respond and Fix).
    const segments = [];
    let cursor = 0;
    const gap = slas.length > 1 ? 0.04 : 0; // 4% of the arc per side
    slas.forEach((sla, i) => {
      const share = slas.length === 1 ? 1
        : sla.name === 'Respond' ? 0.4
        : 0.6;
      const fStart = cursor + (i === 0 ? 0 : gap);
      const fEnd   = cursor + share - (i === slas.length - 1 ? 0 : gap);
      cursor += share;
      segments.push({ sla, fStart, fEnd });
    });

    const tipParts = slas.map(s => {
      const noteText = s.note || (s.noteState === 'met' ? 'Met' : s.noteState === 'breached' ? 'Breached' : '');
      // pctUsed is the consumed fraction (meaningful for met-on-time tickets
      // too). pctTotal/pct is always 1 for any finished SLA so it doesn't
      // tell you anything about how close to the deadline you actually got.
      return `${s.name}: ${Math.round(s.pctUsed * 100)}%${noteText ? ` (${noteText})` : ''}`;
    });

    const segHtml = segments.map(({ sla, fStart, fEnd }) => {
      const segLen = (fEnd - fStart) * arcLen;
      const usedLen  = segLen * sla.pctUsed;
      const totalLen = segLen * sla.pctTotal;
      const segPath = arcPathFromTo(fStart, fEnd);
      // Animation: dasharray "segLen segLen" + dashoffset from segLen (fully
      // hidden) to (segLen - fillLen) (fillLen revealed at the start). Reuses
      // the existing keyframe (--sla-arc-len → --sla-end-offset).
      const usedOffset  = (segLen - usedLen).toFixed(2);
      const totalOffset = (segLen - totalLen).toFixed(2);
      // The spare overlay is the gap between the used portion and the full
      // extent — only rendered when there's actually a gap (closed-met-on-time).
      const hasSpare = totalLen > usedLen + 0.01;
      return `
        <path d="${segPath}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" class="hu-360-sla-donut-track"/>
        ${hasSpare ? `<path d="${segPath}" fill="none" stroke-width="${stroke}" stroke-linecap="round"
          class="hu-360-sla-donut-fill hu-360-sla-donut-fill-spare ${sla.cls}"
          style="stroke-dasharray:${segLen.toFixed(2)} ${segLen.toFixed(2)}; --sla-arc-len:${segLen.toFixed(2)}; --sla-end-offset:${totalOffset};"/>` : ''}
        ${usedLen > 0 ? `<path d="${segPath}" fill="none" stroke-width="${stroke}" stroke-linecap="round"
          class="hu-360-sla-donut-fill ${sla.cls}"
          style="stroke-dasharray:${segLen.toFixed(2)} ${segLen.toFixed(2)}; --sla-arc-len:${segLen.toFixed(2)}; --sla-end-offset:${usedOffset};"/>` : ''}
      `;
    }).join('');

    const centerIcon = slaStatusIconHtml(critical.noteState);
    const centerNoteText = critical.noteState === 'met'
      ? (critical.note && critical.note !== 'Met' ? critical.note : '')
      : critical.note || '';

    return `<div class="hu-360-sla-donut" title="${escapeHtml(tipParts.join('\n'))}">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
        ${segHtml}
      </svg>
      ${centerIcon ? `<div class="hu-360-sla-donut-center-icon ${critical.cls}">${centerIcon}</div>` : ''}
      ${centerNoteText ? `<div class="hu-360-sla-donut-center ${critical.cls}"><span class="hu-360-sla-donut-center-text">${escapeHtml(centerNoteText)}</span></div>` : ''}
    </div>`;
  }

  function renderTicket360AgingBadges(ticket, actions) {
    const opened = ticket.dateoccurred || ticket.datecreated;
    const lastUpdate = ticket.last_update || ticket.lastactiondate || '';
    const badges = [];
    if (opened) {
      const days = Math.max(0, Math.floor((Date.now() - parseHaloDate(opened).getTime()) / 86400000));
      badges.push(days === 0 ? 'Opened today' : `Open ${days}d`);
    }
    if (actions?.length) badges.push(`${actions.length} action${actions.length === 1 ? '' : 's'}`);
    if (lastUpdate) badges.push(`Last touched ${timeAgo(lastUpdate)}`);

    // Appointment chip — DD/MM/YYYY, HH.MM (24h). Sourced from
    // includelastappointment / includenextappointment on /api/tickets/{id}.
    // We use a fixed European format (not formatDateTime) because the date
    // sits next to other compact aging chips and needs to be unambiguous.
    const formatApptDate = (iso) => {
      const d = parseHaloDate(iso);
      if (!d || isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    };
    const nextAppt = ticket.next_appointment || ticket.nextappointment || ticket.nextAppointment;
    const lastAppt = ticket.last_appointment || ticket.lastappointment || ticket.lastAppointment;
    const apptToShow = (nextAppt && (nextAppt.start_date || nextAppt.startdate)) ? nextAppt
                      : (lastAppt && (lastAppt.start_date || lastAppt.startdate)) ? lastAppt
                      : null;
    if (apptToShow) {
      const when = formatApptDate(apptToShow.start_date || apptToShow.startdate);
      if (when) badges.push('Appointment: ' + when);
    }

    if (!badges.length) return '';
    // Build chip with optional per-chip tooltip data (e.g. appointment subject).
    const apptSubject = apptToShow
      ? String(apptToShow.subject || apptToShow.summary || apptToShow.title || apptToShow.name || '').trim()
      : '';
    return `<div class="hu-360-aging" id="hu-360-aging-row">${badges.map(b => {
      const isAppt = b.startsWith('Appointment:');
      const titleAttr = isAppt && apptSubject ? ` title="${escapeHtml(apptSubject)}"` : '';
      return `<span class="hu-360-aging-chip"${titleAttr}>${escapeHtml(b)}</span>`;
    }).join('')}</div>`;
  }

  // Append a "Viewed N×" chip once /api/FaultViewLog resolves. Tooltip
  // shows the most recent viewers with timestamps. Halo's swagger doesn't
  // pin down the row schema, so we try a handful of plausible field names
  // and fall back to looking up `agent_id` in `cache_agent`.
  function viewerNameFromRow(row) {
    const direct = row.agent_name || row.agentname || row.username || row.name
                || row.who || row.agent || row.viewed_by_name || row.viewer_name;
    if (direct) return String(direct);
    const id = row.agent_id || row.agentid || row.viewer_id || row.viewed_by;
    if (id) {
      const cached = getCachedName('cache_agent', id);
      if (cached) return cached;
      return 'Agent #' + id;
    }
    return '';
  }

  function patchTicket360ViewLog(viewLogResp) {
    const row = document.getElementById('hu-360-aging-row');
    if (!row) return;
    const rows = Array.isArray(viewLogResp) ? viewLogResp
      : (viewLogResp?.faultsviewlog || viewLogResp?.faultviewlog
         || viewLogResp?.viewlog || viewLogResp?.viewlogs
         || viewLogResp?.items || []);
    if (!rows.length) return;
    const total = rows.length;
    // Build a tooltip listing the last few viewers. Skip rows with no
    // resolvable name — these add no information to the tooltip.
    const recent = rows.slice(0, 6).map(r => {
      const who = viewerNameFromRow(r);
      const whenRaw = r.date || r.viewdate || r.datetime || r.when
                   || r.when_viewed || r.date_viewed;
      const when = whenRaw ? formatDateTime(whenRaw) : '';
      if (!who && !when) return '';
      return [who || 'Unknown agent', when].filter(Boolean).join(' — ');
    }).filter(Boolean).join('\n');

    const chip = document.createElement('span');
    chip.className = 'hu-360-aging-chip hu-360-aging-viewed';
    chip.textContent = total === 1 ? 'Viewed 1×' : `Viewed ${total}×`;
    chip.title = recent || 'View log entries had no recognisable viewer field.';
    row.appendChild(chip);
  }

  // Quick-action pill buttons.
  //   Note   — inline note editor (POST /api/actions)
  //   Time   — quick time-entry editor (POST /api/actions with timetaken)
  //   Flag   — toggles ticket.flagged
  // Status removed — clicking the status chip already opens the picker.
  function renderTicket360QuickActionsHtml(ticketId, flagged) {
    const svg = (path) => `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    const icons = {
      note: svg('<path d="M11.5 2.5l2 2L5 13H3v-2z"/><path d="M9 4l3 3"/>'),
      time: svg('<circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/>'),
      flag: svg('<path d="M3 14V2"/><path d="M3 3h9l-2 3 2 3H3"/>'),
      link: svg('<path d="M7 9a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4L8 4"/><path d="M9 7a3 3 0 0 0-4 0L3 9a3 3 0 0 0 4 4l1-1"/>'),
      audit: svg('<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="13" cy="4" r="1.6"/><circle cx="5" cy="8" r="1.6"/><circle cx="10" cy="12" r="1.6"/>')
    };
    const flagFill = flagged ? 'fill="currentColor"' : 'fill="none"';
    const flagIcon = `<svg viewBox="0 0 16 16" width="11" height="11" ${flagFill} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V2"/><path d="M3 3h9l-2 3 2 3H3" ${flagFill}/></svg>`;
    return `<div class="hu-360-quick-actions">
      <button type="button" class="hu-360-quick-btn" data-action="note">${icons.note}<span>Note</span></button>
      <button type="button" class="hu-360-quick-btn" data-action="time">${icons.time}<span>Time</span></button>
      <button type="button" class="hu-360-quick-btn" data-action="flag" aria-pressed="${flagged ? 'true' : 'false'}">${flagIcon}<span>${flagged ? 'Flagged' : 'Flag'}</span></button>
      <button type="button" class="hu-360-quick-btn" data-action="copy-link" title="Copy link to this ticket">${icons.link}<span>Copy link</span></button>
    </div>`;
  }

  // Fetch a workflow's stages from /api/Workflow/{id}. Cached per session
  // (workflow definitions rarely change). Returns an array of {id, name, seq}.
  async function fetchWorkflowStages(workflowId) {
    if (!workflowId) return [];
    if (!HU.workflowCache) HU.workflowCache = {};
    if (HU.workflowCache[workflowId]) return HU.workflowCache[workflowId];
    try {
      const detail = await haloApiRequest(`/api/Workflow/${encodeURIComponent(workflowId)}?includedetails=true`);
      const arr = detail.flow_stages || detail.stages || detail.steps || detail.flowstages || [];
      const stages = (Array.isArray(arr) ? arr : []).map(s => ({
        id: s.id || s.sid || s.stageid,
        name: String(s.name || s.stage_name || s.label || '').trim(),
        seq:  Number(s.sequence_no || s.seq || s.sequence || 0),
        // Status that this stage parks the ticket in. Used by the status
        // picker to filter cache_status down to only the statuses reachable
        // from this workflow.
        status_id: s.status_id != null ? Number(s.status_id)
                  : s.statusid != null ? Number(s.statusid)
                  : (s.status && typeof s.status === 'object' ? Number(s.status.id) : null)
      })).filter(s => s.name);
      stages.sort((a, b) => a.seq - b.seq);
      HU.workflowCache[workflowId] = stages;
      return stages;
    } catch (_) {
      HU.workflowCache[workflowId] = [];
      return [];
    }
  }

  // Workflow & SLA section — segmented workflow bar, two class-driven SLA
  // bars, and a date grid. No SVG arc. Renders as a flat .hu-360-sec.
  function renderTicket360StatusCard(ticket, summary /*, slaArcHtml — ignored */) {
    const openedIso = ticket.dateoccurred || ticket.datecreated;
    const closedIso = (() => {
      const c = ticket.dateclosed || ticket.datecleared;
      if (!c || !openedIso) return c;
      return parseHaloDate(c).getTime() < parseHaloDate(openedIso).getTime() ? '' : c;
    })();

    // Halo exposes the actual response timestamp as `responsedate` (the
    // datetime the agent first responded). When set, that flows through as
    // `metIso` to buildBar so we get the exact met-on-time vs met-late split.
    // `slaresponsestate` is the categorical signal: "I" inside / "O" outside
    // / "E" excluded / "A" awaiting — used to short-circuit metFlag so a
    // closed-late ticket doesn't show as Met just because it's closed.
    const respondDueIso = ticket.respondbydate || ticket.first_respond_by_date;
    const respondMetIso = ticket.responsedate || null;
    const respondState = String(ticket.slaresponsestate || '').toUpperCase();
    const respondMet = !respondMetIso && respondState !== 'O' && !!respondDueIso && (
      respondState === 'I' ||
      !!closedIso ||
      (ticket.slaactiondate && parseHaloDate(ticket.slaactiondate).getTime() > parseHaloDate(respondDueIso).getTime())
    );

    // Build a bar. metIso = exact met timestamp (used for on-time/late split);
    // metFlag = "we know it was met but don't have the exact time" (treats
    // as on-time since we can't prove otherwise without the timestamp).
    const buildBar = (label, dueIso, metIso, metFlag) => {
      if (!openedIso || !dueIso) return null;
      const od = parseHaloDate(openedIso).getTime();
      const dd = parseHaloDate(dueIso).getTime();
      if (!od || !dd || dd <= od) return null;
      const cd = closedIso ? parseHaloDate(closedIso).getTime() : null;
      const md = metIso ? parseHaloDate(metIso).getTime() : null;
      const validMd = Number.isFinite(md) && md > od;
      const stopTime = validMd ? md : cd;
      const now = stopTime || Date.now();
      const usedPct = Math.min(Math.max((now - od) / (dd - od), 0), 1);

      let cls, noteLeft, pctUsed, pctTotal, noteState = 'plain';
      if (validMd) {
        if (md <= dd) {
          cls = 'is-ok'; noteLeft = ''; noteState = 'met';
          // Closed/met on time: pctUsed is the actual consumed slice; the
          // remainder (1 - pctUsed) renders as the lighter spare overlay.
          pctUsed = usedPct; pctTotal = 1;
        } else {
          cls = 'is-danger'; noteLeft = `${formatDurationShort(md - dd)} over`; noteState = 'breached';
          pctUsed = 1; pctTotal = 1;
        }
      } else if (metFlag) {
        // No exact met timestamp — full bar (we can't honestly split it).
        cls = 'is-ok'; noteLeft = ''; noteState = 'met';
        pctUsed = 1; pctTotal = 1;
      } else {
        cls = usedPct < 0.5 ? 'is-ok' : usedPct < 0.9 ? 'is-warn' : 'is-danger';
        const diffMs = dd - Date.now();
        if (cd) {
          noteLeft = 'Closed';
          pctUsed = usedPct; pctTotal = usedPct;
        } else if (diffMs > 0) {
          noteLeft = `${formatDurationShort(diffMs)} left`;
          pctUsed = usedPct; pctTotal = usedPct;
        } else {
          noteLeft = `${formatDurationShort(-diffMs)} over`;
          noteState = 'breached';
          pctUsed = 1; pctTotal = 1;
        }
      }
      return {
        label, cls, noteLeft, noteState,
        pctUsedPx:  Math.round(pctUsed * 100),
        pctTotalPx: Math.round(pctTotal * 100),
        durationMs: dd - od
      };
    };
    const respondBar = buildBar('Respond', respondDueIso, respondMetIso, respondMet);
    const fixBar     = buildBar('Fix',     ticket.fixbydate, closedIso, false);
    const bars = [respondBar, fixBar].filter(Boolean);

    const workflowName = String(ticket.workflow_name || '').trim();
    const currentStepName = String(ticket.workflow_step || '').trim();
    const current = Math.max(1, Number(ticket.workflow_seq) || 1);

    // Render a placeholder bar (5 segments). Once fetchWorkflowStages
    // resolves, replace it with the real-stage version. Re-render is
    // in-place so the rest of the section doesn't flicker.
    const placeholderTotal = 5;
    const segmentsHtml = (count, cur, names) => Array.from({ length: count }).map((_, i) => {
      const cls = i < cur - 1 ? 'is-on' : i === cur - 1 ? 'is-current' : '';
      const name = names && names[i] ? String(names[i]) : '';
      const title = name ? `title="${escapeHtml(name)}"` : '';
      const labelHtml = name ? `<span class="hu-360-wf-seg-label">${escapeHtml(name)}</span>` : '';
      return `<div class="hu-360-wf-seg ${cls}" ${title}>${labelHtml}</div>`;
    }).join('');

    const sec = document.createElement('section');
    sec.className = 'hu-360-sec hu-360-status-card';
    sec.innerHTML = `
      <div class="hu-360-sec-h">Workflow &amp; SLA</div>
      ${workflowName ? `
        <div class="hu-360-wf-row">
          <div class="hu-360-wf-name">${escapeHtml(workflowName)}</div>
          <div class="hu-360-wf-step">${currentStepName ? escapeHtml(currentStepName) + ' · ' : ''}Step ${escapeHtml(String(current))} of ${escapeHtml(String(placeholderTotal))}</div>
        </div>` : ''}
      <div class="hu-360-wf-bar${closedIso ? '' : ' is-active'}" data-wf-bar>${segmentsHtml(placeholderTotal, current)}</div>

      ${bars.length ? `<div class="hu-360-status-bars hu-360-status-bars--split">
        ${bars.map(b => {
          // Fixed share: Respond gets 40%, Fix gets 60%. When only one of
          // the two exists, that one takes the full row.
          const sharePct = bars.length === 1 ? 100
            : b.label === 'Respond' ? 40
            : 60;
          const icon = slaStatusIconHtml(b.noteState);
          const tipText = b.noteState === 'met' ? `Met (used ${b.pctUsedPx}%)` : b.noteLeft;
          const noteHtml = icon
            ? `${icon}${b.noteLeft ? ` <span class="hu-360-sla-due-text">${escapeHtml(b.noteLeft)}</span>` : ''}`
            : escapeHtml(b.noteLeft);
          const hasSpare = b.pctTotalPx > b.pctUsedPx;
          return `
          <div class="hu-360-sla-row" style="flex:${sharePct} 1 0" title="${escapeHtml(b.label + ': ' + tipText + ' (' + formatDurationShort(b.durationMs) + ' SLA)')}">
            <div class="hu-360-sla-label-row">
              <span class="hu-360-sla-label">${escapeHtml(b.label)}</span>
              <span class="hu-360-sla-due ${b.cls}">${noteHtml}</span>
            </div>
            <div class="hu-360-sla-track">
              ${hasSpare ? `<div class="hu-360-sla-fill hu-360-sla-fill-spare ${b.cls}" style="width:${b.pctTotalPx}%;--sla-target-width:${b.pctTotalPx}%"></div>` : ''}
              <div class="hu-360-sla-fill ${b.cls}" style="width:${b.pctUsedPx}%;--sla-target-width:${b.pctUsedPx}%"></div>
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}

      <div class="hu-360-dates">
        <span class="hu-360-dates-k">Opened</span>
        <span class="hu-360-dates-v">${escapeHtml(formatDateTime(openedIso) || '--')}</span>
        <span class="hu-360-dates-k">${closedIso ? 'Closed' : 'Due'}</span>
        <span class="hu-360-dates-v">${escapeHtml(formatDateTime(closedIso || ticket.fixbydate) || '--')}</span>
      </div>`;

    // Async-replace the placeholder bar with real Halo workflow stages.
    if (ticket.workflow_id) {
      fetchWorkflowStages(ticket.workflow_id).then(stages => {
        if (!stages.length) return;
        const bar = sec.querySelector('[data-wf-bar]');
        const stepLabel = sec.querySelector('.hu-360-wf-step');
        if (!bar) return;
        // Resolve the current stage index: prefer matching the step NAME
        // (most reliable), then fall back to workflow_seq.
        const nameLc = String(ticket.workflow_step || '').toLowerCase();
        let idx = stages.findIndex(s => String(s.name).toLowerCase() === nameLc);
        if (idx < 0) idx = Math.min(stages.length - 1, Math.max(0, current - 1));
        const names = stages.map(s => s.name);
        bar.innerHTML = segmentsHtml(stages.length, idx + 1, names);
        // Pulse only while the workflow is still progressing — drop the
        // is-active flag once we know the ticket is on the final stage,
        // even if the close date hasn't been written yet.
        if (idx >= stages.length - 1) bar.classList.remove('is-active');
        if (stepLabel) {
          const stepName = stages[idx]?.name || ticket.workflow_step || '';
          stepLabel.textContent = `${stepName ? stepName + ' · ' : ''}Step ${idx + 1} of ${stages.length}`;
        }
      }).catch(() => {});
    }
    return sec;
  }

  // Short "2d" / "24h" / "45m" / "30s" formatter for SLA bar notes. Uses
  // round (not floor) on the hour/day boundary so a 23h 59m remainder reads
  // as "24h" rather than "23h" — closer to what a human reading the SLA
  // expects to see at the 1-day-out mark.
  function formatDurationShort(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0s';
    if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  // SLA status icon — green check for met-on-time, red cross for breached
  // (both met-late and live past-due). Empty for plain text states.
  function slaStatusIconHtml(state) {
    if (state === 'met') {
      return `<svg class="hu-sla-status-icon hu-sla-status-icon--met" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5"/></svg>`;
    }
    if (state === 'breached') {
      // Filled disc + white X cutout — reads as a "rejected" badge with
      // strong contrast against the green-check counterpart.
      return `<svg class="hu-sla-status-icon hu-sla-status-icon--breached" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M4 4l4 4M8 4l-4 4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    }
    return '';
  }

  // Custom fields — Halo's per-ticket-type fields with their current values.
  // For a Laptop Request these contain "Laptop Type: Standard", "Justification: ...",
  // etc. Currently invisible without this card. Filter out empties and Halo's
  // own internal/system fields.
  function renderTicket360CustomFields(ticket) {
    const fields = Array.isArray(ticket.customfields) ? ticket.customfields : [];
    const rows = fields.map(f => {
      const label = String(f.label || f.name || '').trim();
      const display = String(f.display || '').trim();
      if (!label || !display) return null;
      // Skip fields that mirror the summary or details (would just be noise).
      if (/^description$|^summary$|^details$/i.test(label)) return null;
      return { label, display };
    }).filter(Boolean);

    if (!rows.length) return null;

    const card = document.createElement('div');
    card.className = 'hu-card hu-360-custom-fields';
    card.style.marginBottom = '10px';
    card.innerHTML = `<div class="hu-section-title">Custom fields <span class="hu-360-field-count">${rows.length}</span></div>`;
    const grid = document.createElement('div');
    grid.className = 'hu-360-cf-grid';
    rows.forEach(r => {
      const cell = document.createElement('div');
      cell.className = 'hu-360-cf-cell';
      cell.innerHTML = `<div class="hu-360-cf-label">${escapeHtml(r.label)}</div>
        <div class="hu-360-cf-value">${escapeHtml(r.display)}</div>`;
      grid.appendChild(cell);
    });
    card.appendChild(grid);
    return card;
  }

  // Status transitions mini-timeline — pluck "status change" actions from the
  // action list and show them as a horizontal stepper. Tells the agent at a
  // glance how the ticket has moved through the workflow over time.
  function renderTicket360StatusTransitions(actions) {
    const transitions = (actions || []).filter(a => {
      const o = String(a['Outcome'] || '').toLowerCase();
      return /status|changed.*status|transition|reopen|resolved|closed/.test(o);
    }).slice(-6);
    if (transitions.length < 2) return null;

    const card = document.createElement('div');
    card.className = 'hu-card hu-360-transitions';
    card.style.marginBottom = '10px';
    card.innerHTML = '<div class="hu-section-title">Status history</div>';
    const track = document.createElement('div');
    track.className = 'hu-360-trans-track';
    transitions.forEach((a, i) => {
      const isLast = i === transitions.length - 1;
      track.innerHTML += `
        <div class="hu-360-trans-step">
          <div class="hu-360-trans-dot"></div>
          <div class="hu-360-trans-label">${escapeHtml(String(a['Outcome'] || '').replace(/^status\s*/i, ''))}</div>
          <div class="hu-360-trans-time">${escapeHtml(timeAgo(a['When']))}</div>
        </div>
        ${isLast ? '' : '<div class="hu-360-trans-arrow">→</div>'}`;
    });
    card.appendChild(track);
    return card;
  }

  // KB suggestion — if Halo's ticket-rule matched a KB article, show it here
  // so the agent doesn't have to search. One extra /api/KBArticle/{id} call.
  async function renderTicket360KbSuggestion(ticket) {
    const kbId = Number(ticket.matched_kb_id || 0);
    if (!kbId) return null;
    try {
      const kb = await haloApiRequest(`/api/KBArticle/${kbId}?includedetails=true`);
      if (!kb || !kb.id) return null;
      const title = String(kb.name || kb.title || kb.abstract || `KB #${kb.id}`).trim();
      const abstract = String(kb.abstract || kb.description || '').trim();
      const card = document.createElement('div');
      card.className = 'hu-card hu-360-kb';
      card.style.marginBottom = '10px';
      card.innerHTML = `
        <div class="hu-section-title-row">
          <span class="hu-section-title" style="margin:0">📘 Suggested KB article</span>
          <a href="/kb?id=${escapeHtml(String(kb.id))}" class="hu-360-kb-open hu-spa-link">Open</a>
        </div>
        <div class="hu-360-kb-title">${escapeHtml(title)}</div>
        ${abstract ? `<div class="hu-360-kb-abstract">${escapeHtml(abstract.slice(0, 240))}${abstract.length > 240 ? '…' : ''}</div>` : ''}`;
      return card;
    } catch (_) {
      return null;
    }
  }

  // Linked records — children, parent, assets, same-user open tickets. All
  // fetched in parallel; renders a compact chip row that links into Halo.
  async function renderTicket360LinkedRecords(ticket) {
    const ticketId = Number(ticket.id);
    const userId   = Number(ticket.user_id || 0);
    const parentId = Number(ticket.createdfrom_id || 0);
    const probes = [
      // Child tickets created from this one.
      haloApiRequest(`/api/tickets?parent_id=${ticketId}&count=20&open_only=false`).catch(() => null),
      // Other open tickets from the same user (excluding this one).
      userId ? haloApiRequest(`/api/tickets?user_id=${userId}&count=20&open_only=true`).catch(() => null) : null,
      // Assets linked to this ticket (where supported).
      haloApiRequest(`/api/asset?ticket_id=${ticketId}&count=20`).catch(() => null)
    ];
    const [childResp, userResp, assetResp] = await Promise.all(probes);

    const children = extractEntityList(childResp || {}, 'tickets').filter(t => Number(t.id) !== ticketId);
    const userTickets = extractEntityList(userResp || {}, 'tickets').filter(t => Number(t.id) !== ticketId);
    const assets = extractEntityList(assetResp || {}, 'assets');

    if (!children.length && !userTickets.length && !assets.length && !parentId) return null;

    const card = document.createElement('div');
    card.className = 'hu-card hu-360-linked';
    card.style.marginBottom = '10px';
    card.innerHTML = '<div class="hu-section-title">Linked records</div>';

    const addGroup = (label, items, urlFor) => {
      if (!items?.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'hu-360-linked-group';
      wrap.innerHTML = `<div class="hu-360-linked-label">${escapeHtml(label)} <span class="hu-360-linked-count">${items.length}</span></div>`;
      const chips = document.createElement('div');
      chips.className = 'hu-360-linked-chips';
      items.slice(0, 6).forEach(item => {
        const chip = document.createElement('a');
        chip.className = 'hu-360-linked-chip';
        chip.href = urlFor(item);
        chip.textContent = item._label || String(item.summary || item.name || `#${item.id}`);
        chip.title = item._title || chip.textContent;
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);
      card.appendChild(wrap);
    };

    if (parentId) {
      addGroup('Parent', [{ id: parentId, summary: `Ticket #${parentId}` }],
        t => new URL(`/tickets?id=${t.id}`, window.location.origin).href);
    }
    addGroup('Children', children, t => new URL(`/tickets?id=${t.id}`, window.location.origin).href);
    addGroup('Open tickets from this user', userTickets, t => new URL(`/tickets?id=${t.id}`, window.location.origin).href);
    addGroup('Linked assets', assets, a => new URL(`/assets?id=${a.id}`, window.location.origin).href);

    // Cross-entity linked objects (changes, problems, releases, opportunities)
    // come from the `includelinkedobjects=true` query param. Halo flattens
    // them onto the ticket as `linked_objects` — an array of typed records
    // with `id`, `objecttype`, and `summary`.
    const linkedObjects = Array.isArray(ticket.linked_objects) ? ticket.linked_objects
      : Array.isArray(ticket.linkedobjects) ? ticket.linkedobjects : [];
    if (linkedObjects.length) {
      // Group by object type so the section reads cleanly with multiple
      // kinds of links (e.g. one change + two problems).
      const byType = {};
      linkedObjects.forEach(lo => {
        const t = String(lo?.objecttype || lo?.type || 'Related').trim() || 'Related';
        if (!byType[t]) byType[t] = [];
        byType[t].push(lo);
      });
      Object.entries(byType).forEach(([typeName, items]) => {
        addGroup(typeName, items.map(it => ({
          id: it.id,
          summary: it.summary || it.name || ('#' + it.id)
        })), it => new URL(`/tickets?id=${it.id}`, window.location.origin).href);
      });
    }

    // If every group was skipped (filtered to empty by addGroup), drop the
    // section so the user doesn't see a header with no content.
    if (!card.querySelector('.hu-360-linked-group')) return null;
    return card;
  }

  // Similar tickets — search using the first few words of the summary; show
  // resolved-time average. Cheap triage hint: "this looks like 3 we just
  // solved — here's how long they took."
  async function renderTicket360SimilarTickets(ticket) {
    const summary = String(ticket.summary || '').trim();
    const words = summary.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(' ');
    if (!words) return null;
    try {
      const resp = await haloApiRequest(
        `/api/tickets?search=${encodeURIComponent(words)}&count=10&open_only=false`
      );
      const items = extractEntityList(resp, 'tickets')
        .filter(t => Number(t.id) !== Number(ticket.id));
      if (!items.length) return null;

      // Compute average resolution time for closed similar tickets.
      const closed = items.filter(t => t.dateclosed && t.dateoccurred);
      let avgNote = '';
      if (closed.length) {
        const ms = closed.reduce((sum, t) => {
          return sum + (parseHaloDate(t.dateclosed).getTime() - parseHaloDate(t.dateoccurred).getTime());
        }, 0) / closed.length;
        const hours = ms / 3_600_000;
        avgNote = hours < 24
          ? `${hours.toFixed(1)}h avg`
          : `${(hours / 24).toFixed(1)}d avg`;
      }

      const card = document.createElement('div');
      card.className = 'hu-card hu-360-similar';
      card.style.marginBottom = '10px';
      card.innerHTML = `
        <div class="hu-section-title-row">
          <span class="hu-section-title" style="margin:0">Similar tickets</span>
          ${avgNote ? `<span class="hu-360-similar-avg">${escapeHtml(closed.length)} resolved · ${escapeHtml(avgNote)}</span>` : ''}
        </div>`;
      items.slice(0, 4).forEach(t => {
        const row = document.createElement('a');
        row.className = 'hu-360-similar-row';
        row.href = new URL(`/tickets?id=${t.id}`, window.location.origin).href;
        const isOpen = !t.dateclosed;
        row.innerHTML = `
          <span class="hu-360-similar-dot" style="background:${isOpen ? '#3b82f6' : '#6b7280'}"></span>
          <span class="hu-360-similar-title">${escapeHtml(String(t.summary || `#${t.id}`).slice(0, 80))}</span>
          <span class="hu-360-similar-meta">${escapeHtml(isOpen ? 'Open' : timeAgo(t.dateclosed))}</span>`;
        card.appendChild(row);
      });
      return card;
    } catch (_) {
      return null;
    }
  }

  // First-letter initials, max 2. Avatars in the People section.
  function avatarInitials(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s.charAt(0).toUpperCase()).join('') || '?';
  }

  // Halo stores agent/user images under several different field names
  // depending on tenant version. Try them all; resolve relative paths
  // against the current origin so they load over the same TLS session.
  // Agent records carry `agentphotodata` (base64 data URI) plus
  // `agentphotopath` (relative path like /AgentImage/<hash>.jpg).
  function findHaloImageUrl(record) {
    if (!record || typeof record !== 'object') return '';
    const candidates = [
      record.agentphotodata, record.agentphotopath,
      record.userphotodata, record.userphotopath,
      record.photodata, record.photopath, record.photourl,
      record.image_url, record.imageurl, record.image_path, record.imagepath,
      record.iconpath, record.icon_path, record.icon_url, record.iconurl,
      record.agentimage, record.agentimagepath, record.agent_image,
      record.picture_url, record.picture, record.profile_image,
      record.images?.medium?.url, record.images?.small?.url, record.images?.original?.url
    ];
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Inline data URIs render as-is.
      if (/^data:image\//i.test(trimmed)) return trimmed;
      // Absolute http(s) URLs.
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      // Same-origin relative path.
      if (trimmed.startsWith('/')) return new URL(trimmed, window.location.origin).href;
      if (/^[\w./-]+$/.test(trimmed)) return new URL('/' + trimmed.replace(/^\.?\//, ''), window.location.origin).href;
    }
    return '';
  }

  // Fetch an agent record from /api/agent/{id}?includedetails=true so the
  // image fields are populated (the cache_agent localStorage cache doesn't
  // carry them on most tenants). Cached per session, per agent id.
  async function fetchAgentDetail(agentId) {
    const id = Number(agentId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!HU._agentDetailCache) HU._agentDetailCache = new Map();
    if (HU._agentDetailCache.has(id)) return HU._agentDetailCache.get(id);
    const promise = (async () => {
      try {
        return await haloApiRequest(`/api/agent/${id}?includedetails=true&isagentconfig=true`);
      } catch (_) {
        return null;
      }
    })();
    HU._agentDetailCache.set(id, promise);
    return promise;
  }

  async function fetchUserDetail(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (!HU._userDetailCache) HU._userDetailCache = new Map();
    if (HU._userDetailCache.has(id)) return HU._userDetailCache.get(id);
    const promise = (async () => {
      try {
        return await haloApiRequest(`/api/users/${id}?includedetails=true`);
      } catch (_) {
        return null;
      }
    })();
    HU._userDetailCache.set(id, promise);
    return promise;
  }

  // Swap initials → <img> on an avatar element. On image-load failure
  // (404, etc.) fall back to the initials so the slot never goes blank.
  function decorateAvatarWithImage(avatarEl, name, imageUrl) {
    if (!avatarEl || !imageUrl) return;
    avatarEl.textContent = '';
    avatarEl.classList.add('hu-360-avatar--img');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = imageUrl;
    img.addEventListener('error', () => {
      avatarEl.classList.remove('hu-360-avatar--img');
      img.remove();
      avatarEl.textContent = avatarInitials(name);
    });
    avatarEl.appendChild(img);
  }

  // People section: two rows (Customer + Assignee) with avatar circles and
  // parallel name/sub layout. Returns a complete .hu-360-sec.
  function renderTicket360PeopleSection(ticket, summary, ticketId) {
    const sec = document.createElement('section');
    sec.className = 'hu-360-sec hu-360-people';
    const header = document.createElement('div');
    header.className = 'hu-360-sec-h';
    header.textContent = 'People';
    sec.appendChild(header);

    // Customer row (end user → client → site).
    const userName    = summary['End User'] || '';
    const userId      = summary['User ID']  || 0;
    const clientName  = summary['Client']   || '';
    const clientId    = summary['Client ID']|| 0;
    const siteName    = summary['Site']     || '';
    const siteId      = summary['Site ID']  || 0;

    const customer = document.createElement('div');
    customer.className = 'hu-360-person hu-360-person--clickable';
    customer.setAttribute('role', 'button');
    customer.setAttribute('tabindex', '0');
    customer.setAttribute('aria-label', 'Change customer');
    const subParts = [];
    if (clientId)   subParts.push(`<a href="${escapeHtml(routeDetail('customer', clientId))}" class="hu-spa-link">${escapeHtml(clientName || 'Client')}</a>`);
    else if (clientName) subParts.push(escapeHtml(clientName));
    if (siteId)     subParts.push(`<a href="${escapeHtml(routeDetail('site', siteId))}" class="hu-spa-link">${escapeHtml(siteName || 'Site')}</a>`);
    else if (siteName)   subParts.push(escapeHtml(siteName));
    const subHtml = subParts.length ? subParts.join('<span class="hu-360-cust-sep">·</span>') : '';

    // VIP / important-contact marker — small star (VIP) or shield (important)
    // next to the customer name. Tooltip explains which signal triggered it.
    const isVip = ticket.is_vip || ticket.user?.is_vip || ticket.user?.client?.is_vip;
    const isImportant = ticket.isimportantcontact || ticket.user?.isimportantcontact;
    let marker = '';
    if (isVip) {
      marker = `<span class="hu-360-cust-marker hu-360-cust-marker-vip" title="VIP customer">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" stroke="none"><path d="M8 1.5l1.85 4.4 4.65.4-3.5 3.1 1.1 4.6L8 11.6 3.9 14l1.1-4.6L1.5 6.3l4.65-.4z"/></svg>
        <span>VIP</span></span>`;
    } else if (isImportant) {
      marker = `<span class="hu-360-cust-marker hu-360-cust-marker-key" title="Key contact at this client">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 2l5 2v4c0 3-2.4 5-5 6-2.6-1-5-3-5-6V4z"/></svg>
        <span>Key contact</span></span>`;
    }

    customer.innerHTML = `
      <div class="hu-360-avatar hu-360-avatar-customer">${escapeHtml(avatarInitials(userName))}</div>
      <div class="hu-360-person-main">
        <div class="hu-360-person-label">Customer</div>
        <div class="hu-360-person-name">${userId
          ? `<a href="${escapeHtml(routeDetail('user', userId))}" class="hu-spa-link">${escapeHtml(userName || 'User')}</a>`
          : escapeHtml(userName || 'Unknown')}${marker}</div>
        ${subHtml ? `<div class="hu-360-person-sub">${subHtml}</div>` : ''}
      </div>
      <svg class="hu-360-person-caret" viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>`;
    // Clicks on the inner <a> (user/client/site profile links) should NOT
    // trigger the picker — let the link navigate normally.
    customer.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => e.stopPropagation());
    });
    const openCustomerPicker = () => openUserPicker(customer, ticketId, () => {
      // Halo will resolve client/site from the new user; trigger a refresh
      // so the whole drawer reflects the change.
      scheduleTicket360Refresh(0);
    });
    customer.addEventListener('click', e => {
      e.stopPropagation();
      openCustomerPicker();
    });
    customer.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCustomerPicker();
      }
    });
    // Customer avatar — try the user object on the ticket first, fall
    // back to /api/users/{id} for the image fields.
    {
      const av = customer.querySelector('.hu-360-avatar');
      const inline = findHaloImageUrl(ticket.user);
      if (inline) {
        decorateAvatarWithImage(av, userName, inline);
      } else if (userId) {
        fetchUserDetail(userId).then(u => {
          const url = findHaloImageUrl(u);
          if (url) decorateAvatarWithImage(av, userName, url);
        });
      }
    }
    sec.appendChild(customer);

    // Assignee row.
    const agentName = getCachedName('cache_agent', ticket.agent_id) ||
                      (ticket.agent_name ? String(ticket.agent_name) : '') ||
                      (ticket.agent_id ? `Agent ${ticket.agent_id}` : 'Unassigned');
    const team = (ticket.team && typeof ticket.team === 'object' ? ticket.team.name : ticket.team) || '';

    const assignee = document.createElement('div');
    assignee.className = 'hu-360-person hu-360-person--clickable';
    assignee.setAttribute('role', 'button');
    assignee.setAttribute('tabindex', '0');
    assignee.setAttribute('aria-label', 'Change assignee');
    assignee.innerHTML = `
      <div class="hu-360-avatar hu-360-avatar-agent">${escapeHtml(avatarInitials(agentName))}</div>
      <div class="hu-360-person-main">
        <div class="hu-360-person-label">Assigned to</div>
        <div class="hu-360-person-name hu-360-assignee-name">${escapeHtml(agentName)}</div>
        ${team ? `<div class="hu-360-person-sub">${escapeHtml(team)}</div>` : ''}
      </div>
      <svg class="hu-360-person-caret" viewBox="0 0 10 6" width="10" height="6" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>`;
    const openAssignPicker = () => {
      openAgentPicker(assignee, ticketId, newAgent => {
        // Update name + avatar in place.
        const n = newAgent.name || `Agent ${newAgent.id}`;
        assignee.querySelector('.hu-360-assignee-name').textContent = n;
        const av = assignee.querySelector('.hu-360-avatar');
        av.classList.remove('hu-360-avatar--img');
        av.textContent = avatarInitials(n);
        const newUrl = findHaloImageUrl(newAgent);
        if (newUrl) decorateAvatarWithImage(av, n, newUrl);
        ticket.agent_id = newAgent.id;
      });
    };
    assignee.addEventListener('click', e => {
      e.stopPropagation();
      openAssignPicker();
    });
    assignee.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAssignPicker();
      }
    });

    // Additional agents (smaller, line below).
    const extras = Array.isArray(ticket.additional_agents) ? ticket.additional_agents : [];
    if (extras.length) {
      const extraRow = document.createElement('div');
      extraRow.className = 'hu-360-person-sub hu-360-additional-agents';
      extraRow.style.marginLeft = '42px';
      const names = extras.slice(0, 4).map(a => {
        const id = typeof a === 'object' ? a.id : a;
        return (typeof a === 'object' && (a.name || a.agent_name)) ||
               getCachedName('cache_agent', id) || `Agent ${id}`;
      });
      const more = extras.length > 4 ? ` +${extras.length - 4} more` : '';
      extraRow.textContent = `+ ${names.join(', ')}${more}`;
      assignee.appendChild(extraRow);
    }

    // Assignee avatar — fetch the full agent record so image fields are
    // populated (cache_agent doesn't carry them on most tenants).
    if (ticket.agent_id) {
      const av = assignee.querySelector('.hu-360-avatar');
      fetchAgentDetail(ticket.agent_id).then(a => {
        const url = findHaloImageUrl(a);
        if (url) decorateAvatarWithImage(av, agentName, url);
      });
    }
    sec.appendChild(assignee);
    return sec;
  }

  // Position a popover near a trigger element, flipping/clamping when it
  // would fall outside the viewport. Used for both the agent picker and
  // the status/priority choice picker.
  function positionPopover(pop, triggerEl, minWidth) {
    const rect = triggerEl.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = rect.left + 'px';
    pop.style.top  = rect.bottom + 4 + 'px';
    pop.style.minWidth = Math.max(rect.width, minWidth || 200) + 'px';
    pop.style.maxWidth = (window.innerWidth - 16) + 'px';
    // Measure once attached, then adjust.
    requestAnimationFrame(() => {
      const popRect = pop.getBoundingClientRect();
      const pad = 8;
      let left = rect.left;
      let top  = rect.bottom + 4;
      // Right-edge overflow → align the popover's right edge with the trigger.
      if (left + popRect.width > window.innerWidth - pad) {
        left = Math.max(pad, Math.min(rect.right - popRect.width, window.innerWidth - popRect.width - pad));
      }
      if (left < pad) left = pad;
      // Bottom overflow → flip above the trigger.
      if (top + popRect.height > window.innerHeight - pad) {
        const above = rect.top - popRect.height - 4;
        top = above > pad ? above : pad;
      }
      pop.style.left = left + 'px';
      pop.style.top  = top + 'px';
    });
  }

  // Searchable agent picker popover. Anchored below the trigger (flips above
  // if it'd fall off-screen). Live /api/agent search; results are grouped by
  // team, so an agent in multiple teams appears under each.
  function openAgentPicker(triggerEl, ticketId, onSelect) {
    closeAgentPicker();
    const pop = document.createElement('div');
    pop.className = 'hu-360-agent-pop';
    pop.innerHTML = `
      <input type="text" class="hu-360-agent-search" placeholder="Search agents..." autocomplete="off">
      <div class="hu-360-agent-list" role="listbox"></div>
      <div class="hu-360-agent-status"></div>`;
    document.body.appendChild(pop);
    positionPopover(pop, triggerEl, 280);
    HU._agentPicker = pop;

    const input = pop.querySelector('.hu-360-agent-search');
    const list  = pop.querySelector('.hu-360-agent-list');
    const status = pop.querySelector('.hu-360-agent-status');
    input.focus();

    // Cache the full agent list on first run so subsequent keystrokes filter
    // client-side. Filtering matches BOTH agent name and team-name — letting
    // the user type "1st" to narrow to a whole team. The server-side
    // ?search= param only matches names, missing this use case.
    let allAgents = null;
    let searchToken = 0;
    const runSearch = async (term) => {
      const myToken = ++searchToken;
      status.textContent = 'Searching…';
      list.innerHTML = '';
      try {
        if (!allAgents) {
          // includedetails so the teams[] array comes back populated — without
          // it Halo only returns the agent's primary team string.
          const resp = await haloApiRequest(`/api/agent?count=500&includedetails=true`);
          allAgents = extractEntityList(resp, 'agents');
        }
        if (myToken !== searchToken) return;

        // Halo's agent record can express team membership via several keys
        // depending on tenant version + whether includedetails was passed.
        // Try them all and resolve any bare IDs via cache_team to get names.
        const teamCache = readHaloCacheLookup('cache_team');
        const teamLookup = (idOrObj) => {
          if (idOrObj == null) return null;
          if (typeof idOrObj === 'object') {
            // Halo's agent.teams[] entries are membership records where
            // `id` is the row id and `team_id` is the actual team. Always
            // prefer team_id; otherwise we'd patch the ticket with the
            // membership row id and Halo would silently reassign.
            const rawId = idOrObj.team_id != null ? idOrObj.team_id : idOrObj.id;
            const id = rawId != null ? Number(rawId) : null;
            return { id: Number.isFinite(id) ? id : null,
                     name: String(idOrObj.team_name || idOrObj.name || '').trim() };
          }
          const id = Number(idOrObj);
          if (!Number.isFinite(id)) return null;
          const row = teamCache?.get(id);
          return { id, name: row ? String(row.name || row.team_name || '').trim() : '' };
        };
        const collectTeams = (a) => {
          const result = [];
          // Multi-team arrays (different field names on different Halo versions).
          const sources = [a.teams, a.team_list, a.allowedteams, a.team_ids, a.extteamids];
          for (const src of sources) {
            if (!Array.isArray(src) || !src.length) continue;
            src.forEach(item => {
              const t = teamLookup(item);
              if (t && (t.name || t.id != null)) result.push(t);
            });
          }
          // Primary team (single string or object) — make sure it's in the list.
          if (a.team) {
            const primary = teamLookup(typeof a.team === 'object' ? a.team : { id: a.team_id, name: a.team });
            if (primary && !result.some(r => r.id === primary.id || r.name === primary.name)) {
              result.push(primary);
            }
          } else if (a.team_id != null) {
            const primary = teamLookup(a.team_id);
            if (primary && !result.some(r => r.id === primary.id)) result.push(primary);
          }
          // Sort entries WITH ids first so the dedup keeps the id-bearing
          // copy. Otherwise an "id:null, name:X" sibling would land first
          // and the user's pick would patch with no team_id — Halo would
          // then fall back to the agent's *default* team, not the team
          // they clicked.
          result.sort((a, b) => (a.id == null ? 1 : 0) - (b.id == null ? 1 : 0));
          // De-dupe by EITHER id OR normalized name.
          const seenIds = new Set();
          const seenNames = new Set();
          return result.filter(t => {
            if (!t.name && t.id == null) return false;
            const normName = String(t.name || '').toLowerCase().trim();
            if (t.id != null && seenIds.has(t.id)) return false;
            if (normName && seenNames.has(normName)) return false;
            if (t.id != null) seenIds.add(t.id);
            if (normName) seenNames.add(normName);
            return true;
          });
        };

        // Filter the cached list by the search term (matches agent name OR
        // team name) before expanding into per-team rows. The "Unassigned"
        // virtual agent (id 0 / name "Unassigned") isn't useful here — it
        // represents the no-assignment state, not an actual agent.
        const lc = String(term || '').toLowerCase().trim();
        const filtered = (!lc ? allAgents : allAgents.filter(a => {
          const name = String(a.name || '').toLowerCase();
          if (name.includes(lc)) return true;
          const email = String(a.email || a.emailaddress || '').toLowerCase();
          if (email.includes(lc)) return true;
          return collectTeams(a).some(t => String(t.name || '').toLowerCase().includes(lc));
        })).filter(a => {
          if (Number(a.id) === 0) return false;
          if (/^unassigned$/i.test(String(a.name || '').trim())) return false;
          return true;
        });

        list.innerHTML = '';
        if (!filtered.length) {
          status.textContent = 'No agents found.';
          return;
        }
        status.textContent = '';

        // Expand each agent into one row per team membership, then group rows
        // by team name. Agents in multiple teams appear under each team header.
        const byTeam = new Map();
        const unassigned = [];
        filtered.forEach(a => {
          const teams = collectTeams(a);
          if (!teams.length) { unassigned.push({ agent: a, team: null }); return; }
          // Dedupe by agent + visible team NAME. Two Halo team records
          // with the same display name (e.g. legacy duplicates) collapse
          // to a single row from the user's perspective.
          const seenPair = new Set();
          teams.forEach(t => {
            const groupName = t.name || '(No team)';
            const pairKey = `${a.id}|${groupName.toLowerCase().trim()}`;
            if (seenPair.has(pairKey)) return;
            seenPair.add(pairKey);
            if (!byTeam.has(groupName)) byTeam.set(groupName, []);
            byTeam.get(groupName).push({ agent: a, team: t });
          });
        });

        // Render: sorted team headers, then agent rows under each.
        const sortedTeams = Array.from(byTeam.keys()).sort((a, b) => a.localeCompare(b));
        sortedTeams.forEach(teamName => {
          const hdr = document.createElement('div');
          hdr.className = 'hu-360-agent-team-hdr';
          hdr.textContent = teamName;
          list.appendChild(hdr);
          byTeam.get(teamName)
            .sort((a, b) => String(a.agent.name || '').localeCompare(String(b.agent.name || '')))
            .forEach(({ agent, team }) => list.appendChild(buildAgentRow(agent, team)));
        });
        if (unassigned.length) {
          const hdr = document.createElement('div');
          hdr.className = 'hu-360-agent-team-hdr';
          hdr.textContent = 'No team';
          list.appendChild(hdr);
          unassigned.forEach(({ agent, team }) => list.appendChild(buildAgentRow(agent, team)));
        }

        function buildAgentRow(a, team) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'hu-360-agent-row';
          row.innerHTML = `
            <span class="hu-360-agent-name">${escapeHtml(a.name || `Agent ${a.id}`)}</span>
            ${team && team.name ? `<span class="hu-360-agent-team">${escapeHtml(team.name)}</span>` : ''}`;
          row.addEventListener('click', async () => {
            row.disabled = true;
            status.textContent = 'Assigning…';
            try {
              // Patch with agent_id + both team_id AND team name.
              // Halo's update accepts either, but if team_id is missing it
              // falls back to the agent's default team — which is wrong
              // when the user explicitly picked an agent under a different
              // team membership.
              const patch = { agent_id: Number(a.id) };
              if (team) {
                if (team.id != null) patch.team_id = Number(team.id);
                if (team.name) patch.team = String(team.name);
              }
              await updateTicketField(ticketId, patch);
              onSelect?.(a, team);
              closeAgentPicker();
            } catch (e) {
              status.textContent = 'Update failed — ' + (e?.message || 'unknown error');
              row.disabled = false;
            }
          });
          return row;
        }
      } catch (e) {
        if (myToken !== searchToken) return;
        status.textContent = 'Search failed.';
      }
    };

    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(input.value.trim()), 180);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeAgentPicker(); }
      if (e.key === 'ArrowDown') { list.querySelector('button')?.focus(); e.preventDefault(); }
    });
    // Initial unfiltered list of agents.
    runSearch('');

    // Click-outside to close.
    setTimeout(() => {
      const outsideHandler = (e) => {
        if (!pop.contains(e.target) && e.target !== triggerEl) closeAgentPicker();
      };
      pop._outsideHandler = outsideHandler;
      document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
  }

  function closeAgentPicker() {
    const pop = HU._agentPicker;
    if (!pop) return;
    if (pop._outsideHandler) document.removeEventListener('mousedown', pop._outsideHandler, true);
    pop.remove();
    HU._agentPicker = null;
  }

  // Customer picker — server-side search of /api/users. Reuses the agent-pop
  // chrome so styling stays consistent. Selected user patches the ticket with
  // user_id (and client_id/site_id when known, so Halo doesn't fall back to
  // the user's default client).
  function openUserPicker(triggerEl, ticketId, onSelect) {
    closeAgentPicker();
    const pop = document.createElement('div');
    pop.className = 'hu-360-agent-pop';
    pop.innerHTML = `
      <input type="text" class="hu-360-agent-search" placeholder="Search customers (name or email)..." autocomplete="off">
      <div class="hu-360-agent-list" role="listbox"></div>
      <div class="hu-360-agent-status">Type at least 2 characters to search.</div>`;
    document.body.appendChild(pop);
    positionPopover(pop, triggerEl, 320);
    HU._agentPicker = pop;

    const input = pop.querySelector('.hu-360-agent-search');
    const list  = pop.querySelector('.hu-360-agent-list');
    const status = pop.querySelector('.hu-360-agent-status');
    input.focus();

    let searchToken = 0;
    const runSearch = async (term) => {
      const myToken = ++searchToken;
      const lc = String(term || '').trim();
      list.innerHTML = '';
      if (lc.length < 2) {
        status.textContent = 'Type at least 2 characters to search.';
        return;
      }
      status.textContent = 'Searching…';
      try {
        const resp = await haloApiRequest(
          `/api/users?count=50&includeinactive=false&search=${encodeURIComponent(lc)}`
        );
        if (myToken !== searchToken) return;
        const users = extractEntityList(resp, 'users');
        if (!users.length) {
          status.textContent = 'No customers found.';
          return;
        }
        status.textContent = '';
        users.forEach(u => list.appendChild(buildUserRow(u)));
      } catch (e) {
        if (myToken !== searchToken) return;
        status.textContent = 'Search failed.';
      }
    };

    function buildUserRow(u) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hu-360-agent-row';
      const name = u.name || u.firstname || `User ${u.id}`;
      const email = u.emailaddress || u.email || '';
      const client = (u.client && typeof u.client === 'object' ? u.client.name : '') || u.client_name || '';
      const subParts = [email, client].filter(Boolean);
      row.innerHTML = `
        <span class="hu-360-agent-name">${escapeHtml(name)}</span>
        ${subParts.length ? `<span class="hu-360-agent-team">${escapeHtml(subParts.join(' · '))}</span>` : ''}`;
      row.addEventListener('click', async () => {
        row.disabled = true;
        status.textContent = 'Updating…';
        try {
          const patch = { user_id: Number(u.id) };
          if (u.client_id != null) patch.client_id = Number(u.client_id);
          else if (u.client && typeof u.client === 'object' && u.client.id != null) {
            patch.client_id = Number(u.client.id);
          }
          if (u.site_id != null) patch.site_id = Number(u.site_id);
          else if (u.site && typeof u.site === 'object' && u.site.id != null) {
            patch.site_id = Number(u.site.id);
          }
          await updateTicketField(ticketId, patch);
          onSelect?.(u);
          closeAgentPicker();
        } catch (e) {
          status.textContent = 'Update failed — ' + (e?.message || 'unknown error');
          row.disabled = false;
        }
      });
      return row;
    }

    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(input.value), 220);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeAgentPicker(); }
      if (e.key === 'ArrowDown') { list.querySelector('button')?.focus(); e.preventDefault(); }
    });

    setTimeout(() => {
      const outsideHandler = (e) => {
        if (!pop.contains(e.target) && e.target !== triggerEl && !triggerEl.contains(e.target)) closeAgentPicker();
      };
      pop._outsideHandler = outsideHandler;
      document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
  }

  async function updateTicketAssignedAgent(ticketId, agentId) {
    // Halo's update pattern: POST /api/tickets with an array containing the
    // updated ticket object (with id). Other fields aren't touched server-side.
    return await haloApiRequest('/api/tickets', {
      method: 'POST',
      body: [{ id: Number(ticketId), agent_id: Number(agentId) }]
    });
  }

  // Inline note editor — shown when the Note button is clicked. Saves via
  // POST /api/actions and renders a confirmation row. Doesn't navigate away.
  // Re-clicking the same Note button while the editor is open closes it.
  function openInlineNoteEditor(anchorEl, ticketId, onSaved) {
    if (HU._noteEditor && HU._noteEditor.dataset.kind === 'note') {
      closeInlineNoteEditor();
      return;
    }
    closeInlineNoteEditor();
    const wrap = document.createElement('div');
    wrap.className = 'hu-360-note-editor';
    wrap.dataset.kind = 'note';
    wrap.innerHTML = `
      <textarea class="hu-360-note-text" rows="4" placeholder="Add a note for this ticket... type @ to mention an agent"></textarea>
      <div class="hu-360-note-actions">
        <label class="hu-360-note-visibility">
          <input type="checkbox" class="hu-360-note-hidden"> Hidden from end user
        </label>
        <div class="hu-360-note-btns">
          <button type="button" class="hu-360-note-cancel">Cancel</button>
          <button type="button" class="hu-360-note-save">Save note</button>
        </div>
      </div>
      <div class="hu-360-note-status"></div>`;
    anchorEl.insertAdjacentElement('afterend', wrap);
    HU._noteEditor = wrap;

    const ta = wrap.querySelector('.hu-360-note-text');
    const status = wrap.querySelector('.hu-360-note-status');
    const mentions = [];
    ta.focus();

    wireMentionAutocomplete(ta, mentions);

    wrap.querySelector('.hu-360-note-cancel').addEventListener('click', closeInlineNoteEditor);
    wrap.querySelector('.hu-360-note-save').addEventListener('click', async () => {
      const note = ta.value.trim();
      if (!note) { status.textContent = 'Note is empty.'; return; }
      const hidden = wrap.querySelector('.hu-360-note-hidden').checked;
      status.textContent = 'Saving…';
      try {
        const noteHtml = buildNoteHtmlWithMentions(ta.value, mentions);
        await haloApiRequest('/api/actions', {
          method: 'POST',
          body: [{
            ticket_id: Number(ticketId),
            outcome_id: 7,
            note,
            note_html: noteHtml,
            hiddenfromuser: hidden
          }]
        });
        closeInlineNoteEditor();
        onSaved?.();
      } catch (e) {
        status.textContent = 'Save failed — ' + (e?.message || 'unknown error');
      }
    });
  }
  function closeInlineNoteEditor() {
    closeMentionPicker();
    if (HU._noteEditorShield) { HU._noteEditorShield(); HU._noteEditorShield = null; }
    if (HU._noteEditor) { HU._noteEditor.remove(); HU._noteEditor = null; }
  }

  // @-mention autocomplete on a textarea. Detects `@query` at the cursor,
  // shows a picker filtered against the cached agent list, and on selection
  // inserts `@Display Name ` at the cursor + pushes {id, name} to `mentions`.
  // `buildNoteHtmlWithMentions` walks the saved text and converts each tracked
  // mention into Halo's chip span (data-mentionagent attr triggers the in-app
  // notification on the server side).
  function wireMentionAutocomplete(textarea, mentions) {
    let token = 0;

    // Halo's React app installs document-level keydown handlers that swallow
    // characters like `@` before they reach our textarea. Register a window-
    // level capture-phase listener so we fire ahead of Halo's listeners and
    // stop propagation for any keystroke targeting our textarea. The default
    // action (inserting the character) still happens.
    const shieldKeys = (e) => {
      if (e.target === textarea) e.stopPropagation();
    };
    window.addEventListener('keydown', shieldKeys, true);
    window.addEventListener('keypress', shieldKeys, true);
    window.addEventListener('keyup', shieldKeys, true);
    HU._noteEditorShield = () => {
      window.removeEventListener('keydown', shieldKeys, true);
      window.removeEventListener('keypress', shieldKeys, true);
      window.removeEventListener('keyup', shieldKeys, true);
    };

    const handleInput = () => {
      const trigger = detectMentionTrigger(textarea, mentions);
      if (!trigger) { closeMentionPicker(); return; }
      const myToken = ++token;
      loadMentionAgents().then(agents => {
        if (myToken !== token) return;
        const filtered = filterAgentsForMention(agents, trigger.query).slice(0, 8);
        showMentionPicker(textarea, trigger, filtered, mentions);
      });
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', e => {
      const picker = HU._mentionPicker;
      if (!picker) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionPickerActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionPickerActive(-1); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitActiveMention();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionPicker();
      }
    });
    textarea.addEventListener('blur', () => {
      setTimeout(() => {
        if (HU._mentionPicker && !HU._mentionPicker.pop.contains(document.activeElement)) {
          closeMentionPicker();
        }
      }, 120);
    });
  }

  function detectMentionTrigger(textarea, mentions) {
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return null;
    const text = textarea.value;
    const before = text.slice(0, pos);
    const match = before.match(/(?:^|[\s(])@([^\s@][^\n@]{0,40})?$/);
    if (!match) return null;
    const fullLen = match[0].length - (match[0].startsWith('@') ? 0 : 1);
    const atIndex = pos - fullLen;
    if (mentions && mentions.some(m => text.startsWith(`@${m.name}`, atIndex))) return null;
    return {
      query: (match[1] || '').trim(),
      atIndex,
      cursor: pos
    };
  }

  function loadMentionAgents() {
    if (!HU._mentionAgentsPromise) {
      HU._mentionAgentsPromise = haloApiRequest('/api/agent?count=500')
        .then(resp => extractEntityList(resp, 'agents') || [])
        .catch(() => []);
    }
    return HU._mentionAgentsPromise;
  }

  function filterAgentsForMention(agents, query) {
    const q = String(query || '').toLowerCase();
    const enabled = agents.filter(a => a && a.name && !a.inactive);
    if (!q) return enabled;
    const starts = [];
    const contains = [];
    for (const a of enabled) {
      const n = a.name.toLowerCase();
      if (n.startsWith(q)) starts.push(a);
      else if (n.includes(q)) contains.push(a);
    }
    return [...starts, ...contains];
  }

  function showMentionPicker(textarea, trigger, agents, mentions) {
    closeMentionPicker();
    const pop = document.createElement('div');
    pop.className = 'hu-360-mention-pop';
    const list = document.createElement('div');
    list.className = 'hu-360-mention-list';
    pop.appendChild(list);
    document.body.appendChild(pop);

    const rect = textarea.getBoundingClientRect();
    const POP_WIDTH = 260;
    const POP_HEIGHT = 220;
    const margin = 8;
    let left = rect.left + 8;
    let top = rect.bottom + 4;
    if (left + POP_WIDTH > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - POP_WIDTH - margin);
    }
    if (rect.bottom + POP_HEIGHT + margin > window.innerHeight) {
      top = Math.max(margin, rect.top - 4 - POP_HEIGHT);
    }
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';

    HU._mentionPicker = { pop, list, textarea, trigger, agents, active: 0, mentions };

    if (!agents.length) {
      const empty = document.createElement('div');
      empty.className = 'hu-360-mention-empty';
      empty.textContent = 'No matching agents';
      list.appendChild(empty);
      return;
    }

    agents.forEach((a, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hu-360-mention-row' + (i === 0 ? ' is-active' : '');
      const team = a.team || (Array.isArray(a.teams) && a.teams[0] && (a.teams[0].team_name || a.teams[0].name)) || '';
      row.innerHTML = `
        <span class="hu-360-mention-name"></span>
        ${team ? '<span class="hu-360-mention-team"></span>' : ''}
      `;
      row.querySelector('.hu-360-mention-name').textContent = a.name;
      if (team) row.querySelector('.hu-360-mention-team').textContent = team;
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        selectMention(i);
      });
      list.appendChild(row);
    });
  }

  function moveMentionPickerActive(delta) {
    const picker = HU._mentionPicker;
    if (!picker || !picker.agents.length) return;
    picker.active = (picker.active + delta + picker.agents.length) % picker.agents.length;
    picker.list.querySelectorAll('.hu-360-mention-row').forEach((r, i) => {
      r.classList.toggle('is-active', i === picker.active);
      if (i === picker.active) r.scrollIntoView({ block: 'nearest' });
    });
  }

  function commitActiveMention() {
    const picker = HU._mentionPicker;
    if (!picker || !picker.agents.length) return;
    selectMention(picker.active);
  }

  function selectMention(index) {
    const picker = HU._mentionPicker;
    if (!picker) return;
    const agent = picker.agents[index];
    if (!agent) { closeMentionPicker(); return; }
    const ta = picker.textarea;
    const { atIndex, cursor } = picker.trigger;
    const insertion = `@${agent.name} `;
    const newValue = ta.value.slice(0, atIndex) + insertion + ta.value.slice(cursor);
    ta.value = newValue;
    const newPos = atIndex + insertion.length;
    ta.selectionStart = ta.selectionEnd = newPos;
    picker.mentions.push({ id: Number(agent.id), name: agent.name, atIndex });
    closeMentionPicker();
    ta.focus();
  }

  function closeMentionPicker() {
    if (HU._mentionPicker) {
      HU._mentionPicker.pop.remove();
      HU._mentionPicker = null;
    }
  }

  function buildNoteHtmlWithMentions(plainText, mentions) {
    const consumed = [];
    // Prefer the original insertion position when it still matches — handles
    // the case where the user typed "@Name" literally elsewhere before picking
    // a mention for the same agent. Fall back to indexOf scanning only when
    // text edits have shifted the chip's position.
    for (const m of mentions) {
      const literal = `@${m.name}`;
      if (Number.isInteger(m.atIndex) && plainText.startsWith(literal, m.atIndex)) {
        const end = m.atIndex + literal.length;
        const overlap = consumed.some(c => !(end <= c.start || m.atIndex >= c.end));
        if (!overlap) {
          consumed.push({ start: m.atIndex, end, mention: m });
          continue;
        }
      }
      let from = 0;
      while (from <= plainText.length) {
        const idx = plainText.indexOf(literal, from);
        if (idx === -1) break;
        const end = idx + literal.length;
        const overlap = consumed.some(c => !(end <= c.start || idx >= c.end));
        if (!overlap) {
          consumed.push({ start: idx, end, mention: m });
          break;
        }
        from = idx + 1;
      }
    }
    consumed.sort((a, b) => a.start - b.start);
    let html = '';
    let cursor = 0;
    for (const c of consumed) {
      html += escapeHtml(plainText.slice(cursor, c.start));
      html += `<span data-mentionagent="${c.mention.id}" class="fr-deletable fr-tribute"><a>${escapeHtml('@' + c.mention.name)}</a></span>`;
      cursor = c.end;
    }
    html += escapeHtml(plainText.slice(cursor));
    return `<p>${html.replace(/\n/g, '<br>')}</p>`;
  }

  // Inline time-entry editor — adds a time-logged action to the ticket.
  // Mins input + optional note + Save/Cancel. POST /api/actions with the
  // shape Halo expects for a billable time entry. Toggles closed on
  // re-click of the Time button.
  function openInlineTimeEditor(anchorEl, ticketId, onSaved) {
    if (HU._noteEditor && HU._noteEditor.dataset.kind === 'time') {
      closeInlineNoteEditor();
      return;
    }
    closeInlineNoteEditor();  // reuses the note-editor slot/styling
    const wrap = document.createElement('div');
    wrap.className = 'hu-360-note-editor hu-360-time-editor';
    wrap.dataset.kind = 'time';
    wrap.innerHTML = `
      <div class="hu-360-time-row">
        <label class="hu-360-time-label">Minutes
          <input type="number" min="1" step="1" class="hu-360-time-mins" placeholder="15">
        </label>
        <label class="hu-360-time-label hu-360-time-label-grow">Description
          <input type="text" class="hu-360-time-desc" placeholder="What did you work on?">
        </label>
      </div>
      <div class="hu-360-note-actions">
        <label class="hu-360-note-visibility">
          <input type="checkbox" class="hu-360-note-hidden"> Hidden from end user
        </label>
        <div class="hu-360-note-btns">
          <button type="button" class="hu-360-note-cancel">Cancel</button>
          <button type="button" class="hu-360-note-save">Log time</button>
        </div>
      </div>
      <div class="hu-360-note-status"></div>`;
    anchorEl.insertAdjacentElement('afterend', wrap);
    HU._noteEditor = wrap;

    const mins = wrap.querySelector('.hu-360-time-mins');
    const desc = wrap.querySelector('.hu-360-time-desc');
    const status = wrap.querySelector('.hu-360-note-status');
    mins.focus();

    wrap.querySelector('.hu-360-note-cancel').addEventListener('click', closeInlineNoteEditor);
    wrap.querySelector('.hu-360-note-save').addEventListener('click', async () => {
      const m = Number(mins.value);
      if (!Number.isFinite(m) || m <= 0) { status.textContent = 'Enter minutes (positive integer).'; return; }
      const hidden = wrap.querySelector('.hu-360-note-hidden').checked;
      const note = String(desc.value || '').trim();
      status.textContent = 'Saving…';
      try {
        await haloApiRequest('/api/actions', {
          method: 'POST',
          body: [{
            ticket_id: Number(ticketId),
            // Halo stores timetaken in decimal hours, not minutes.
            timetaken: m / 60,
            note: note,
            hiddenfromuser: hidden,
            outcome: 'Time Logged'
          }]
        });
        closeInlineNoteEditor();
        onSaved?.();
      } catch (e) {
        status.textContent = 'Save failed — ' + (e?.message || 'unknown error');
      }
    });
  }

  // Status / priority picker — small popover anchored below the clicked chip.
  // Lists options from the localStorage cache; selecting one POSTs the
  // updated ticket and re-renders the chip in place.
  function openTicketChoicePicker(triggerEl, options, currentId, onSelect) {
    closeTicketChoicePicker();
    if (!options.length) return;
    const pop = document.createElement('div');
    pop.className = 'hu-360-choice-pop';
    pop.innerHTML = `<div class="hu-360-choice-list" role="listbox"></div>
                     <div class="hu-360-choice-status"></div>`;
    document.body.appendChild(pop);
    positionPopover(pop, triggerEl, 200);
    HU._choicePicker = pop;

    const list = pop.querySelector('.hu-360-choice-list');
    const status = pop.querySelector('.hu-360-choice-status');
    options.forEach(opt => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hu-360-choice-row' + (Number(opt.id) === Number(currentId) ? ' is-current' : '');
      const colour = opt.colour || opt.color || '';
      const safeColour = /^(#[0-9a-f]{3,8}|rgb)/i.test(String(colour).trim()) ? colour : '';
      row.innerHTML = `
        <span class="hu-360-choice-dot" ${safeColour ? `style="background:${safeColour}"` : ''}></span>
        <span class="hu-360-choice-name">${escapeHtml(opt.name || String(opt.id))}</span>`;
      row.addEventListener('click', async () => {
        row.disabled = true;
        status.textContent = 'Saving…';
        try {
          await onSelect(opt);
          closeTicketChoicePicker();
        } catch (e) {
          status.textContent = 'Update failed — ' + (e?.message || 'unknown');
          row.disabled = false;
        }
      });
      list.appendChild(row);
    });

    setTimeout(() => {
      const outside = e => { if (!pop.contains(e.target) && e.target !== triggerEl) closeTicketChoicePicker(); };
      pop._outsideHandler = outside;
      document.addEventListener('mousedown', outside, true);
    }, 0);
  }
  function closeTicketChoicePicker() {
    const pop = HU._choicePicker;
    if (!pop) return;
    if (pop._outsideHandler) document.removeEventListener('mousedown', pop._outsideHandler, true);
    pop.remove();
    HU._choicePicker = null;
  }

  async function updateTicketField(ticketId, patch) {
    setTicket360Loading(true);
    try {
      const result = await haloApiRequest('/api/tickets', {
        method: 'POST',
        body: [{ id: Number(ticketId), ...patch }]
      });
      scheduleTicket360Refresh(500);
      return result;
    } finally {
      // Loading is cleared by the refresh's own setTicket360Loading(false);
      // we don't clear it here to avoid a flicker between save-done and
      // refresh-start. The refresh re-asserts loading state anyway.
      setTimeout(() => {
        if (!HU._ticket360RefreshTimer) setTicket360Loading(false);
      }, 800);
    }
  }

  // Small spinner in the drawer header. Refcounted via HU._ticket360LoadingDepth
  // so concurrent writes (e.g. flag toggle while a save is still pending)
  // don't clear each other prematurely.
  function setTicket360Loading(on) {
    const drawer = document.getElementById('hu-ticket360-drawer');
    if (!drawer) return;
    if (typeof HU._ticket360LoadingDepth !== 'number') HU._ticket360LoadingDepth = 0;
    HU._ticket360LoadingDepth = Math.max(0, HU._ticket360LoadingDepth + (on ? 1 : -1));
    const visible = HU._ticket360LoadingDepth > 0;
    let indicator = drawer.querySelector('.hu-360-loading-indicator');
    if (visible) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'hu-360-loading-indicator';
        indicator.innerHTML = '<span class="hu-360-spinner" aria-label="Loading"></span>';
        const header = drawer.querySelector('.hu-drawer-header');
        const closeBtn = header?.querySelector('.hu-icon-btn');
        if (closeBtn) header.insertBefore(indicator, closeBtn);
        else header?.appendChild(indicator);
      }
    } else if (indicator) {
      indicator.remove();
    }
  }

  // Refresh helpers — re-render the Ticket 360 panel without rebuilding the
  // whole drawer when nothing changed. Driven by three triggers:
  //   1. After our own writes (status/priority/agent/flag/note).
  //   2. Tab visibility change (user returns to the tab).
  //   3. 30s background poll while the panel is open.
  // The poll compares the `last_update` timestamp on the ticket and skips the
  // re-render when nothing changed server-side.
  function scheduleTicket360Refresh(delayMs) {
    if (HU._ticket360RefreshTimer) clearTimeout(HU._ticket360RefreshTimer);
    HU._ticket360RefreshTimer = setTimeout(() => {
      HU._ticket360RefreshTimer = null;
      if (!document.getElementById('hu-ticket360-drawer')) return;
      const tid = HU.ticket360TicketId;
      if (tid) delete HU.ticketRecordPromises[String(tid)];
      openTicket360Panel().catch(() => {});
    }, delayMs || 600);
  }

  function startTicket360LiveUpdates(ticketId, lastUpdateIso) {
    stopTicket360LiveUpdates();
    HU._ticket360LastSeen = lastUpdateIso || '';
    HU._ticket360TicketId = ticketId;

    // 30s polling — only fires while the drawer is in the DOM.
    HU._ticket360PollTimer = setInterval(async () => {
      if (!document.getElementById('hu-ticket360-drawer')) {
        stopTicket360LiveUpdates();
        return;
      }
      // Skip the poll when the tab is hidden — visibilitychange below picks
      // it up when the user comes back.
      if (document.hidden) return;
      try {
        // Minimal fetch — only need last_update to decide whether to refresh.
        // Doesn't go through loadTicketRecord on purpose: we want fresh data
        // and don't want every poll to thrash the cache.
        const fresh = await haloApiRequest(`/api/tickets/${ticketId}`);
        const lu = fresh && (fresh.last_update || fresh.lastactiondate || '');
        if (lu && lu !== HU._ticket360LastSeen) {
          HU._ticket360LastSeen = lu;
          // Invalidate the shared cache so the re-render below refetches the
          // full ticket. /f will also see the new data on next activation.
          delete HU.ticketRecordPromises[String(ticketId)];
          openTicket360Panel().catch(() => {});
        }
      } catch (_) {}
    }, 30000);

    // Refresh on tab-focus regain.
    HU._ticket360VisHandler = () => {
      if (document.hidden) return;
      if (!document.getElementById('hu-ticket360-drawer')) return;
      scheduleTicket360Refresh(0);
    };
    document.addEventListener('visibilitychange', HU._ticket360VisHandler);
  }

  function stopTicket360LiveUpdates() {
    if (HU._ticket360PollTimer) { clearInterval(HU._ticket360PollTimer); HU._ticket360PollTimer = null; }
    if (HU._ticket360VisHandler) {
      document.removeEventListener('visibilitychange', HU._ticket360VisHandler);
      HU._ticket360VisHandler = null;
    }
    if (HU._ticket360RefreshTimer) { clearTimeout(HU._ticket360RefreshTimer); HU._ticket360RefreshTimer = null; }
    HU._ticket360TicketId = null;
    HU._ticket360LastSeen = '';
  }

  // Fetch the statuses allowed for a specific ticket type. Halo's /api/Status
  // endpoint accepts `tickettype_id` to return only the statuses configured
  // for that ticket type (or all statuses when the type's allowall_status
  // flag is set). Cached per ticket-type for the session — status definitions
  // rarely change.
  // Fetch /api/Status?type=ticket once per session. Halo's status records
  // carry a `used_in_ticket_types` array — the authoritative list of which
  // ticket types each status is available for. Halo's own ?tickettype_id=
  // filter is ignored on most tenants, so we filter client-side instead.
  async function fetchAllTicketStatuses() {
    if (HU._allStatusesPromise) return HU._allStatusesPromise;
    HU._allStatusesPromise = (async () => {
      try {
        const resp = await haloApiRequest(`/api/Status?type=ticket`);
        const records = extractEntityList(resp, 'statuses');
        return Array.isArray(records) ? records.filter(s => s && s.name) : [];
      } catch (_) {
        return [];
      }
    })();
    return HU._allStatusesPromise;
  }

  // Normalise the `used_in_ticket_types` field (numbers OR {id} objects)
  // to a Set of numeric type IDs for fast membership checks.
  function statusTypeIds(status) {
    const raw = status?.used_in_ticket_types;
    if (!Array.isArray(raw)) return null;
    const ids = new Set();
    raw.forEach(item => {
      const id = typeof item === 'object' && item ? Number(item.id ?? item.tickettype_id) : Number(item);
      if (Number.isFinite(id)) ids.add(id);
    });
    return ids;
  }

  // Mirror Halo's own status query — the OOTB ticket form calls
  //   /api/Status?type=ticket&tickettype_id=X&workflow_id=Y&workflow_step=Z
  // and the server filters down to just the statuses reachable from that
  // workflow step. This is far more accurate than client-side filtering.
  // If `workflow_step` is unavailable we resolve it from the workflow
  // stages (matching by stage name).
  async function fetchStatusesForTicketType(ticket) {
    // Back-compat: callers may pass just a tickettype_id (number).
    const typeId = typeof ticket === 'object' && ticket
      ? Number(ticket.tickettype_id)
      : Number(ticket);
    if (!Number.isFinite(typeId) || typeId <= 0) return null;

    const workflowId = typeof ticket === 'object' && ticket ? Number(ticket.workflow_id) || 0 : 0;
    const stepName = typeof ticket === 'object' && ticket ? String(ticket.workflow_step || '').trim() : '';
    let stepSeq = 0;
    if (workflowId && stepName) {
      try {
        const stages = await fetchWorkflowStages(workflowId);
        const match = stages.find(s => String(s.name || '').toLowerCase() === stepName.toLowerCase());
        if (match && Number.isFinite(match.seq) && match.seq > 0) stepSeq = match.seq;
      } catch (_) {}
    }

    const cacheKey = `${typeId}|${workflowId}|${stepSeq}`;
    if (!HU.statusByTypeCache) HU.statusByTypeCache = {};
    if (HU.statusByTypeCache[cacheKey]) return HU.statusByTypeCache[cacheKey];

    // Try the rich, server-side filtered call first.
    const params = new URLSearchParams({
      type: 'ticket',
      excludepending: 'false',
      excludeclosed: 'false',
      tickettype_id: String(typeId)
    });
    if (workflowId) params.set('workflow_id', String(workflowId));
    if (stepSeq) params.set('workflow_step', String(stepSeq));

    try {
      const resp = await haloApiRequest(`/api/Status?${params.toString()}`);
      const records = extractEntityList(resp, 'statuses');
      if (Array.isArray(records) && records.length) {
        const sorted = records
          .filter(s => s && s.name)
          .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) ||
                          String(a.name).localeCompare(String(b.name)));
        HU.statusByTypeCache[cacheKey] = sorted;
        return sorted;
      }
    } catch (_) {}

    // Fallback: client-side filter on used_in_ticket_types from the full
    // status list (handles tenants where the rich endpoint ignores params).
    const all = await fetchAllTicketStatuses();
    const filtered = all.filter(s => {
      const ids = statusTypeIds(s);
      if (!ids || ids.size === 0) return false;
      return ids.has(typeId);
    }).sort((a, b) => (a.sequence || 0) - (b.sequence || 0) ||
                       String(a.name).localeCompare(String(b.name)));
    HU.statusByTypeCache[cacheKey] = filtered.length ? filtered : null;
    return filtered.length ? filtered : null;
  }

  async function openTicket360Panel() {
    if (HU.settings.ticket360Enabled === false) return false;
    const ticketId = getCurrentTicketId();
    if (!ticketId) {
      toast('Open a ticket first');
      return false;
    }

    injectStyles();

    // In-place refresh path: if a Ticket 360 drawer is already open for the
    // SAME ticket, reuse it. Skip closeDrawer + createDrawer so the slide-
    // out / slide-in animation doesn't fire on every refresh. The body is
    // re-rendered below after the fetch completes.
    const existing = document.getElementById('hu-ticket360-drawer');
    const isInPlace = !!existing && Number(HU.ticket360TicketId) === Number(ticketId);

    let drawer;
    let body;
    let preservedScrollTop = 0;
    if (isInPlace) {
      drawer = existing;
      body = drawer.querySelector('.hu-drawer-body');
      // Save scroll position so the user doesn't jump to top on refresh.
      preservedScrollTop = body ? body.scrollTop : 0;
      // Close transient popovers/editors that could overlap stale targets.
      closeAgentPicker();
      closeTicketChoicePicker();
      closeInlineNoteEditor();
    } else {
      closeDrawer('hu-ticket360-drawer');
      closeDrawer('hu-timeline-drawer');
      hideHaloMenu();
      if (HU.settings.hideHaloSidebar) hideHaloSidebars();

      HU.ticket360TicketId = ticketId;

      const PUSH_WIDTH = 520;
      drawer = createDrawer('hu-ticket360-drawer', 'Ticket 360', removePushMode);
      if (HU.settings.drawer360Push) {
        Object.assign(drawer.style, {
          right: '0', top: '0', bottom: '0',
          borderRadius: '8px 0 0 8px',
          width: PUSH_WIDTH + 'px'
        });
        applyPushMode(PUSH_WIDTH);
      }
      body = drawer.querySelector('.hu-drawer-body');
      body.style.padding = '0';
      body.innerHTML = `<div style="padding:14px"><div class="hu-row"><span class="hu-row-title">Loading dashboard...</span></div></div>`;
      openDrawer(drawer);
      document.querySelectorAll('.hu-360-inject-btn').forEach(b => b.classList.add('is-active'));
    }

    // Show the header spinner while the (re-)fetch is in flight.
    setTicket360Loading(true);

    let summary, actions, trace = [];
    try {
      // Fetch the ticket + its actions via entity APIs. These respect the
      // agent's ticket-view permission (works for non-admins who can see the
      // ticket in Halo's own UI). /api/Report-based queries used to fail with
      // 403 for non-admin agents even when they could see the ticket itself.
      //
      // loadTicketRecord shares the per-session cache with /f, so opening
      // Ticket 360 right after /f (or vice versa) on the same ticket is free.
      // Polling below invalidates this cache when it detects a real update.
      const [ticket, actionsResp] = await Promise.all([
        loadTicketRecord(ticketId),
        haloApiRequest(`/api/actions?ticket_id=${ticketId}&count=25`).catch(() => ({ actions: [] }))
      ]);
      if (!ticket) throw new Error('ticket fetch failed');

      const actionRows = extractEntityList(actionsResp, 'actions');

      // Fire popup notes + view log in parallel, scoped to the people on
      // this ticket. Both are best-effort — empty arrays are valid responses.
      // We don't await these inline because the rest of the render shouldn't
      // wait on them; they patch in once they resolve.
      const userId   = ticket.user_id   || ticket.user?.id   || 0;
      const siteId   = ticket.site_id   || ticket.site?.id   || 0;
      const clientId = ticket.client_id || ticket.client?.id || 0;
      // Halo's /api/PopupNote ANDs its scoping parameters: passing user_id
      // AND site_id AND client_id only returns notes attached to ALL three
      // simultaneously, which almost never matches. Halo's own UI calls
      // the endpoint per entity and merges. We do the same.
      const fetchPopupScope = (key, id) => {
        if (!id) return Promise.resolve(null);
        const url = `/api/PopupNote?${key}=${encodeURIComponent(id)}&showall=true`;
        return haloApiRequest(url)
          .then(resp => ({ resp, scopeKey: key, scopeId: id }))
          .catch(() => null);
      };
      const popupNotesPromise = Promise.all([
        fetchPopupScope('user_id',   userId),
        fetchPopupScope('site_id',   siteId),
        fetchPopupScope('client_id', clientId)
      ]).then(results => {
        // Merge results, deduping by note id when present.
        const seen = new Set();
        const merged = [];
        const unwrap = (resp) => Array.isArray(resp) ? resp
          : (resp?.popupnotes || resp?.popup_notes || resp?.areapopups
             || resp?.area_popups || resp?.notes || resp?.items || []);
        results.forEach(r => {
          if (!r) return;
          unwrap(r.resp).forEach(note => {
            if (!note) return;
            const id = note.id;
            if (id != null) {
              if (seen.has(id)) return;
              seen.add(id);
            }
            merged.push(note);
          });
        });
        return merged;
      });
      const viewLogPromise = haloApiRequest(`/api/FaultViewLog?ticket_id=${ticketId}`).catch(() => null);

      // Kick off live-update listeners (poll + visibilitychange) so the panel
      // reflects changes made from Halo's own UI or another tab.
      startTicket360LiveUpdates(ticketId, ticket.last_update || ticket.lastactiondate || '');

      // Flatten the entity-API ticket into the same shape the renderer expects.
      // Names that aren't directly returned by /api/tickets are resolved from
      // Halo's localStorage caches (cache_status, cache_tickettype, cache_agent)
      // which Halo populates on every page load.
      // Halo's API sometimes returns related-entity fields as nested objects
      // ({id, name, ...}) instead of plain strings — unwrap to the name.
      const nameish = v => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        if (typeof v === 'object') return v.name || v.shortname || v.text || v.value || '';
        return String(v);
      };
      // Halo uses "1900-01-01" (and similar pre-2000 dates) as the
      // "no value" sentinel. Treat those as empty so the renderer falls
      // back to "--" rather than "Jan 01, 1900".
      const realDate = v => {
        if (!v) return '';
        const d = parseHaloDate(v);
        if (isNaN(d.getTime())) return '';
        if (d.getFullYear() < 2000) return '';
        return v;
      };
      summary = {
        'Ticket ID':             ticket.id,
        'Summary':               nameish(ticket.summary),
        'Status':                nameish(ticket.status_name) || getCachedName('cache_status', ticket.status_id) || (ticket.status_id ? '#' + ticket.status_id : ''),
        'Priority':              nameish(ticket.priority) || nameish(ticket.priority_name) || (ticket.priority_id ? '#' + ticket.priority_id : ''),
        'Ticket Type':           nameish(ticket.tickettype) || nameish(ticket.tickettype_name) || getCachedName('cache_tickettype', ticket.tickettype_id) || '',
        'SLA':                   nameish(ticket.sla_name),
        'SLA State':             nameish(ticket.sla_state) || nameish(ticket.slaState),
        'Opened':                realDate(ticket.dateoccurred) || realDate(ticket.datecreated) || '',
        'Due By':                realDate(ticket.fixbydate) || realDate(ticket.deadlinedate) || '',
        'Closed':                (() => {
          const opened = realDate(ticket.dateoccurred) || realDate(ticket.datecreated);
          const closed = realDate(ticket.dateclosed) || realDate(ticket.datecleared) || realDate(ticket.agreedcleared) || '';
          // Sandbox fixtures sometimes have a close date before the open date.
          // Treat that as "not closed" so SLA arc + time card agree.
          if (closed && opened && parseHaloDate(closed).getTime() < parseHaloDate(opened).getTime()) return '';
          return closed;
        })(),
        'User ID':               ticket.user_id || 0,
        'End User':              nameish(ticket.user_name) || nameish(ticket.user),
        'User Email':            '',  // not in /api/tickets — could /api/users/{id} on demand
        'User Mobile':           '',
        'Client ID':             ticket.client_id || 0,
        'Client':                nameish(ticket.client_name) || nameish(ticket.client),
        'Site ID':               ticket.site_id || 0,
        'Site':                  nameish(ticket.site_name) || nameish(ticket.site),
        'Assigned Agent ID':     ticket.agent_id || 0,
        'Assigned Agent':        getCachedName('cache_agent', ticket.agent_id) || nameish(ticket.agent_name) || '',
        'Assigned Agent Email':  '',  // not in /api/tickets — could /api/agent/{id} on demand
        'Closed By ID':          0,
        'Closed By':             '',
        'Asset ID':              (ticket.assets && ticket.assets[0] && ticket.assets[0].id) || 0,
        'Asset Tag':             nameish(ticket.assets && ticket.assets[0] && (ticket.assets[0].inventory_number || ticket.assets[0].key_field || ticket.assets[0].name))
      };

      // Flatten each action row into the SQL alias shape the renderer uses.
      actions = actionRows.map(a => ({
        'Action ID':    a.id,
        'Outcome':      nameish(a.outcome) || nameish(a.actioncode_name) || nameish(a.who_action_text),
        'Outcome ID':   a.outcome_id || a.actionoutcome_id || 0,
        'Note':         nameish(a.note),
        'Who':          nameish(a.who) || nameish(a.agent_name),
        'When':         realDate(a.datetime) || realDate(a.actiondatecreated) || realDate(a.actiondate) || realDate(a.who_changed),
        'Time Taken':   a.timetaken || 0,
        'Time Taken Adjusted': a.timetaken_adjusted || 0,
        'Date Emailed': realDate(a.dateemailed),
        'Hidden':       a.hiddenfromuser ? 1 : 0
      }));

      // Commercial trace: still SQL-based (no clean entity-API equivalent that
      // unions across quotes/orders/POs/invoices in one call). Skip silently
      // when the agent lacks Report Read — the rest of Ticket 360 still works.
      try {
        const tracePayload = await runHaloReport(buildTicketCommercialTraceQuery(ticketId), 'HaloPlus Ticket Commercial Trace');
        trace = getReportLoadError(tracePayload) ? [] : sortTraceRows(extractRows(tracePayload));
      } catch (e) {
        trace = [];
      }

      if (!summary || !summary['Ticket ID']) {
        body.innerHTML = '<div class="hu-row"><span class="hu-row-title">Ticket not found</span><span class="hu-row-sub">The ticket query returned no data. The ticket may have been deleted or you may not have access to it.</span></div>';
        return true;
      }

      body.innerHTML = '';
      // Top-level container is the .hu-drawer-body itself — sections sit
      // directly inside, separated by hairline dividers (no outer padding).
      const wrap = body;
      drawer.style.borderLeft = '';  // ::before stripe replaces the v2 left border

      // Banner sits at the very top, in normal flow (under the header, above hero).
      const banner = renderTicket360Banners(ticket);
      if (banner) wrap.appendChild(banner);

      // Popup-notes banner anchor — filled asynchronously when the
      // /api/PopupNote response resolves. We mount the placeholder so
      // late-arriving notes don't reshuffle later sections.
      const popupHost = document.createElement('div');
      popupHost.id = 'hu-360-popup-host';
      wrap.appendChild(popupHost);
      popupNotesPromise.then(notes => {
        const popupBanners = renderTicket360PopupNotes(notes || []);
        if (popupBanners) popupHost.replaceWith(popupBanners);
        else popupHost.remove();
      }).catch(() => popupHost.remove());

      // FaultViewLog appends a "Viewed N×" chip onto the aging row in the
      // hero. Fire-and-forget; chip just doesn't appear if the endpoint
      // 403s or returns empty.
      viewLogPromise.then(viewLogResp => {
        if (viewLogResp) patchTicket360ViewLog(viewLogResp);
      }).catch(() => {});

      // Priority chip — prefer Halo's per-tenant colour from cache_priority
      // (matches the configured palette in Settings → Priorities). Falls back
      // to the regex-derived `hu-chip-priority-*` class when the cache is
      // empty or the colour isn't a valid hex/rgb.
      const priorityName = nameish(ticket.priority) || nameish(ticket.priority_name) || '';
      const priorityColour = (() => {
        const cache = readHaloCacheLookup('cache_priority');
        const row = cache?.get(Number(ticket.priority_id));
        const raw = String(row?.colour || row?.color || '').trim();
        return /^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw) ? raw : '';
      })();
      const priorityCls = priorityColour
        ? 'hu-chip-priority-medium'  // base shape; inline style overrides colour
        : /critical|p1/i.test(priorityName) ? 'hu-chip-priority-critical'
        : /urgent|high|p2/i.test(priorityName) ? 'hu-chip-priority-high'
        : /low|p4/i.test(priorityName) ? 'hu-chip-priority-low'
        : 'hu-chip-priority-medium';
      const priorityStyle = priorityColour
        ? ` style="background:${priorityColour};border-color:${priorityColour};color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.25)"`
        : '';
      const priorityModClass = priorityColour ? ' hu-chip--colored' : '';

      // Format like the search results: [SR-0002177] using the ticket type's
      // email tag override. Falls back to the generated 2-letter prefix from
      // ticketTypeSearchMap, then to a plain "#0002177".
      const tt = ticket.tickettype && typeof ticket.tickettype === 'object' ? ticket.tickettype : null;
      const startTag = (tt && tt.email_start_tag_override) || '';
      const endTag = (tt && tt.email_end_tag_override) || ']';
      const paddedId = String(summary['Ticket ID'] || '').padStart(7, '0');
      let ticketIdLabel = '';
      if (summary['Ticket ID']) {
        if (startTag) {
          ticketIdLabel = `${startTag}${paddedId}${endTag}`;
        } else {
          // Fall back to the slug-based prefix HaloPlus keeps for each type.
          const def = tt && tt.name ? HU.ticketTypeSearchMap[slugify(tt.name)] : null;
          const prefix = def && def.ticketPrefix ? def.ticketPrefix : '';
          ticketIdLabel = prefix ? `[${prefix}-${paddedId}]` : `#${paddedId}`;
        }
      }

      // Look up the current status's colour from cache_status so the pill
      // matches Halo's own palette. Sanitised to hex / rgb to prevent style
      // injection. Returns '' if no usable colour was found.
      const statusColour = (() => {
        const cache = readHaloCacheLookup('cache_status');
        const row = cache?.get(Number(ticket.status_id));
        const raw = String(row?.colour || row?.color || row?.chip_color || row?.status_colour || '').trim();
        return /^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw) ? raw : '';
      })();
      const statusStyle = statusColour
        ? ` style="background:${statusColour};border-color:${statusColour};color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.25)"`
        : '';
      const statusModClass = statusColour ? ' hu-chip--colored' : '';

      // Hero section.
      const hero = document.createElement('section');
      hero.className = 'hu-360-sec hu-360-hero';
      hero.innerHTML = `
        <h2 class="hu-ticket-summary hu-ticket-summary--editable" title="Click to edit summary" role="textbox" aria-label="Ticket summary">${escapeHtml(summary['Summary'] || 'No summary')}</h2>
        <div class="hu-360-meta-row">
          <div class="hu-360-meta-col">
            <div class="hu-chip-row">
              ${summary['Status'] ? `<button type="button" class="hu-chip hu-chip-status${statusModClass} hu-chip-clickable" data-action="status"${statusStyle} title="Click to change status">${escapeHtml(summary['Status'])}<svg class="hu-chip-caret" viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>` : ''}
              ${priorityName ? `<button type="button" class="hu-chip ${priorityCls}${priorityModClass} hu-chip-clickable" data-action="priority"${priorityStyle} title="Click to change priority">${escapeHtml(priorityName)} priority<svg class="hu-chip-caret" viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>` : ''}
              ${summary['Ticket Type'] ? `<span class="hu-chip hu-chip-category">${escapeHtml(summary['Ticket Type'])}</span>` : ''}
            </div>
            ${renderTicket360AgingBadges(ticket, actions)}
          </div>
          ${renderTicket360SlaDonut(ticket)}
        </div>
        ${renderTicket360QuickActionsHtml(ticket.id, !!ticket.flagged)}`;
      wrap.appendChild(hero);

      // Replace the drawer header's "Ticket 360" with the ticket number
      // (e.g. [IN-0003112]) — saves space and gives the agent the most
      // useful identifier in the header.
      const headerTitleEl = drawer.querySelector('.hu-drawer-title');
      if (headerTitleEl) headerTitleEl.textContent = ticketIdLabel || 'Ticket 360';


      // Inline-edit the ticket summary. Click → contenteditable; Enter or
      // blur saves, Escape cancels. Multiline collapses on save (Halo's
      // `summary` is a single-line field).
      const summaryEl = hero.querySelector('.hu-ticket-summary--editable');
      if (summaryEl) {
        let originalText = String(summary['Summary'] || '');
        let editing = false;
        let cancelled = false;

        const startEdit = () => {
          if (editing) return;
          editing = true;
          cancelled = false;
          originalText = summaryEl.textContent.trim();
          summaryEl.classList.add('is-editing');
          summaryEl.contentEditable = 'true';
          summaryEl.focus();
          // Select all so the user can type to replace, or position caret.
          const range = document.createRange();
          range.selectNodeContents(summaryEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        };

        const endEdit = async () => {
          if (!editing) return;
          editing = false;
          summaryEl.contentEditable = 'false';
          summaryEl.classList.remove('is-editing');
          const newText = summaryEl.textContent.replace(/\s+/g, ' ').trim();

          if (cancelled || newText === originalText) {
            summaryEl.textContent = originalText || 'No summary';
            return;
          }
          if (!newText) {
            // Empty isn't a valid summary — revert.
            summaryEl.textContent = originalText || 'No summary';
            return;
          }
          summaryEl.textContent = newText;
          summaryEl.classList.add('hu-ticket-summary--saving');
          try {
            await updateTicketField(ticket.id, { summary: newText });
            originalText = newText;
            ticket.summary = newText;
          } catch (e) {
            // Roll back on failure.
            summaryEl.textContent = originalText || 'No summary';
          } finally {
            summaryEl.classList.remove('hu-ticket-summary--saving');
          }
        };

        summaryEl.addEventListener('click', () => { if (!editing) startEdit(); });
        summaryEl.addEventListener('focus', () => { if (!editing) startEdit(); });
        summaryEl.addEventListener('blur', () => endEdit());
        summaryEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            summaryEl.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelled = true;
            summaryEl.blur();
          }
        });
        // Strip rich text when pasting — plain text only.
        summaryEl.addEventListener('paste', e => {
          e.preventDefault();
          const text = (e.clipboardData || window.clipboardData).getData('text');
          document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
        });
      }

      // Wire clickable status / priority chips → choice picker.
      const statusChip = hero.querySelector('[data-action="status"]');
      if (statusChip) statusChip.addEventListener('click', async () => {
        // Status options come from Halo's own filtered endpoint:
        //   GET /api/Status?type=ticket&tickettype_id=X&workflow_id=Y&workflow_step=Z
        // which is what the OOTB ticket form uses. The server returns just
        // the statuses reachable from this ticket's current workflow step.
        // If that fails or returns nothing, fall back to the full
        // cache_status list so the user is never left with an empty picker.
        // Halo's own filter (server-side) — passes tickettype_id + workflow
        // + workflow_step so the response is already scoped to reachable
        // statuses for this ticket.
        let options = await fetchStatusesForTicketType(ticket);

        if (!options || !options.length) {
          const cache = readHaloCacheLookup('cache_status') || new Map();
          options = Array.from(cache.values()).filter(s => s && s.name).sort((a, b) =>
            (a.sequence || 0) - (b.sequence || 0) || String(a.name).localeCompare(String(b.name))
          );
        }
        openTicketChoicePicker(statusChip, options, ticket.status_id, async (opt) => {
          await updateTicketField(ticket.id, { status_id: Number(opt.id) });
          ticket.status_id = Number(opt.id);
          // Replace the chip's label without wiping the caret SVG.
          const caret = statusChip.querySelector('.hu-chip-caret');
          statusChip.textContent = opt.name;
          if (caret) statusChip.appendChild(caret);
          // Re-skin the chip to the new status's Halo colour. The picker
          // passes the full status record, so we can read .colour directly.
          const raw = String(opt.colour || opt.color || opt.chip_color || opt.status_colour || '').trim();
          if (/^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw)) {
            statusChip.style.background = raw;
            statusChip.style.borderColor = raw;
            statusChip.style.color = '#fff';
            statusChip.style.textShadow = '0 1px 1px rgba(0,0,0,0.25)';
            statusChip.classList.add('hu-chip--colored');
          } else {
            statusChip.removeAttribute('style');
            statusChip.classList.remove('hu-chip--colored');
          }
        });
      });
      const priorityChip = hero.querySelector('[data-action="priority"]');
      if (priorityChip) priorityChip.addEventListener('click', () => {
        const cache = readHaloCacheLookup('cache_priority') || new Map();
        let options = Array.from(cache.values()).filter(p => p && p.name);
        if (!options.length) {
          // Fallback: hardcoded standard set when the cache hasn't loaded.
          options = [
            { id: 1, name: 'Critical', colour: '#ef4444' },
            { id: 2, name: 'High',     colour: '#f97316' },
            { id: 3, name: 'Medium',   colour: '#f59e0b' },
            { id: 4, name: 'Low',      colour: '#10b981' }
          ];
        }
        openTicketChoicePicker(priorityChip, options, ticket.priority_id, async (opt) => {
          await updateTicketField(ticket.id, { priority_id: Number(opt.id) });
          ticket.priority_id = Number(opt.id);
          // Preserve the caret SVG when relabeling.
          const caret = priorityChip.querySelector('.hu-chip-caret');
          priorityChip.textContent = `${opt.name} priority`;
          if (caret) priorityChip.appendChild(caret);
          // Reskin the chip with the newly-picked colour (sanitised).
          const raw = String(opt.colour || opt.color || '').trim();
          const safe = /^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw) ? raw : '';
          if (safe) {
            priorityChip.style.background = safe;
            priorityChip.style.borderColor = safe;
            priorityChip.style.color = '#fff';
            priorityChip.style.textShadow = '0 1px 1px rgba(0,0,0,0.25)';
            priorityChip.classList.add('hu-chip--colored');
          } else {
            priorityChip.removeAttribute('style');
            priorityChip.classList.remove('hu-chip--colored');
          }
        });
      });

      // Wire quick-action buttons (Status quick-action removed — the status
      // chip already opens the picker, no need for a duplicate).
      const noteBtn = hero.querySelector('.hu-360-quick-btn[data-action="note"]');
      const timeBtn = hero.querySelector('.hu-360-quick-btn[data-action="time"]');
      const flagBtn = hero.querySelector('.hu-360-quick-btn[data-action="flag"]');
      const copyBtn = hero.querySelector('.hu-360-quick-btn[data-action="copy-link"]');
      noteBtn?.addEventListener('click', () => {
        openInlineNoteEditor(hero, ticket.id, () => openTicket360Panel().catch(() => {}));
      });
      timeBtn?.addEventListener('click', () => {
        openInlineTimeEditor(hero, ticket.id, () => openTicket360Panel().catch(() => {}));
      });
      flagBtn?.addEventListener('click', async () => {
        const next = !ticket.flagged;
        flagBtn.disabled = true;
        try {
          await updateTicketField(ticket.id, { flagged: next });
          ticket.flagged = next;
          flagBtn.querySelector('span').textContent = next ? 'Flagged' : 'Flag';
          flagBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        } catch (_) {
          // Show a transient hint if Halo rejects the patch.
          flagBtn.querySelector('span').textContent = 'Flag failed';
          setTimeout(() => { flagBtn.querySelector('span').textContent = ticket.flagged ? 'Flagged' : 'Flag'; }, 1500);
        } finally {
          flagBtn.disabled = false;
        }
      });
      copyBtn?.addEventListener('click', async () => {
        const url = new URL(`/tickets?id=${ticket.id}`, window.location.origin).href;
        const label = copyBtn.querySelector('span');
        const restore = (text, delay = 1500) => setTimeout(() => { label.textContent = text; }, delay);
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
          } else {
            // Fallback for older browsers / non-secure contexts.
            const ta = document.createElement('textarea');
            ta.value = url;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          label.textContent = 'Copied';
          restore('Copy link');
        } catch (_) {
          label.textContent = 'Copy failed';
          restore('Copy link');
        }
      });

      // Workflow & SLA (segmented bar + class-driven SLA + dates grid).
      wrap.appendChild(renderTicket360StatusCard(ticket, summary));

      // People (avatars, Customer + Assignee rows, change-assignee subtle button).
      wrap.appendChild(renderTicket360PeopleSection(ticket, summary, ticket.id));

      // Recent activity — flat section, semantic dot colours, kv table on
      // the "Opened" event populated with the ticket's custom fields so the
      // initial-state context lives inside the timeline instead of a
      // separate card.
      const tlSec = document.createElement('section');
      tlSec.className = 'hu-360-sec';

      const tlHd = document.createElement('div');
      tlHd.className = 'hu-360-sec-h hu-360-sec-h-row';
      tlHd.innerHTML = '<span>Recent activity</span>';
      const tlBtn = document.createElement('a');
      tlBtn.className = 'hu-360-link';
      tlBtn.href = '#';
      tlBtn.textContent = 'Full timeline →';
      tlBtn.addEventListener('click', e => { e.preventDefault(); openActionTimelinePanel(ticketId); });
      tlHd.appendChild(tlBtn);
      tlSec.appendChild(tlHd);

      const tl = document.createElement('div');
      tl.className = 'hu-360-tl';

      // Classifier for semantic dot colour.
      // Assignment / status-positive → is-ok (green)
      // Data changes (user/client/site/priority etc.) → is-warn (amber)
      // Opened / created / origin events → is-muted
      // Errors / rejected / breached → is-danger (red)
      const dotClass = outcome => {
        const o = String(outcome || '').toLowerCase();
        if (/open|created|logged|new ticket/.test(o)) return 'is-muted';
        if (/breach|rejected|escalat|fail/.test(o))   return 'is-danger';
        if (/reassign|re-assign|assigned|approved|status|resolved|closed/.test(o)) return 'is-ok';
        if (/change|update|email|note|user.*chang|priority|type/.test(o))           return 'is-warn';
        return 'is-muted';
      };
      // When the tenant has configured a colour for this outcome in Halo
      // Settings, use it for an inline override of the semantic class.
      const dotColour = action => lookupOutcomeColour(action['Outcome ID'], action['Outcome']);

      const displayActions = actions.slice(0, 6);
      // The "Opened" event is the *chronologically earliest* action, not any
      // action whose outcome happens to contain "logged" (which would catch
      // "Time Logged" entries too). Find it by min timestamp.
      const dated = actions.filter(a => a['When']).map(a => ({
        id: a['Action ID'], t: parseHaloDate(a['When']).getTime()
      })).filter(d => Number.isFinite(d.t));
      const openEventActionId = dated.length
        ? dated.reduce((min, x) => x.t < min.t ? x : min, dated[0]).id
        : null;

      displayActions.forEach((action, i) => {
        const isLast = i === displayActions.length - 1;
        const note = action['Note'] ? String(action['Note']) : '';
        const isOpenEvent = action['Action ID'] === openEventActionId;

        // For the Opened event, embed a kv table of the ticket's custom fields
        // (Type / Booking / Asset / Reported in the spec) inline below the note.
        let kvHtml = '';
        if (isOpenEvent && Array.isArray(ticket.customfields) && ticket.customfields.length) {
          const rows = ticket.customfields
            .filter(f => f && String(f.display || '').trim() && String(f.label || '').trim())
            .slice(0, 8)
            .map(f => {
              const label = String(f.label);
              return `<span class="hu-360-tl-kv-k" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="hu-360-tl-kv-v">${escapeHtml(String(f.display))}</span>`;
            })
            .join('');
          if (rows) kvHtml = `<div class="hu-360-tl-kv">${rows}</div>`;
        }

        // For the Opened event, Halo's `note` field is a run-together dump
        // of every ticket field ("Ticket ID0003136Ticket TypeLaptop..." etc.).
        // The kv table already shows that data cleanly, so hide the raw note
        // and show just "<Agent> logged the ticket." as a sentence.
        let noteHtml = '';
        if (isOpenEvent) {
          const who = action['Who'] ? String(action['Who']) : '';
          noteHtml = `<div class="hu-360-tl-note">${who ? escapeHtml(who) + ' logged the ticket.' : 'Ticket created.'}</div>`;
        } else if (note) {
          noteHtml = `<div class="hu-360-tl-note">${escapeHtml(note.slice(0, 220))}${note.length > 220 ? '…' : ''}</div>`;
        } else if (action['Who']) {
          noteHtml = `<div class="hu-360-tl-note">${escapeHtml(action['Who'])}</div>`;
        }

        const minutes = effectiveActionMinutes(action);
        const adjusted = minutesFromTimetaken(action['Time Taken Adjusted']);
        const rawMins = minutesFromTimetaken(action['Time Taken']);
        const adjustedDiffers = adjusted > 0 && adjusted !== rawMins;
        const durTitle = adjustedDiffers
          ? `Adjusted ${formatMinutes(adjusted)} (raw ${formatMinutes(rawMins)})`
          : 'Time logged';
        const durHtml = minutes > 0
          ? `<span class="hu-360-tl-dur${adjustedDiffers ? ' is-adjusted' : ''}" title="${escapeHtml(durTitle)}">${escapeHtml(formatMinutes(minutes))}</span>`
          : '';

        const row = document.createElement('div');
        row.className = 'hu-360-tl-row';
        row.innerHTML = `
          <div class="hu-360-tl-gutter">
            <div class="hu-360-tl-dot ${dotClass(action['Outcome'])}"${(() => { const c = dotColour(action); return c ? ` style="background:${c};border-color:${c}"` : ''; })()}></div>
            ${!isLast ? '<div class="hu-360-tl-line"></div>' : ''}
          </div>
          <div class="hu-360-tl-body">
            <div class="hu-360-tl-th">
              <div class="hu-360-tl-th-l">
                <span class="hu-360-tl-title">${escapeHtml(action['Outcome'] || `Action ${action['Action ID']}`)}</span>
                ${durHtml}
              </div>
              <span class="hu-360-tl-time">${escapeHtml(timeAgo(action['When']))}</span>
            </div>
            ${noteHtml}
            ${kvHtml}
          </div>`;
        tl.appendChild(row);
      });
      if (!actions.length) tl.innerHTML = '<div class="hu-360-tl-note">No actions returned.</div>';
      tlSec.appendChild(tl);
      wrap.appendChild(tlSec);

      // Status history + custom fields are now folded into the timeline
      // (status changes drive the dot colours; the "Opened" event renders a
      // kv table from the ticket's customfields), so no separate cards here.

      // Async cards — fire in parallel, append as each resolves. The drawer
      // is already visible at this point, so cards stream in below.
      const asyncSlots = [
        { fn: renderTicket360KbSuggestion,    arg: ticket },
        { fn: renderTicket360LinkedRecords,   arg: ticket },
        { fn: renderTicket360SimilarTickets,  arg: ticket }
      ];
      asyncSlots.forEach(({ fn, arg }) => {
        const placeholder = document.createElement('div');
        wrap.appendChild(placeholder);
        Promise.resolve(fn(arg)).then(node => {
          if (node && document.body.contains(placeholder)) {
            placeholder.replaceWith(node);
          } else {
            placeholder.remove();
          }
        }).catch(() => placeholder.remove());
      });

      if (trace.length) {
        const traceCard = document.createElement('section');
        traceCard.className = 'hu-360-sec';
        traceCard.innerHTML = '<div class="hu-360-sec-h">Commercial trace</div>';
        const traceList = document.createElement('div');
        traceList.className = 'hu-list';
        trace.forEach(row => traceList.appendChild(renderTraceRow(row)));
        traceCard.appendChild(traceList);
        wrap.appendChild(traceCard);
      }

      // Subtle footer link — fetches and renders the full audit trail on
      // demand (separate from the cached ticket fetch since it's heavy).
      const auditFoot = document.createElement('div');
      auditFoot.className = 'hu-360-footer';
      auditFoot.innerHTML = `<button type="button" class="hu-360-foot-link" data-action="audit">View audit log &rarr;</button>`;
      auditFoot.querySelector('.hu-360-foot-link').addEventListener('click', () => openAuditLogDrawer(ticket.id));
      wrap.appendChild(auditFoot);

      // wrap === body in v3 — sections were appended directly.
      // Restore scroll position so an in-place refresh doesn't jump to top.
      if (isInPlace && preservedScrollTop) body.scrollTop = preservedScrollTop;
    } catch (error) {
      const msg = (error && error.message) || String(error || '');
      const isPerm = isReportPermissionError(msg);
      const title = isPerm
        ? "You don't have permission to load this ticket"
        : "Could not load Ticket 360";
      const detail = isPerm
        ? "Your Halo agent role doesn't allow viewing this ticket via the API. Ask an admin to grant you access to this ticket type."
        : (msg || 'Unknown error.');
      body.innerHTML = '<div class="hu-row"><span class="hu-row-title">' + escapeHtml(title) + '</span><span class="hu-row-sub">' + escapeHtml(detail) + '</span></div>';
    } finally {
      setTicket360Loading(false);
    }

    return true;
  }

  async function openActionTimelinePanel(ticketId = 0) {
    const resolvedTicketId = Number(ticketId) || getCurrentTicketId();
    if (!resolvedTicketId) {
      toast('Open a ticket first');
      return false;
    }

    injectStyles();
    closeDrawer('hu-timeline-drawer');

    HU.timelineTicketId = resolvedTicketId;
    const drawer = createDrawer('hu-timeline-drawer', 'Action timeline');
    const body = drawer.querySelector('.hu-drawer-body');
    body.innerHTML = '<div class="hu-row"><span class="hu-row-title">Loading ticket actions...</span></div>';
    openDrawer(drawer);

    try {
      // /api/actions respects ticket-view permission, so non-admin agents who
      // can see the ticket in Halo's UI can also view its action timeline.
      const actionsResp = await haloApiRequest(`/api/actions?ticket_id=${resolvedTicketId}&count=200`);
      const actionRows = extractEntityList(actionsResp, 'actions');

      // Flatten entity-API actions into the same SQL-alias shape the renderer expects.
      const nameish = v => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        if (typeof v === 'object') return v.name || v.shortname || v.text || v.value || '';
        return String(v);
      };
      const realDate = v => {
        if (!v) return '';
        const d = parseHaloDate(v);
        if (isNaN(d.getTime())) return '';
        if (d.getFullYear() < 2000) return '';
        return v;
      };
      const rows = actionRows.map(a => ({
        'Action ID':    a.id,
        'Outcome':      nameish(a.outcome) || nameish(a.actioncode_name) || nameish(a.who_action_text),
        'Outcome ID':   a.outcome_id || a.actionoutcome_id || 0,
        'Note':         nameish(a.note),
        'Who':          nameish(a.who) || nameish(a.agent_name),
        'When':         realDate(a.datetime) || realDate(a.actiondatecreated) || realDate(a.actiondate) || realDate(a.who_changed),
        'Time Taken':   a.timetaken || 0,
        'Time Taken Adjusted': a.timetaken_adjusted || 0,
        'Date Emailed': realDate(a.dateemailed),
        'Hidden':       a.hiddenfromuser ? 1 : 0
      }));

      body.innerHTML = '';

      const totalActions = rows.length;
      const emailActions = rows.filter(row => row['Date Emailed']).length;
      const hiddenActions = rows.filter(row => ['1', 'true', 'yes'].includes(String(row['Hidden']).toLowerCase())).length;
      const totalMinutes = rows.reduce((sum, row) => sum + effectiveActionMinutes(row), 0);
      const latestAction = rows[0];

      const header = document.createElement('section');
      header.className = 'hu-card hu-ticket-hero';
      header.innerHTML = `
        <div class="hu-ticket-hero-main">
          <div class="hu-ticket-id">Ticket #${resolvedTicketId}</div>
          <div class="hu-ticket-summary">Action timeline</div>
          <div class="hu-chip-row">
            ${coloredChip(totalActions ? `${totalActions} actions` : 'No actions', 'type')}
            ${coloredChip(emailActions ? `${emailActions} emails` : 'No emails', 'status')}
            ${coloredChip(hiddenActions ? `${hiddenActions} hidden` : 'All visible', hiddenActions ? 'priority' : 'status')}
          </div>
          <div class="hu-ticket-hero-sub" style="margin-top:8px;color:rgba(255,255,255,0.76);font-size:11px">
            ${escapeHtml(latestAction ? `Latest update ${timeAgo(latestAction['When'])}` : 'No updates returned yet')}
          </div>
        </div>
      `;
      body.appendChild(header);

      const kpiGrid = document.createElement('div');
      kpiGrid.className = 'hu-360-kpi-grid';
      [
        { label: 'Actions', value: totalActions ? String(totalActions) : '--', dot: '#3b82f6' },
        { label: 'Emails', value: emailActions ? String(emailActions) : '--', dot: '#10b981' },
        { label: 'Visible', value: totalActions ? String(totalActions - hiddenActions) : '--', dot: '#8b5cf6' },
        { label: 'Time logged', value: totalMinutes ? formatMinutes(totalMinutes) : '--', dot: '#f59e0b' }
      ].forEach(({ label, value, dot }) => {
        const card = document.createElement('div');
        card.className = 'hu-360-kpi';
        card.innerHTML = `<div class="hu-360-kpi-label">${escapeHtml(label)}</div>
          <div class="hu-360-kpi-value"><span class="hu-360-kpi-dot" style="background:${dot}"></span>${escapeHtml(value)}</div>`;
        kpiGrid.appendChild(card);
      });
      body.appendChild(kpiGrid);

      if (rows.length) {
        const actCounts = {};
        rows.forEach((row) => {
          const { label, color } = classifyAction(row);
          actCounts[label] = actCounts[label] || { count: 0, color };
          actCounts[label].count++;
        });
        const maxCount = Math.max(...Object.values(actCounts).map(v => v.count));
        const actCard = document.createElement('section');
        actCard.className = 'hu-card';
        actCard.style.marginBottom = '10px';
        actCard.innerHTML = '<div class="hu-section-title">Action mix</div>';
        Object.entries(actCounts)
          .sort((a, b) => b[1].count - a[1].count)
          .forEach(([label, { count, color }]) => {
            const row = document.createElement('div');
            row.className = 'hu-360-act-row';
            row.innerHTML = `<span class="hu-360-act-label">${escapeHtml(label)}</span>
              <div class="hu-360-act-track"><div class="hu-360-act-fill" style="width:${Math.round(count / maxCount * 100)}%;background:${safeColor(color)}"></div></div>
              <span class="hu-360-act-count">${count}</span>`;
            actCard.appendChild(row);
          });
        body.appendChild(actCard);
      }

      const list = document.createElement('section');
      list.className = 'hu-card';
      const heading = document.createElement('div');
      heading.className = 'hu-section-title-row';
      heading.innerHTML = '<span class="hu-section-title" style="margin:0">Recent actions</span>';
      list.appendChild(heading);
      const listWrap = document.createElement('div');
      listWrap.className = 'hu-360-tl';
      rows.forEach((row, index) => listWrap.appendChild(renderActionTimelineFeedRow(row, index === rows.length - 1)));
      if (!rows.length) listWrap.innerHTML = '<div class="hu-empty-note">No actions returned for this ticket.</div>';
      list.appendChild(listWrap);
      body.appendChild(list);
    } catch (error) {
      const msg = (error && error.message) || String(error || '');
      const isPerm = isReportPermissionError(msg);
      const title = isPerm
        ? "You don't have permission to view this ticket's actions"
        : "Could not load action timeline";
      const detail = isPerm
        ? "Your Halo agent role doesn't allow viewing this ticket's actions via the API. Ask an admin to grant you access to this ticket type."
        : (msg || 'Unknown error.');
      body.innerHTML = '<div class="hu-row"><span class="hu-row-title">' + escapeHtml(title) + '</span><span class="hu-row-sub">' + escapeHtml(detail) + '</span></div>';
    }

    return true;
  }

  function ticket360Section(title, items) {
    const section = document.createElement('section');
    section.className = 'hu-card';
    section.innerHTML = `<div class="hu-section-title">${escapeHtml(title)}</div>`;
    const grid = document.createElement('div');
    grid.className = 'hu-stat-grid';
    items.filter(Boolean).forEach(item => grid.appendChild(item));
    section.appendChild(grid);
    return section;
  }

  function statItem(label, value, sub = '') {
    const item = document.createElement('div');
    item.className = 'hu-stat';
    item.innerHTML = `
      <div class="hu-stat-label">${escapeHtml(label)}</div>
      <div class="hu-stat-value">${escapeHtml(value || '--')}</div>
      ${sub ? `<div class="hu-stat-sub">${escapeHtml(sub)}</div>` : ''}
    `;
    return item;
  }

  function linkedItem(label, id, title, path) {
    const item = statItem(label, title || (id ? `${label} ${id}` : '--'), id ? `ID ${id}` : '');
    if (path) {
      item.classList.add('hu-stat-link');
      item.title = `Open ${label}`;
      item.addEventListener('click', () => navigateTo(path));
    }
    return item;
  }

  function ticket360Chip(value, label) {
    if (!value) return '';
    return `<span class="hu-chip" title="${escapeHtml(label)}">${escapeHtml(value)}</span>`;
  }

  function coloredChip(value, kind, explicitColour) {
    if (!value) return '';
    const v = String(value).toLowerCase();
    let bg, border, text;

    // If an explicit Halo colour was supplied (e.g. cache_status.colour),
    // derive a translucent background + border from it so the chip matches
    // Halo's own colour palette exactly. Sanitised to hex/rgb only.
    if (explicitColour && /^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(String(explicitColour).trim())) {
      const c = String(explicitColour).trim();
      return `<span class="hu-chip" style="background:${c};border-color:${c};color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.25)">${escapeHtml(value)}</span>`;
    }

    if (kind === 'status') {
      if (/closed|resolved|completed|done|fixed/.test(v))
        [bg, border, text] = ['rgba(107,114,128,0.30)', 'rgba(156,163,175,0.45)', '#d1d5db'];
      else if (/progress|assigned|working|active|open/.test(v))
        [bg, border, text] = ['rgba(59,130,246,0.30)',  'rgba(147,197,253,0.45)', '#93c5fd'];
      else if (/wait|hold|pending|suspend|paused|defer/.test(v))
        [bg, border, text] = ['rgba(245,158,11,0.30)',  'rgba(252,211,77,0.45)',  '#fcd34d'];
      else if (/new|created/.test(v))
        [bg, border, text] = ['rgba(16,185,129,0.30)',  'rgba(110,231,183,0.45)', '#6ee7b7'];
      else
        [bg, border, text] = ['rgba(59,130,246,0.25)',  'rgba(147,197,253,0.35)', '#93c5fd'];

    } else if (kind === 'priority') {
      if (/critical|urgent|p1/.test(v))
        [bg, border, text] = ['rgba(239,68,68,0.30)',   'rgba(252,165,165,0.45)', '#fca5a5'];
      else if (/high|p2/.test(v))
        [bg, border, text] = ['rgba(249,115,22,0.30)',  'rgba(253,186,116,0.45)', '#fdba74'];
      else if (/low|p4|minor/.test(v))
        [bg, border, text] = ['rgba(16,185,129,0.30)',  'rgba(110,231,183,0.45)', '#6ee7b7'];
      else
        [bg, border, text] = ['rgba(59,130,246,0.25)',  'rgba(147,197,253,0.35)', '#93c5fd'];

    } else if (kind === 'type') {
      if (/major.?incident/.test(v))
        [bg, border, text] = ['rgba(220,38,38,0.35)',   'rgba(252,165,165,0.50)', '#fca5a5'];
      else if (/incident/.test(v))
        [bg, border, text] = ['rgba(239,68,68,0.25)',   'rgba(252,165,165,0.40)', '#fca5a5'];
      else if (/problem/.test(v))
        [bg, border, text] = ['rgba(249,115,22,0.25)',  'rgba(253,186,116,0.40)', '#fdba74'];
      else if (/change/.test(v))
        [bg, border, text] = ['rgba(59,130,246,0.25)',  'rgba(147,197,253,0.40)', '#93c5fd'];
      else if (/service.?request/.test(v))
        [bg, border, text] = ['rgba(16,185,129,0.25)',  'rgba(110,231,183,0.40)', '#6ee7b7'];
      else if (/task|project/.test(v))
        [bg, border, text] = ['rgba(139,92,246,0.25)',  'rgba(167,139,250,0.40)', '#c4b5fd'];
      else
        [bg, border, text] = ['rgba(255,155,81,0.25)',  'rgba(94,234,212,0.40)',  '#ffd2b2'];

    } else {
      [bg, border, text] = ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.18)', '#fff'];
    }

    return `<span class="hu-chip" style="background:${bg};border-color:${border};color:${text}">${escapeHtml(value)}</span>`;
  }

  function renderActionTimelineRow(action, expanded = false) {
    const isHidden = ['1', 'true', 'yes'].includes(String(action['Hidden']).toLowerCase());
    const row = document.createElement('div');
    row.className = 'hu-list-row';
    row.innerHTML = `
      <div class="hu-list-row-top">
        <span class="hu-list-title">${escapeHtml(action['Outcome'] || `Action ${action['Action ID']}`)}</span>
        <span class="hu-list-meta">${escapeHtml(formatDateTime(action['When']))}</span>
      </div>
      <div class="hu-list-row-sub">${escapeHtml(action['Who'] || 'Unknown')} - ${escapeHtml(isHidden ? 'Hidden from user' : 'Visible to user')} - ${escapeHtml(formatMinutes(effectiveActionMinutes(action)))}</div>
      ${action['Date Emailed'] ? `<div class="hu-list-row-sub">Email sent ${escapeHtml(formatDateTime(action['Date Emailed']))}</div>` : ''}
      ${action['Note'] ? `<div class="hu-list-note">${escapeHtml(action['Note'])}</div>` : ''}
    `;
    return row;
  }

  function renderActionTimelineFeedRow(action, isLast = false) {
    const { label, color } = classifyAction(action);
    const isHidden = ['1', 'true', 'yes'].includes(String(action['Hidden']).toLowerCase());
    const note = action['Note'] ? String(action['Note']) : '';
    const noteHtml = note
      ? `<div class="hu-360-tl-note">${escapeHtml(note.slice(0, 320))}${note.length > 320 ? '...' : ''}</div>`
      : '';
    const emailHtml = action['Date Emailed']
      ? `<div class="hu-360-tl-note">Email sent ${escapeHtml(formatDateTime(action['Date Emailed']))}</div>`
      : '';
    const timePartMinutes = effectiveActionMinutes(action);
    const timePart = timePartMinutes > 0 ? ` - ${escapeHtml(formatMinutes(timePartMinutes))}` : '';

    const row = document.createElement('div');
    row.className = 'hu-360-tl-row';
    row.innerHTML = `
      <div class="hu-360-tl-gutter">
        <div class="hu-360-tl-dot" style="background:${safeColor(color)}"></div>
        ${!isLast ? '<div class="hu-360-tl-line"></div>' : ''}
      </div>
      <div class="hu-360-tl-body">
        <div class="hu-360-tl-title">${escapeHtml(action['Outcome'] || `Action ${action['Action ID']}`)}</div>
        <div class="hu-360-tl-meta">${escapeHtml(action['Who'] || 'Unknown')} - ${escapeHtml(label)} - ${escapeHtml(timeAgo(action['When']))}${timePart}</div>
        <div class="hu-360-tl-meta">${escapeHtml(isHidden ? 'Hidden from user' : 'Visible to user')} - ${escapeHtml(formatDateTime(action['When']))}</div>
        ${noteHtml}
        ${emailHtml}
      </div>`;
    return row;
  }

  function renderTraceRow(row) {
    const wrapper = document.createElement('div');
    wrapper.className = 'hu-list-row';
    const recordType = String(row['Record Type'] || '');
    const recordId = row['Record ID'];
    const routeMap = {
      'Invoice': 'invoice',
      'Quote': 'quote',
      'Purchase Order': 'purchase'
    };
    const routeType = routeMap[recordType];
    wrapper.innerHTML = `
      <div class="hu-list-row-top">
        <span class="hu-list-title">${escapeHtml(recordType)} ${recordId ? `#${recordId}` : ''}</span>
        <span class="hu-list-meta">${escapeHtml(formatDateTime(row['Date']))}</span>
      </div>
      <div class="hu-list-row-sub">${escapeHtml(row['Title'] || '--')}${row['Reference'] ? ` - ${escapeHtml(row['Reference'])}` : ''}</div>
    `;
    if (routeType && recordId) {
      wrapper.classList.add('hu-list-row-link');
      wrapper.title = `Open ${recordType}`;
      wrapper.addEventListener('click', () => navigateTo(routeDetail(routeType, recordId)));
    }
    return wrapper;
  }

  function toggleFieldOverlay() {
    HU.fieldOverlayOn = !HU.fieldOverlayOn;
    if (!HU.fieldOverlayOn) {
      clearTimeout(HU.overlayTimer);
      document.querySelectorAll('.hu-field-tag').forEach(tag => tag.remove());
      toast('Field API names hidden');
      return;
    }

    revealFieldNames();
    toast('Field API names shown');
  }

  async function revealFieldNames() {
    if (!HU.fieldOverlayOn) return;
    document.querySelectorAll('.hu-field-tag').forEach(tag => tag.remove());
    const labels = document.querySelectorAll('label, .field-label, [class*="field-label"], [class*="form-label"]');

    // On user / asset / customer / supplier / site forms the `other1..N`,
    // `inv1..N` and `userdef1..N` slots are tenant-relabelable via Halo's
    // language pack (`/api/Languages/{id}`). When that map is available it's
    // a deterministic lookup. If it isn't yet (first-ever activation before
    // the 8 MB fetch returns) or the call is forbidden, we fall back to
    // value-matching. The pack load is kicked off in initNavigationTracking,
    // so by the time the user hits `f` it's typically already cached.
    const slotCtx = detectSlotRecordContext();
    const cfCtx = detectCustomFieldContext();
    const slotEntity = slotCtx ? slotCtx.type.toLowerCase() : null;
    const cfEntity = cfCtx ? cfCtx.type.toLowerCase() : null;

    if (cfEntity) loadCustomFieldMap(cfEntity); // fire-and-forget; populates HU.customFieldMap[cfEntity]
    const labelToSlot = (slotEntity && HU.slotLabelMap) ? HU.slotLabelMap[slotEntity] : null;
    const labelToCustomField = cfEntity ? HU.customFieldMap[cfEntity] : null;

    let slotMap = null;
    if (slotEntity && !labelToSlot) {
      const slotRecord = await getSlotRecordSafely();
      slotMap = slotRecord ? buildSlotValueMap(slotRecord) : null;
      if (!HU.fieldOverlayOn) return;
    }

    // Ticket forms only: load the live ticket record. Used for value-matching
    // when the DOM doesn't carry a `for` binding, and for runtime validation
    // so a parsed-but-wrong name produces no tag (silent miss) instead of a
    // false tag (silent lie). One fetch, cached per session — used to be 4
    // (ticket + user + site + client) when we still produced cross-entity
    // dot-paths; now that DOM parsing always returns the ticket's own field,
    // the related-entity expansion was dead weight and got dropped.
    let ticketRecord = null;
    let ticketValueMap = null;
    if (cfCtx && cfCtx.type === 'Ticket') {
      ticketRecord = await loadTicketRecord(cfCtx.id);
      if (!HU.fieldOverlayOn) return;
      ticketValueMap = buildTicketValueMap(ticketRecord);
    }

    labels.forEach(label => {
      if (isTableCheckboxLabel(label)) return;
      const labelSlug = labelTextToAutoSlug(label);
      // Collection widgets / section headers — see SKIP_LABEL_SLUGS comment.
      if (SKIP_LABEL_SLUGS.has(labelSlug)) return;

      // `getFieldApiName` now parses the canonical name straight out of
      // Halo's `<label for="input-field-for-XXX">` attribute — see comment
      // there. That's the dynamic primary signal and works on read-only
      // forms too. Everything below is fallback for the rare cases where
      // the DOM doesn't carry the binding.
      let apiName = getFieldApiName(label, ticketRecord);
      const isAutoSlugged = !apiName || apiName === labelSlug;

      // Custom field fallback — when DOM didn't yield a name, look the
      // label up in the live FieldInfo CF map.
      if (labelToCustomField && isAutoSlugged) {
        const cf = lookupSlotByLabelText(label, labelToCustomField);
        if (cf) apiName = cf;
      }

      // Slot-relabel fallback — language pack tells us the tenant's
      // relabel of other1/inv1/userdef1 slots.
      if (labelToSlot) {
        const slot = lookupSlotByLabelText(label, labelToSlot);
        if (slot) apiName = slot;
      } else if (slotMap) {
        const slot = resolveSlotForLabel(label, slotMap);
        if (slot) apiName = slot;
      }

      // Last resort: value-match the visible input value against the ticket
      // record's own scalars. Bridges "label without `for`" cases — picks
      // the field whose value is uniquely shown next to this label.
      if (ticketValueMap) {
        const stillAutoSlugged = !apiName || apiName === labelSlug;
        if (stillAutoSlugged) {
          const path = resolveDotPathForLabel(label, ticketValueMap);
          if (path) apiName = path;
        }
      }

      // Targeted validation: ONLY suppress when the name is the bare
      // auto-slug of the label text. That's the "nothing else worked"
      // fallback path — showing it would be a guess, not a binding.
      //
      // Names that came from a `for` attribute, the CF/slot maps, or the
      // value-matcher are trusted and shown unconditionally. Halo's API
      // omits empty fields from `/api/tickets/{id}` responses, so a strict
      // `path in record` check would drop legitimate fields (e.g. an empty
      // `phonenumber`). The parser already uses the record for candidate
      // disambiguation, not as a strict gate.
      if (apiName && apiName === labelSlug && ticketRecord) {
        if (pathExistsInRecord(ticketRecord, apiName) === false) return;
      }

      if (!apiName) return;
      label.appendChild(buildFieldTag(apiName));
    });

    revealTableColumnNames();
  }

  // A bare name (e.g. `summary`) renders as the standard blue tag. A
  // dot-pathed name (e.g. `user.emailaddress`) renders as the amber
  // related-entity tag with the table prefix emphasised — so the user
  // immediately sees that the field lives in a different table and an
  // API call / SQL query needs to join through it.
  function buildFieldTag(apiName) {
    const tag = document.createElement('span');
    tag.className = 'hu-field-tag';
    tag.title = `Copy "${apiName}" to clipboard`;
    tag.addEventListener('click', (e) => {
      // Stop the click from reaching Halo's own label/form handlers
      // (clicking a field label often triggers focus / enter-edit-mode).
      e.preventDefault();
      e.stopPropagation();
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(apiName).then(() => {
        tag.classList.add('hu-field-tag-copied');
        const originalText = tag.dataset.originalText;
        if (!originalText) tag.dataset.originalText = tag.textContent;
        // Remember the inner children if we have the dot-pathed shape, so
        // the swap-back restores them rather than collapsing to a flat
        // textContent.
        const innerHTML = tag.innerHTML;
        tag.textContent = 'Copied';
        setTimeout(() => {
          tag.classList.remove('hu-field-tag-copied');
          tag.innerHTML = innerHTML;
        }, 900);
      }).catch(() => {});
    });
    const dotIndex = apiName.indexOf('.');
    if (dotIndex > 0 && dotIndex < apiName.length - 1) {
      tag.classList.add('hu-field-tag-related');
      const entity = document.createElement('span');
      entity.className = 'hu-field-tag-entity';
      entity.textContent = apiName.slice(0, dotIndex);
      const sep = document.createElement('span');
      sep.className = 'hu-field-tag-sep';
      sep.textContent = '.';
      const field = document.createElement('span');
      field.textContent = apiName.slice(dotIndex + 1);
      tag.appendChild(entity);
      tag.appendChild(sep);
      tag.appendChild(field);
    } else {
      tag.textContent = apiName;
    }
    return tag;
  }

  function lookupSlotByLabelText(label, labelToSlot) {
    const raw = (label.textContent || '').trim();
    if (!raw) return null;
    // Strip the asterisk required-marker and trailing colon Halo sometimes
    // adds, plus our own tag's trailing space.
    const cleaned = raw.replace(/\s*\*\s*$/, '').replace(/:\s*$/, '').trim().toLowerCase();
    return labelToSlot[cleaned] || labelToSlot[raw.toLowerCase()] || null;
  }

  // Mirror of the auto-slug fallback inside getFieldApiName(): Halo's React
  // app stamps `<input id="<labelSlug>" name="<labelSlug>">` for custom-field
  // inputs, so a DOM attribute matching this slug is the auto-generated one.
  // Standard fields have explicit names like "emailaddress" that don't match.
  function labelTextToAutoSlug(label) {
    const raw = (label.textContent || '').trim();
    if (!raw) return '';
    const cleaned = raw.replace(/\s*\*\s*$/, '').replace(/:\s*$/, '').trim();
    return cleaned.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  }

  // ----- Language-pack-based slot resolver -----
  // /api/Languages/{langId}?includedetails=true&includelanguagecontext=true
  // returns entries like
  //   { description: "Screen Label for User Other 1 Field",
  //     default_string: "Other 1", translation: "Department",
  //     iscustomised: true, ... }
  // We walk the response once, regex the description to (entity, slotFamily,
  // slotIndex), and build { entityKey: { displayLabel: slotName } }.
  // The pack is ~8 MB, but the extract is ~30 entries — we cache the
  // extracted map in chrome.storage.local indefinitely (per language).
  // Inside the same session it's also held in HU.slotLabelMap.

  function loadSlotLabelMap() {
    if (HU.slotLabelMap) return Promise.resolve(HU.slotLabelMap);
    if (HU.slotLabelMapPromise) return HU.slotLabelMapPromise;

    HU.slotLabelMapPromise = (async () => {
      const langId = 1;
      const storageKey = `huSlotLabels_v3_${langId}`;
      try {
        const stored = await new Promise(r => chrome.storage.local.get(storageKey, r));
        const cached = stored && stored[storageKey];
        if (cached && cached.entries && typeof cached.entries === 'object') {
          HU.slotLabelMap = cached.entries;
          return cached.entries;
        }
      } catch (_) {}

      try {
        const pack = await haloApiRequest(
          `/api/Languages/${langId}?includedetails=true&includelanguagecontext=true`
        );
        const entries = extractSlotLabelMap(pack);
        HU.slotLabelMap = entries;
        try {
          chrome.storage.local.set({
            [storageKey]: { entries, fetchedAt: Date.now() }
          });
        } catch (_) {}
        return entries;
      } catch (_) {
        // Permission denied / network — fall back forever for this session.
        HU.slotLabelMap = {};
        return {};
      }
    })();

    return HU.slotLabelMapPromise;
  }

  function extractSlotLabelMap(pack) {
    const slotPattern = /Screen Label for (User|Site|Customer|Client|Asset|Supplier)\s+(Other|Inv|Userdef)\s*(\d+)\s+Field/i;
    const out = {};

    // For a matched node: register both the tenant's `translation` (preferred,
    // wins over default) and the `default_string` as keys pointing at the
    // canonical field name. Translation comes first so tenant relabels are
    // resolved, and the default is the fallback for never-relabeled entries.
    const recordLabel = (entity, canonical, node) => {
      if (!entity || !canonical) return;
      if (!out[entity]) out[entity] = {};
      if (typeof node.translation === 'string') {
        const t = node.translation.trim().toLowerCase();
        if (t) out[entity][t] = canonical;
      }
      if (typeof node.default_string === 'string') {
        const d = node.default_string.trim().toLowerCase();
        if (d && !out[entity][d]) out[entity][d] = canonical;
      }
    };

    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      const desc = node.description;
      if (typeof desc === 'string') {
        // Tenant-relabelable slot fields (other1/inv1/userdef1).
        const m = desc.match(slotPattern);
        if (m) {
          const ent = m[1].toLowerCase() === 'client' ? 'customer' : m[1].toLowerCase();
          const slot = `${m[2].toLowerCase()}${m[3]}`;
          recordLabel(ent, slot, node);
        }
      }
      for (const v of Object.values(node)) visit(v);
    };
    visit(pack);
    return out;
  }

  // ----- Custom field label → canonical name resolver -----
  // /api/FieldInfo?iscustomfieldsetup=true&typeid={n} returns the tenant's
  // custom-field definitions for a given entity. The `name` property is the
  // canonical name used in API PATCHes (e.g. "CFLastTicket"); the `label`
  // is the friendly text shown on the form. Halo's React app stamps a
  // separate auto-slugged id ("last_ticket") onto the DOM input, which is
  // what getFieldApiName picks up — so we override it here.
  // Responses are small (one entry per custom field); we cache per entity.

  const ENTITY_TYPE_ID = {
    user:     4,
    customer: 2,
    site:     3,
    asset:    5,
    supplier: 6,
    ticket:   1
  };

  // Labels on a parent entity's form that actually belong to a *related* entity
  // (e.g. on a ticket form, "Email Address" is the requester's `user.emailaddress`,
  // not a ticket field). Keys are the auto-slugged label form (matches
  // `labelTextToAutoSlug()`); values are the dot-walked tag we want to show.
  // These take precedence over custom-field and slot lookups so a tenant CF
  // whose label is "Email Address" doesn't mask the user's standard column.
  //
  // Only true cross-table fields belong here. Own-entity fields (e.g. `site_id`,
  // `client_id`, `user_id` on a ticket) are handled by the value-matching
  // fallback or the DOM lookup, and should NOT be hardcoded with a redundant
  // `ticket.` prefix — the dot-path styling is reserved for related tables.
  // Labels that name a collection widget / section header rather than a
  // single field. `/f` is meant to give you something you can drop into an
  // API call or SQL query — surfacing an auto-slug (e.g. `user_s_assets` for
  // "User's Assets") would mislead, so we skip these outright. Keys are the
  // auto-slugged label form (matches `labelTextToAutoSlug()`).
  const SKIP_LABEL_SLUGS = new Set([
    'user_s_assets',  // ticket sidebar — requester's asset list
    'users_assets',
    'user_assets'
  ]);

  // Returns the full FieldInfo array for an entity (not just label→name).
  // Used by the side-panel schema explorer to surface CFs with their type,
  // hint, variable_name, etc. — richer data than loadCustomFieldMap needs.
  async function loadCustomFieldsRaw(entityKey) {
    const typeid = ENTITY_TYPE_ID[entityKey];
    if (typeid == null) return [];
    try {
      const resp = await haloApiRequest(
        `/api/FieldInfo?iscustomfieldsetup=true&access_control_level=2&isconfig=true&typeid=${typeid}`
      );
      const arr = Array.isArray(resp) ? resp : (resp?.fields || resp?.fieldinfos || resp?.items || []);
      // Strip fat properties Halo includes that we don't need for the
      // explorer — keeps the payload small for chrome.storage.local.
      return arr
        .filter(f => f && typeof f === 'object' && typeof f.name === 'string' && f.name.trim())
        .map(f => ({
          name: String(f.name).trim(),
          label: typeof f.label === 'string' ? f.label.trim() : '',
          labellong: typeof f.labellong === 'string' ? f.labellong.trim() : '',
          hint: typeof f.hint === 'string' ? f.hint.trim() : '',
          type: typeof f.type === 'number' ? f.type : null,
          inputtype: typeof f.inputtype === 'number' ? f.inputtype : null,
          mandatory: !!f.mandatory,
          variable_name: typeof f.variable_name === 'string' ? f.variable_name.trim() : '',
          tab_name: typeof f.tab_name === 'string' ? f.tab_name.trim() : '',
          groupname: typeof f.groupname === 'string' ? f.groupname.trim() : '',
          // Trimmed picklist values — cap at 100 entries so a runaway
          // database-lookup CF can't bloat chrome.storage.local. Show only
          // `id` + `name`, drop sequence/colour/etc.
          values: Array.isArray(f.values)
            ? f.values
                .filter(v => v && typeof v === 'object')
                .slice(0, 100)
                .map(v => ({
                  id: v.id ?? v.value ?? null,
                  name: typeof v.name === 'string' ? v.name : (typeof v.value === 'string' ? v.value : String(v.name ?? v.value ?? '')).trim()
                }))
                .filter(v => v.name)
            : [],
          // Tickettype bindings — which request types include this CF.
          tickettypes: Array.isArray(f.tickettypes)
            ? f.tickettypes
                .filter(t => t && typeof t === 'object')
                .map(t => ({
                  id: t.id ?? null,
                  name: typeof t.name === 'string' ? t.name.trim() : ''
                }))
                .filter(t => t.name)
            : []
        }));
    } catch (_) {
      return [];
    }
  }

  // Harvest top-level field names from a sample record per entity. Bridges
  // the SQL-vs-API naming gap in the schema explorer — the bundled
  // tables.json uses SQL column names (PascalCase, legacy spellings like
  // `DateOccured`, `FFlowID`); this exposes the API names (`workflow_id`,
  // `dateoccurred`, etc.) too, so the side panel's schema search can find
  // either form.
  async function loadEntitySamples() {
    const fetchers = {
      ticket:   () => haloApiRequest('/api/tickets?count=1'),
      user:     () => haloApiRequest('/api/users?count=1'),
      customer: () => haloApiRequest('/api/client?count=1'),
      site:     () => haloApiRequest('/api/site?count=1'),
      asset:    () => haloApiRequest('/api/asset?count=1'),
      supplier: () => haloApiRequest('/api/supplier?count=1'),
      agent:    () => haloApiRequest('/api/agent?count=1')
    };
    const entries = Object.entries(fetchers);
    const results = await Promise.all(entries.map(async ([entity, fetcher]) => {
      try {
        const resp = await fetcher();
        // List endpoints return varied shapes — { record_count, items[] },
        // a bare array, or { entityName: [...] }. Walk known shapes.
        const arr = Array.isArray(resp) ? resp
          : (resp?.tickets || resp?.users || resp?.clients || resp?.sites
             || resp?.assets || resp?.suppliers || resp?.agents
             || resp?.items || []);
        const sample = arr[0];
        if (!sample || typeof sample !== 'object') return [entity, []];
        return [entity, Object.keys(sample)];
      } catch (_) {
        return [entity, []];
      }
    }));
    return Object.fromEntries(results);
  }

  // ViewColumns harvest — Halo's saved column views carry both the API
  // field name (column_name) and the friendly label users see in list
  // grids (column_title_override). Crossing this against the schema
  // explorer's existing rows is the closest we can get to a server-side
  // SQL↔API label map without parsing the React bundle.
  // Halo's /api/ViewColumns returns ALL view definitions in one call —
  // the `?type=` filter is server-side ignored on the tenants we've seen.
  // Each view's `type` field is the numeric "view group" code (NOT the
  // FieldInfo typeid). Empirical mapping based on a live response:
  //   0   = Tickets        4 = Customers
  //   1   = Opportunities  5 = Sites
  //   3   = Assets         6 = Users
  // (103 = Changes, 107 = Projects, 112 = My Work — not yet mapped here.)
  //
  // First value is the string used in Halo's own UI call (kept for the
  // query param); second is the numeric type code we filter by on the
  // response. Either suffices because the API ignores `type=` anyway.
  const VIEW_COLUMN_ENTITY_TYPES = {
    ticket:   { queryType: 'reqs',     typeCode: 0 },
    customer: { queryType: 'clients',  typeCode: 4 },
    site:     { queryType: 'sites',    typeCode: 5 },
    user:     { queryType: 'users',    typeCode: 6 },
    asset:    { queryType: 'assets',   typeCode: 3 },
    supplier: { queryType: 'suppliers',typeCode: null }
  };

  // Single shared fetch: hits /api/ViewColumns once (Halo ignores the
  // `type=` query so we get every view in one round trip), filters
  // client-side by numeric `type` code, then for any view that lacks an
  // inline `columns` array, fetches the detail endpoint.
  async function loadViewColumnsForType(typeCode, queryType) {
    if (typeCode == null) return [];
    // List fetch — same params Halo's own UI uses.
    const listUrl = `/api/ViewColumns?showall=true&access_control_level=2&isconfig=true&type=${encodeURIComponent(queryType || '')}`;
    const resp = await haloApiRequest(listUrl);
    const all = Array.isArray(resp) ? resp : (resp?.viewcolumns || resp?.items || []);
    const matched = all.filter(v => Number(v?.type) === Number(typeCode));
    // Some views ship without an embedded columns array — fetch each
    // missing one with includedetails to retrieve its columns.
    await Promise.all(matched.map(async v => {
      if (Array.isArray(v.columns) && v.columns.length) return;
      try {
        const detail = await haloApiRequest(`/api/ViewColumns/${v.id}?includedetails=true`);
        if (detail && Array.isArray(detail.columns)) v.columns = detail.columns;
      } catch (_) {}
    }));
    return matched;
  }

  async function loadViewColumnLabels() {
    const entries = Object.entries(VIEW_COLUMN_ENTITY_TYPES);
    const results = await Promise.all(entries.map(async ([entity, cfg]) => {
      try {
        const views = await loadViewColumnsForType(cfg.typeCode, cfg.queryType);
        const labels = {};
        for (const view of views) {
          const cols = Array.isArray(view?.columns) ? view.columns : [];
          for (const c of cols) {
            const name = typeof c?.column_name === 'string' ? c.column_name.trim() : '';
            const override = typeof c?.column_title_override === 'string' ? c.column_title_override.trim() : '';
            if (!name) continue;
            if (override && !labels[name]) labels[name] = override;
            if (!override && !(name in labels)) labels[name] = '';
          }
        }
        return [entity, labels];
      } catch (_) {
        return [entity, {}];
      }
    }));
    return Object.fromEntries(results);
  }

  // Per-table column profiles — Halo lets users define column sets ("views")
  // per entity. Each profile picks a subset of columns to display in the
  // list grid. The Data Viewer can offer these as preset column layouts so
  // the user sees the same columns they would in Halo's own list view.
  // Cached per-entity for the session.
  async function loadColumnProfilesForEntity(entity) {
    const cfg = VIEW_COLUMN_ENTITY_TYPES[entity];
    if (!cfg || cfg.typeCode == null) return [];
    if (!HU.viewColumnProfileCache) HU.viewColumnProfileCache = {};
    if (HU.viewColumnProfileCache[entity]) return HU.viewColumnProfileCache[entity];
    try {
      const views = await loadViewColumnsForType(cfg.typeCode, cfg.queryType);
      const profiles = views.map(view => {
        const cols = Array.isArray(view?.columns) ? view.columns : [];
        return {
          id: view?.id,
          name: String(view?.name || 'Unnamed view').trim() || 'Unnamed view',
          type: view?.type,
          type_name: view?.type_name || '',
          columns: cols.map(c => ({
            name: String(c?.column_name || '').trim(),
            label: String(c?.column_title_override || '').trim(),
            width: c?.width || 0,
            order: c?.column_seq || 0
          })).filter(c => c.name)
        };
      }).filter(p => p.columns.length);
      HU.viewColumnProfileCache[entity] = profiles;
      return profiles;
    } catch (_) {
      HU.viewColumnProfileCache[entity] = [];
      return [];
    }
  }

  async function loadAllCustomFields() {
    const entities = Object.keys(ENTITY_TYPE_ID);
    const results = await Promise.all(entities.map(e => loadCustomFieldsRaw(e).then(cfs => [e, cfs])));
    return Object.fromEntries(results);
  }

  function loadCustomFieldMap(entityKey) {
    if (!entityKey) return Promise.resolve({});
    if (HU.customFieldMap[entityKey]) return Promise.resolve(HU.customFieldMap[entityKey]);
    if (HU.customFieldMapPromises[entityKey]) return HU.customFieldMapPromises[entityKey];

    const typeid = ENTITY_TYPE_ID[entityKey];
    if (typeid == null) return Promise.resolve({});

    const storageKey = `huCustomFields_${entityKey}`;

    HU.customFieldMapPromises[entityKey] = (async () => {
      try {
        const stored = await new Promise(r => chrome.storage.local.get(storageKey, r));
        const cached = stored && stored[storageKey];
        if (cached && cached.entries && typeof cached.entries === 'object') {
          HU.customFieldMap[entityKey] = cached.entries;
          return cached.entries;
        }
      } catch (_) {}

      try {
        const resp = await haloApiRequest(
          `/api/FieldInfo?iscustomfieldsetup=true&access_control_level=2&isconfig=true&typeid=${typeid}`
        );
        const arr = Array.isArray(resp) ? resp : (resp?.fields || resp?.fieldinfos || resp?.items || []);
        const entries = {};
        for (const f of arr) {
          if (!f || typeof f !== 'object') continue;
          const name = typeof f.name === 'string' ? f.name.trim() : '';
          const label = typeof f.label === 'string' ? f.label.trim() : '';
          if (!name || !label) continue;
          entries[label.toLowerCase()] = name;
        }
        HU.customFieldMap[entityKey] = entries;
        try {
          chrome.storage.local.set({
            [storageKey]: { entries, fetchedAt: Date.now() }
          });
        } catch (_) {}
        return entries;
      } catch (_) {
        HU.customFieldMap[entityKey] = {};
        return {};
      }
    })();

    return HU.customFieldMapPromises[entityKey];
  }

  // ----- Slot-name resolver, fallback path -----
  // Used when /api/Languages can't be loaded (permission denied, etc.) or
  // is still in flight on first activation. Discovers the slot by
  // value-matching the form input contents against the live API record.

  async function getSlotRecordSafely() {
    try {
      const ctx = detectSlotRecordContext();
      if (!ctx) return null;
      if (!HU.slotRecordCache) HU.slotRecordCache = {};
      const key = ctx.apiPath;
      if (HU.slotRecordCache[key]) return HU.slotRecordCache[key];
      const promise = haloApiRequest(ctx.apiPath).catch(() => null);
      HU.slotRecordCache[key] = promise;
      return promise;
    } catch (_) {
      return null;
    }
  }

  function detectSlotRecordContext() {
    const ctx = detectCurrentRecordQuery();
    if (!ctx) return null;
    if (!['User', 'Customer', 'Asset', 'Supplier', 'Site'].includes(ctx.type)) return null;
    return ctx;
  }

  // Custom-field resolution covers everything in detectSlotRecordContext PLUS
  // tickets — ticket forms have custom fields with the same DOM-slug issue,
  // even though they don't carry `other1..N` slots.
  function detectCustomFieldContext() {
    const ctx = detectCurrentRecordQuery();
    if (!ctx) return null;
    if (!['User', 'Customer', 'Asset', 'Supplier', 'Site', 'Ticket'].includes(ctx.type)) return null;
    return ctx;
  }

  function buildSlotValueMap(record) {
    // value → slot name. Skip empty / null so blank form fields don't
    // collide. If the same value appears in two slots, mark it ambiguous
    // (null) so we don't pick the wrong one.
    const map = new Map();
    const slotFamilies = ['other', 'inv', 'userdef'];
    for (const family of slotFamilies) {
      for (let i = 1; i <= 25; i++) {
        const slot = `${family}${i}`;
        if (!(slot in record)) continue;
        const v = record[slot];
        if (v == null) continue;
        const str = String(v).trim();
        if (!str) continue;
        if (map.has(str)) map.set(str, null);
        else map.set(str, slot);
      }
    }
    return map;
  }

  // ----- Value-matching fallback (ticket forms) -----
  // Defensive fallback for labels that have no `for` attribute and no CF/slot
  // match — read the form input's current value and look it up in a map built
  // from the live ticket record. Restricted to own-entity scalars now that
  // the DOM is the primary signal; cross-entity dot-paths are no longer
  // produced (the DOM always points at the ticket's own field).

  function loadTicketRecord(ticketId) {
    const key = String(ticketId);
    if (HU.ticketRecordPromises[key]) return HU.ticketRecordPromises[key];

    // Include extras that Ticket 360 surfaces (linked objects, last/next
    // appointment, "seen by"). Cheap additions to the same call so we
    // don't pay a second round trip when 360 opens. `includeauditing` is
    // deliberately left off — its payload is heavy and we don't render
    // it yet.
    HU.ticketRecordPromises[key] = (async () => {
      try {
        const ticket = await haloApiRequest(
          `/api/tickets/${ticketId}?includedetails=true&includelinkedobjects=true` +
          `&includelastappointment=true&includenextappointment=true&includeseenby=true`
        );
        if (!ticket || typeof ticket !== 'object') return null;
        return ticket;
      } catch (_) {
        return null;
      }
    })();

    return HU.ticketRecordPromises[key];
  }

  function buildTicketValueMap(record) {
    if (!record) return null;
    const map = new Map();
    buildRecordValuePathMap(record, map);
    return map;
  }

  // Runtime validation for resolved field names. Walks the dot-path against
  // the cached record. Returns true if the leaf key exists (even if
  // null/empty), false if any segment is missing, null if we have no record
  // to check against. Caller treats null as "don't validate" so the legacy
  // behaviour persists when the record isn't loaded yet (first activation,
  // 403 on fetch, etc.).
  function pathExistsInRecord(record, path) {
    if (!record) return null;
    if (!path || typeof path !== 'string') return null;
    const parts = path.split('.');
    let node = record;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (node == null || typeof node !== 'object') return false;
      node = node[p];
    }
    if (node == null || typeof node !== 'object') return false;
    return parts[parts.length - 1] in node;
  }

  // Walk top-level scalars of a record into `{ lowercaseValue: fieldName }`.
  // Skips nested objects entirely — the DOM-parsed `for` attribute always
  // gives us the ticket's own field, never a cross-entity dot-path, so the
  // value-matcher only needs to bridge "label without `for`" cases on the
  // current entity. Colliding values are marked `null` so we never tag
  // ambiguously.
  function buildRecordValuePathMap(node, map) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (value == null || typeof value === 'object') continue;
      const str = normaliseValueForMatch(value);
      if (!str) continue;
      if (map.has(str)) {
        if (map.get(str) !== key) map.set(str, null);
      } else {
        map.set(str, key);
      }
    }
  }

  function normaliseValueForMatch(value) {
    if (value === true || value === false) return '';
    const str = String(value).trim();
    if (!str) return '';
    // Halo "no value" date sentinel + pure numeric ids — both collide heavily.
    if (/^(1900-01-01|0001-01-01)/.test(str)) return '';
    if (/^-?\d+$/.test(str)) return '';
    if (str.length > 200) return '';
    return str.toLowerCase();
  }

  function resolveDotPathForLabel(label, pathMap) {
    if (!pathMap || pathMap.size === 0) return null;
    const values = collectLabelDisplayValues(label);
    for (const v of values) {
      const path = pathMap.get(v);
      if (path) return path;
    }
    return null;
  }

  // Shared input/value scanner — mirrors the per-label collection logic in
  // resolveSlotForLabel(). Kept separate so changes to slot resolution can't
  // silently break value-matching for tickets.
  function collectLabelDisplayValues(label) {
    const values = new Set();
    const addValue = (raw) => {
      if (raw == null) return;
      const v = normaliseValueForMatch(raw);
      if (v) values.add(v);
    };

    const forId = label.getAttribute('for');
    if (forId) {
      const el = document.getElementById(forId);
      if (el) addValue(el.value != null ? el.value : el.textContent);
    }

    const container = label.closest('div, li, tr, section, [class*="field"], [class*="form-group"], [class*="form-row"]') || label.parentElement;
    if (container) {
      container.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach(el => {
        addValue(el.value != null ? el.value : el.textContent);
      });
      container.querySelectorAll('div, span, p, a, td').forEach(el => {
        if (el === label || label.contains(el) || el.contains(label)) return;
        if (el.classList.contains('hu-field-tag')) return;
        if (el.querySelector('.hu-field-tag')) return;
        if (el.children.length > 0) return;
        addValue(el.textContent);
      });
    }
    return values;
  }

  function resolveSlotForLabel(label, slotMap) {
    // Collect every candidate value near the label — inputs (editable forms),
    // textareas / selects / contenteditables, AND leaf text nodes inside the
    // field's container (read-only display views render the value as plain
    // text in a sibling <div>/<span>). Then look each candidate up in the
    // slot map.
    const values = new Set();
    const addValue = (raw) => {
      if (raw == null) return;
      const v = String(raw).trim();
      if (v && v.length <= 200) values.add(v);
    };

    const forId = label.getAttribute('for');
    if (forId) {
      const el = document.getElementById(forId);
      if (el) addValue(el.value != null ? el.value : el.textContent);
    }

    const container = label.closest('div, li, tr, section, [class*="field"], [class*="form-group"], [class*="form-row"]') || label.parentElement;
    if (container) {
      container.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach(el => {
        addValue(el.value != null ? el.value : el.textContent);
      });
      // Leaf text elements — exclude the label itself and our own overlay tags.
      container.querySelectorAll('div, span, p, a, td').forEach(el => {
        if (el === label || label.contains(el) || el.contains(label)) return;
        if (el.classList.contains('hu-field-tag')) return;
        if (el.querySelector('.hu-field-tag')) return;
        if (el.children.length > 0) return;
        addValue(el.textContent);
      });
    }

    for (const v of values) {
      const slot = slotMap.get(v);
      if (slot) return slot;
    }
    return null;
  }

  function isTableCheckboxLabel(label) {
    if (!label) return false;
    const hasCheckbox = Boolean(label.querySelector('input[type="checkbox"], [role="checkbox"]'));
    if (!hasCheckbox) return false;
    return Boolean(label.closest('.rt-thead, .rt-tbody, .rt-tr, .rt-tr-group, table, [role="grid"], [role="table"]'));
  }

  function revealTableColumnNames() {
    const headers = getTableColumnHeaders();

    headers.forEach(header => {
      if (header.closest('.hu-palette, .hu-drawer, .hu-toast')) return;
      if (header.querySelector('.hu-table-column-tag')) return;
      if (isSelectionColumnHeader(header)) return;

      const apiName = getTableColumnApiName(header);
      if (!apiName) return;
      if (isSelectionColumnName(apiName)) return;

      const tag = document.createElement('span');
      tag.className = 'hu-field-tag hu-table-column-tag';
      tag.textContent = apiName;
      const target = getTableHeaderLabelTarget(header);
      target.classList.add('hu-table-column-label-target');
      target.appendChild(tag);
    });
  }

  function getTableHeaderLabelTarget(header) {
    return header.querySelector('.hashoverbtn') ||
      [...header.querySelectorAll('.rt-resizable-header-content')]
        .find(node => normalizeHeaderLabel(node.textContent)) ||
      header;
  }

  function getTableColumnHeaders() {
    const headers = new Set(document.querySelectorAll('th, [role="columnheader"], .rt-thead .rt-th'));
    document.querySelectorAll('[class]').forEach(element => {
      if (element.closest('.rt-thead .rt-th') && !element.classList?.contains('rt-th')) return;
      const className = String(element.className || '').toLowerCase();
      if (className.includes('columnheader') ||
          className.includes('column-header') ||
          className.includes('headercell') ||
          className.includes('header-cell') ||
          className.includes('ag-header-cell') ||
          className.includes('table-header')) {
        headers.add(element);
      }
    });
    return [...headers];
  }

  function getTableColumnApiName(header) {
    const candidates = [header];
    candidates.push(...header.querySelectorAll([
      '[name]',
      '[id]',
      '[data-field]',
      '[data-field-name]',
      '[data-fieldname]',
      '[data-column]',
      '[data-column-id]',
      '[data-columnid]',
      '[data-column-name]',
      '[data-name]',
      '[data-col]',
      '[data-key]',
      '[data-property]',
      '[data-sort]',
      '[data-sort-key]',
      '[data-accessor]',
      '[col-id]',
      '[field]',
      '[aria-label]'
    ].join(',')));

    for (const element of candidates) {
      const value = element?.getAttribute?.('data-field') ||
        element?.getAttribute?.('data-field-name') ||
        element?.getAttribute?.('data-fieldname') ||
        element?.getAttribute?.('data-column') ||
        element?.getAttribute?.('data-column-id') ||
        element?.getAttribute?.('data-columnid') ||
        element?.getAttribute?.('data-column-name') ||
        element?.getAttribute?.('data-name') ||
        element?.getAttribute?.('data-col') ||
        element?.getAttribute?.('data-key') ||
        element?.getAttribute?.('data-property') ||
        element?.getAttribute?.('data-sort') ||
        element?.getAttribute?.('data-sort-key') ||
        element?.getAttribute?.('data-accessor') ||
        element?.getAttribute?.('col-id') ||
        element?.getAttribute?.('field') ||
        element?.getAttribute?.('name') ||
        element?.getAttribute?.('id') ||
        element?.getAttribute?.('aria-label');
      const cleaned = cleanFieldName(value);
      if (cleaned && !isGeneratedDomId(cleaned) && !isSelectionColumnName(cleaned)) return cleaned;
    }

    return getKnownTableColumnName(header);
  }

  function getKnownTableColumnName(header) {
    const label = getTableHeaderLabel(header);
    if (!label) return '';

    const ticketColumns = {
      id: 'Faultid',
      agent: 'AssignedToInt',
      summary: 'Symptom',
      'change type': 'RequestTypeNew',
      'ticket type': 'RequestTypeNew',
      type: 'RequestTypeNew',
      status: 'Status',
      'asset tag': 'DInvNo',
      asset: 'DeviceNumber',
      'related services': 'FServiceid',
      service: 'FServiceid',
      'start date time': 'DateOccured',
      'start date': 'DateOccured',
      opened: 'DateOccured',
      'end date time': 'DateCleared',
      'end date': 'DateCleared',
      closed: 'DateCleared',
      priority: 'Seriousness',
      client: 'Areaint',
      customer: 'Areaint',
      site: 'SiteNumber',
      team: 'Sectio_',
      category: 'Category2'
    };

    return ticketColumns[label] || '';
  }

  function getTableHeaderLabel(header) {
    const target = header.querySelector('.hashoverbtn') ||
      header.querySelector('.rt-resizable-header-content') ||
      header;
    const clone = target.cloneNode(true);
    clone.querySelectorAll('button, svg, i, .hu-field-tag, .rt-resizer, input, label').forEach(node => node.remove());
    return normalizeHeaderLabel(clone.textContent);
  }

  function normalizeHeaderLabel(value) {
    return String(value || '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isSelectionColumnHeader(header) {
    if (!header) return false;
    const text = (header.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const checkbox = header.querySelector('input[type="checkbox"], [role="checkbox"]');
    const headerLabel = getTableHeaderLabel(header);
    if (checkbox && (!headerLabel || /^(select|select all|selection|checkbox|bulk select|bulk select all)$/.test(headerLabel))) return true;

    const attrs = [
      header.getAttribute('aria-label'),
      header.getAttribute('title'),
      header.getAttribute('data-field'),
      header.getAttribute('data-field-name'),
      header.getAttribute('data-fieldname'),
      header.getAttribute('data-column'),
      header.getAttribute('data-column-id'),
      header.getAttribute('data-columnid'),
      header.getAttribute('data-column-name'),
      header.getAttribute('data-name'),
      header.getAttribute('data-col'),
      header.getAttribute('data-key'),
      header.getAttribute('data-property'),
      header.getAttribute('data-sort'),
      header.getAttribute('data-sort-key'),
      header.getAttribute('col-id'),
      header.getAttribute('field'),
      header.getAttribute('class')
    ].join(' ').toLowerCase();

    return /(^|[\s_-])(select|selection|checkbox|check-box|bulk|rowselect|row-select)([\s_-]|$)/.test(attrs) &&
      (!text || /^(select|select all|selection|checkbox)$/.test(text));
  }

  function isSelectionColumnName(value) {
    const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^(bulk_)?select(_all)?$/.test(normalized) ||
      /^(bulk|selection|checkbox|check_box|row_select|rowselect|select_checkbox|checkbox_select)$/.test(normalized) ||
      normalized.includes('bulk_select') ||
      normalized.includes('row_select');
  }

  function getFieldApiName(label, record) {
    const forId = label.getAttribute('for');

    // Primary signal: Halo encodes the canonical field name directly in the
    // label's `for` attribute as `input-field-for-{name}{optional-suffix}`.
    // This works on read-only forms too, where Halo renders <div> instead of
    // <input> so the usual element lookup returns nothing.
    //
    // Suffix patterns Halo appends for unique DOM ids:
    //   `tickettype_id:12be36cec1-...`            colon-prefixed lookup hint
    //   `category_1:T=1A=12S=1st Line Support...` same, with multiple params
    //   `services_D=undefined43712bc0-...`        equals-prefixed param + GUID
    //   `workflow_id3ca0a783-...`                 trailing GUID (8-4-4-4-12 hex)
    //   `status_id1df421d64-...`                  trailing GUID + 1 extra hex prefix
    //   `additional_agents0cbda18b-...`           trailing GUID without prefix
    const parsed = parseInputFieldForId(forId, record);
    if (parsed) return parsed;

    const candidates = [];
    if (forId) candidates.push(document.getElementById(forId));
    const parent = label.closest('div, li, tr, section') || label.parentElement;
    if (parent) candidates.push(...parent.querySelectorAll('input, textarea, select, [name], [data-field], [data-fieldname], [data-column], [data-name]'));

    for (const element of candidates) {
      const value = element?.getAttribute?.('name') ||
        element?.getAttribute?.('id') ||
        element?.getAttribute?.('data-field') ||
        element?.getAttribute?.('data-fieldname') ||
        element?.getAttribute?.('data-column') ||
        element?.getAttribute?.('data-name') ||
        element?.getAttribute?.('aria-label');
      const cleaned = cleanFieldName(value);
      if (cleaned) return cleaned;
    }

    return label.textContent ? label.textContent.trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() : '';
  }

  function parseInputFieldForId(forId, record) {
    if (!forId || typeof forId !== 'string') return '';
    if (!forId.startsWith('input-field-for-')) return '';
    let raw = forId.slice('input-field-for-'.length);
    // Strip Halo's `_PARAM=value...` lookup-metadata suffix first (e.g.
    // `services_D=undefined<guid>`, where `_D` is the param marker — without
    // this, the bare `[:=]` strip below would leave the `_D` orphaned on
    // the field name). Real Halo canonical names are lowercase, so
    // `_[A-Z]+=` only matches the metadata pattern.
    raw = raw.replace(/_[A-Z]+=.*$/, '');
    // Strip colon-prefixed lookup metadata (e.g. ":T=1A=12...") or any
    // leftover equals-prefixed value.
    raw = raw.replace(/[:=].*$/, '');
    // Two candidate GUID-suffix strips:
    //   longer  — assume no extra char before the GUID
    //              (e.g. `workflow_id` from `workflow_id<guid>`)
    //   shorter — assume Halo glued one hex char before the GUID
    //              (e.g. `status_id`  from `status_id1<guid>` where Halo
    //              prefixed the GUID with the field's current value `1`)
    // The DOM alone can't disambiguate: both shapes are valid GUIDs because
    // the first segment is just 8 hex chars in either reading. Pick the
    // candidate that actually exists on the live record; default to the
    // longer (less destructive) when the record isn't loaded.
    const GUID = '[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const longer  = raw.replace(new RegExp('[0-9a-f]{8}-' + GUID, 'i'), '');
    const shorter = raw.replace(new RegExp('[0-9a-f][0-9a-f]{8}-' + GUID, 'i'), '');
    if (longer === shorter) return cleanFieldName(longer);
    if (record && typeof record === 'object') {
      if (longer in record)  return cleanFieldName(longer);
      if (shorter in record) return cleanFieldName(shorter);
    }
    return cleanFieldName(longer);
  }

  function cleanFieldName(value) {
    if (!value) return '';
    const cleaned = String(value).trim().replace(/^react-select-\d+-/, '').replace(/[^a-zA-Z0-9_.-]+/g, '_');
    if (!cleaned || cleaned.length > 80) return '';
    return cleaned;
  }

  function isGeneratedDomId(value) {
    return /^(react-select|mui-|radix-|headlessui-|rc_|:r|cell-|row-|grid-)/i.test(value);
  }

  async function openJsonInspector() {
    injectStyles();
    closeDrawer('hu-recent-drawer');
    closeDrawer('hu-json-drawer');

    const drawer = createDrawer('hu-json-drawer', 'Record JSON inspector');
    const body = drawer.querySelector('.hu-drawer-body');
    body.innerHTML = '<div class="hu-row"><span class="hu-row-title">Loading current record...</span></div>';
    openDrawer(drawer);

    try {
      const record = detectCurrentRecordQuery();
      if (!record) {
        body.innerHTML = '<div class="hu-row"><span class="hu-row-title">No supported record detected</span><span class="hu-row-sub">Open a ticket, customer, site, user, agent, asset, KB article, quotation, sales order, purchase order, invoice, contract, project, or supplier record and run this command again.</span></div>';
        return;
      }

      const row = await haloApiRequest(record.apiPath);
      if (!row || typeof row !== 'object') {
        body.innerHTML = '<div class="hu-row"><span class="hu-row-title">No payload returned</span><span class="hu-row-sub">Halo returned an empty response.</span></div>';
        return;
      }

      renderJsonInspector(body, row, record);
    } catch (error) {
      const msg = (error && error.message) || String(error || '');
      const isPerm = isReportPermissionError(msg);
      const title = isPerm
        ? "You don't have permission to view this record"
        : "Could not load JSON";
      const detail = isPerm
        ? "Your Halo agent role doesn't allow viewing this record via the API. Ask an admin to grant you access."
        : (msg || 'Unknown error.');
      body.innerHTML = '<div class="hu-row"><span class="hu-row-title">' + escapeHtml(title) + '</span><span class="hu-row-sub">' + escapeHtml(detail) + '</span></div>';
    }
  }

  function renderJsonInspector(body, row, record) {
    body.innerHTML = '';
    const jsonText = JSON.stringify(row, null, 2);
    let viewMode = 'tree';

    const toolbar = document.createElement('div');
    toolbar.className = 'hu-json-toolbar';
    toolbar.innerHTML = `
      <div class="hu-json-toolbar-meta">
        <span class="hu-row-title">${escapeHtml(record.type)} ${escapeHtml(record.id)}</span>
        <span class="hu-row-sub">GET ${escapeHtml(record.apiPath)}</span>
      </div>
      <div class="hu-json-toolbar-controls">
        <input type="search" class="hu-json-search" placeholder="Search keys or values..." aria-label="Search JSON" />
        <div class="hu-json-view-toggle" role="tablist">
          <button class="hu-json-view-btn is-active" data-view="tree" type="button">Tree</button>
          <button class="hu-json-view-btn" data-view="raw" type="button">Raw</button>
        </div>
        <button class="hu-json-action hu-json-expand" type="button" title="Expand all nodes">Expand all</button>
        <button class="hu-json-action hu-json-collapse" type="button" title="Collapse all nodes">Collapse all</button>
        <button class="hu-copy hu-copy-json" type="button" title="Copy JSON to clipboard">Copy JSON</button>
      </div>
      <div class="hu-json-count"></div>
    `;
    body.appendChild(toolbar);

    const treeHost = document.createElement('div');
    treeHost.className = 'hu-json-tree';
    body.appendChild(treeHost);

    const rawHost = document.createElement('pre');
    rawHost.className = 'hu-json-formatted hu-json-raw';
    rawHost.style.display = 'none';
    rawHost.textContent = jsonText;
    body.appendChild(rawHost);

    const rootNode = buildJsonNode('$', row, '', 0, true);
    treeHost.appendChild(rootNode);

    const searchInput = toolbar.querySelector('.hu-json-search');
    const expandBtn = toolbar.querySelector('.hu-json-expand');
    const collapseBtn = toolbar.querySelector('.hu-json-collapse');
    const countEl = toolbar.querySelector('.hu-json-count');
    const viewBtns = toolbar.querySelectorAll('.hu-json-view-btn');
    const copyBtn = toolbar.querySelector('.hu-copy-json');

    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(jsonText).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1500);
      });
    });

    function setAllExpansion(expanded) {
      treeHost.querySelectorAll('.hu-json-node.is-collapsible').forEach(n => {
        n.classList.toggle('is-open', expanded);
      });
    }
    expandBtn.addEventListener('click', () => setAllExpansion(true));
    collapseBtn.addEventListener('click', () => setAllExpansion(false));

    function setView(mode) {
      viewMode = mode;
      viewBtns.forEach(b => b.classList.toggle('is-active', b.dataset.view === mode));
      treeHost.style.display = mode === 'tree' ? '' : 'none';
      rawHost.style.display = mode === 'raw' ? '' : 'none';
      expandBtn.style.display = mode === 'tree' ? '' : 'none';
      collapseBtn.style.display = mode === 'tree' ? '' : 'none';
      applySearch(searchInput.value);
    }
    viewBtns.forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

    function applySearch(query) {
      const q = String(query || '').trim().toLowerCase();
      if (viewMode === 'tree') {
        const matches = filterJsonTree(treeHost, q);
        countEl.textContent = q ? `${matches} match${matches === 1 ? '' : 'es'}` : '';
      } else {
        renderRawWithHighlight(rawHost, jsonText, q);
        countEl.textContent = q ? '' : '';
      }
    }
    searchInput.addEventListener('input', e => applySearch(e.target.value));

    setView('tree');
  }

  function buildJsonNode(key, value, parentPath, depth, isRoot) {
    const node = document.createElement('div');
    node.className = 'hu-json-node';
    const path = isRoot
      ? '$'
      : (typeof key === 'number'
          ? `${parentPath}[${key}]`
          : (parentPath === '$' ? key : `${parentPath}.${key}`));
    node.dataset.path = path;

    const type = jsonValueType(value);
    const isContainer = type === 'object' || type === 'array';

    if (isContainer) {
      const entries = type === 'array'
        ? value.map((v, i) => [i, v])
        : Object.entries(value);
      const count = entries.length;

      node.classList.add('is-collapsible');
      if (depth < 1) node.classList.add('is-open');

      const header = document.createElement('div');
      header.className = 'hu-json-node-header';

      const arrow = document.createElement('span');
      arrow.className = 'hu-json-arrow';
      arrow.textContent = '▶';
      header.appendChild(arrow);

      const keySpan = document.createElement('span');
      keySpan.className = 'hu-json-key';
      keySpan.textContent = isRoot ? '$' : (typeof key === 'number' ? `[${key}]` : key);
      header.appendChild(keySpan);

      if (!isRoot) {
        const sep = document.createElement('span');
        sep.className = 'hu-json-sep';
        sep.textContent = ':';
        header.appendChild(sep);
      }

      const summary = document.createElement('span');
      summary.className = 'hu-json-summary';
      summary.textContent = type === 'array' ? `[ ${count} ]` : `{ ${count} }`;
      header.appendChild(summary);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'hu-copy hu-json-copy-btn';
      copyBtn.title = 'Copy path';
      copyBtn.textContent = 'Copy path';
      copyBtn.addEventListener('click', e => { e.stopPropagation(); copyText(path); });
      header.appendChild(copyBtn);

      header.addEventListener('click', () => node.classList.toggle('is-open'));
      node.appendChild(header);

      const childrenHost = document.createElement('div');
      childrenHost.className = 'hu-json-children';
      entries.forEach(([k, v]) => {
        childrenHost.appendChild(buildJsonNode(k, v, path, depth + 1, false));
      });
      node.appendChild(childrenHost);

      node.dataset.searchText = (isRoot ? '' : String(key)).toLowerCase();
    } else {
      const leaf = document.createElement('div');
      leaf.className = 'hu-json-leaf';

      const keySpan = document.createElement('span');
      keySpan.className = 'hu-json-key';
      keySpan.textContent = typeof key === 'number' ? `[${key}]` : key;
      leaf.appendChild(keySpan);

      const sep = document.createElement('span');
      sep.className = 'hu-json-sep';
      sep.textContent = ': ';
      leaf.appendChild(sep);

      const valueSpan = document.createElement('span');
      valueSpan.className = `hu-json-value hu-json-${type}`;
      const formatted = formatJsonLeaf(value, type);
      valueSpan.textContent = formatted;
      leaf.appendChild(valueSpan);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'hu-copy hu-json-copy-btn';
      copyBtn.title = 'Copy value';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', e => {
        e.stopPropagation();
        copyText(type === 'string' ? String(value) : formatted);
      });
      leaf.appendChild(copyBtn);

      node.appendChild(leaf);
      node.dataset.searchText = `${String(key)} ${formatted}`.toLowerCase();
    }

    return node;
  }

  function jsonValueType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function formatJsonLeaf(value, type) {
    if (type === 'null') return 'null';
    if (type === 'string') return `"${value}"`;
    if (type === 'undefined') return 'undefined';
    return String(value);
  }

  function filterJsonTree(host, query) {
    const allNodes = Array.from(host.querySelectorAll('.hu-json-node'));
    allNodes.forEach(n => {
      n.classList.remove('is-match', 'has-match', 'in-match-branch');
      n.style.display = '';
    });
    if (!query) return 0;
    let matchCount = 0;
    allNodes.forEach(n => {
      if (n.dataset.searchText && n.dataset.searchText.includes(query)) {
        n.classList.add('is-match');
        matchCount++;
      }
    });
    allNodes.forEach(n => {
      if (!n.classList.contains('is-match')) return;
      let parent = n.parentElement;
      while (parent && parent !== host) {
        if (parent.classList && parent.classList.contains('hu-json-node')) {
          parent.classList.add('has-match', 'is-open');
        }
        parent = parent.parentElement;
      }
      n.querySelectorAll('.hu-json-node').forEach(d => d.classList.add('in-match-branch'));
      if (n.classList.contains('is-collapsible')) n.classList.add('is-open');
    });
    allNodes.forEach(n => {
      const visible = n.classList.contains('is-match')
        || n.classList.contains('has-match')
        || n.classList.contains('in-match-branch');
      if (!visible) n.style.display = 'none';
    });
    return matchCount;
  }

  function renderRawWithHighlight(pre, jsonText, query) {
    if (!query) {
      pre.textContent = jsonText;
      return;
    }
    const escapedJson = escapeHtml(jsonText);
    const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escapedQuery, 'gi');
    pre.innerHTML = escapedJson.replace(re, m => `<mark class="hu-json-mark">${m}</mark>`);
  }

  function detectCurrentRecordQuery() {
    const url = new URL(window.location.href);
    const path = url.pathname.toLowerCase();
    const params = url.searchParams;

    // 1. Specific id-name params are unambiguous — `userid=21` means a User
    //    record regardless of whether the path is `/customers` (Halo nests
    //    users under Customers in its UI). Check these BEFORE the path.
    const byParam = [
      ['userid',     'User',           id => `/api/users/${id}`],
      ['agentid',    'Agent',          id => `/api/agent/${id}`],
      ['clientid',   'Customer',       id => `/api/client/${id}`],
      ['siteid',     'Site',           id => `/api/site/${id}`],
      ['kbid',       'KB article',     id => `/api/KBArticle/${id}`],
      ['articleid',  'KB article',     id => `/api/KBArticle/${id}`],
      ['quoteid',    'Quotation',      id => `/api/quotation/${id}`],
      ['orderid',    'Sales order',    id => `/api/salesorder/${id}`],
      ['poid',       'Purchase order', id => `/api/purchaseorder/${id}`],
      ['invoiceid',  'Invoice',        id => `/api/invoice/${id}`],
      ['projectid',  'Project',        id => `/api/project/${id}`],
      ['contractid', 'Contract',       id => `/api/contract/${id}`],
      ['supplierid', 'Supplier',       id => `/api/supplier/${id}`],
      ['faultid',    'Ticket',         id => `/api/tickets/${id}`]
    ];
    for (const [param, type, build] of byParam) {
      const raw = params.get(param);
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      return { type, id: String(n), apiPath: build(n) };
    }

    // 2. Fall back to the generic `id=` / `selid=` param + path context.
    const id = params.get('id') || params.get('selid');
    if (!id) return null;
    const safeId = Number(id);
    if (!Number.isFinite(safeId)) return null;

    if ((path.includes('/ticket') || path.includes('/fault')) && !path.includes('/config/')) {
      return { type: 'Ticket', id, apiPath: `/api/tickets/${safeId}` };
    }
    if (path.includes('/knowledgebase') || path.includes('/kb')) {
      return { type: 'KB article', id, apiPath: `/api/KBArticle/${safeId}` };
    }
    if (path.includes('/quotation') || path.includes('/quote')) {
      return { type: 'Quotation', id, apiPath: `/api/quotation/${safeId}` };
    }
    if (path.includes('/salesorder') || path.includes('/sales-order') || path.includes('/orders')) {
      return { type: 'Sales order', id, apiPath: `/api/salesorder/${safeId}` };
    }
    if (path.includes('/purchaseorder') || path.includes('/purchase-order')) {
      return { type: 'Purchase order', id, apiPath: `/api/purchaseorder/${safeId}` };
    }
    if (path.includes('/invoice')) {
      return { type: 'Invoice', id, apiPath: `/api/invoice/${safeId}` };
    }
    if (path.includes('/contract')) {
      return { type: 'Contract', id, apiPath: `/api/contract/${safeId}` };
    }
    if (path.includes('/project')) {
      return { type: 'Project', id, apiPath: `/api/project/${safeId}` };
    }
    if (path.includes('/supplier')) {
      return { type: 'Supplier', id, apiPath: `/api/supplier/${safeId}` };
    }
    if (path.includes('/customer') || path.includes('/area') || path.includes('/client')) {
      return { type: 'Customer', id, apiPath: `/api/client/${safeId}` };
    }
    if (path.includes('/agent') || path.includes('/uname')) {
      return { type: 'Agent', id, apiPath: `/api/agent/${safeId}` };
    }
    if (path.includes('/user')) {
      return { type: 'User', id, apiPath: `/api/users/${safeId}` };
    }
    if (path.includes('/asset') || path.includes('/device')) {
      return { type: 'Asset', id, apiPath: `/api/asset/${safeId}` };
    }

    return null;
  }

  function getPushTarget() {
    return document.querySelector(
      '#maincontent, .maincontent, #MainContent, .MainContent, ' +
      '#main-content, .main-content, #main_content, ' +
      '[id*="maincontent"], app-root'
    ) || document.body;
  }

  function applyPushMode(width) {
    const el = getPushTarget();
    el.dataset.huPushOrig = JSON.stringify({
      width: el.style.width || '',
      maxWidth: el.style.maxWidth || '',
      transition: el.style.transition || ''
    });
    el.style.transition = 'width 0.3s, max-width 0.3s';
    el.style.width = `calc(100% - ${width}px)`;
    el.style.maxWidth = `calc(100% - ${width}px)`;
  }

  function removePushMode() {
    const el = getPushTarget();
    if (!el.dataset.huPushOrig) return;
    try {
      const orig = JSON.parse(el.dataset.huPushOrig);
      el.style.width = orig.width;
      el.style.maxWidth = orig.maxWidth;
      el.style.transition = orig.transition;
    } catch (e) { /* ignore */ }
    delete el.dataset.huPushOrig;
  }

  function createDrawer(id, title, onClose) {
    const drawer = document.createElement('div');
    drawer.className = 'hu-drawer';
    drawer.id = id;
    drawer.style.transform = 'translateX(calc(100% + 40px))';
    drawer.innerHTML = `
      <div class="hu-drawer-header">
        <span class="hu-drawer-title">${escapeHtml(title)}</span>
        <button class="hu-icon-btn" title="Close" aria-label="Close">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="hu-drawer-body"></div>
    `;
    drawer.querySelector('.hu-icon-btn').addEventListener('click', () => {
      closeDrawer(id);
      if (onClose) onClose();
    });
    return drawer;
  }

  function openDrawer(drawer) {
    document.body.appendChild(drawer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      drawer.style.transform = '';
    }));
  }

  function hideHaloMenu() {
    const btn = document.querySelector('button.fabtn[title="Hide Menu"]');
    if (btn) { HU._hidHaloMenu = true; btn.click(); }
  }

  function showHaloMenu() {
    if (!HU._hidHaloMenu) return;
    HU._hidHaloMenu = false;
    const btn = document.querySelector('button.fabtn[title="Show Menu"]');
    if (btn) btn.click();
  }

  function hideHaloSidebars() {
    const containers = document.querySelectorAll('.hassidebar.sidebar-2s');
    const sidebars   = document.querySelectorAll('.details-sidebar');
    if (!containers.length && !sidebars.length) return false;
    HU._hiddenSidebarEls = [];
    containers.forEach(el => {
      HU._hiddenSidebarEls.push({ el, type: 'container' });
      el.classList.remove('hassidebar', 'sidebar-2s');
    });
    sidebars.forEach(el => {
      HU._hiddenSidebarEls.push({ el, type: 'sidebar', origDisplay: el.style.display });
      el.style.display = 'none';
    });
    return true;
  }

  function hideHaloSidebarsWithRetry() {
    hideHaloSidebars();
  }

  function showHaloSidebars() {
    if (!HU._hiddenSidebarEls?.length) return;
    HU._hiddenSidebarEls.forEach(({ el, type, origDisplay }) => {
      if (type === 'container') {
        el.classList.add('hassidebar', 'sidebar-2s');
      } else {
        el.style.display = origDisplay || '';
      }
    });
    HU._hiddenSidebarEls = null;
  }

  function closeDrawer(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'hu-ticket360-drawer') {
      removePushMode();
      showHaloMenu();
      showHaloSidebars();
      document.querySelectorAll('.hu-360-inject-btn').forEach(b => b.classList.remove('is-active'));
      stopTicket360LiveUpdates();
      closeAgentPicker();
      closeTicketChoicePicker();
      closeInlineNoteEditor();
    }
    el.style.transform = 'translateX(calc(100% + 40px))';
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }

  function toast(message) {
    injectStyles();
    const existing = document.getElementById('hu-toast');
    existing?.remove();
    const root = document.body || document.documentElement;
    if (!root) return;
    const el = document.createElement('div');
    el.id = 'hu-toast';
    el.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:2147483602;background:#172033;color:#fff;padding:8px 12px;border-radius:7px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.25)';
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
      if (el.isConnected) el.remove();
    }, 1800);
  }

  function cleanTitle(title) {
    return String(title || '').replace(/\s*[-|]\s*Halo.*$/i, '').trim();
  }

  function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  // Validate a color before interpolating it into a `style=` attribute.
  // Accepts hex (#abc / #aabbcc / #aabbccdd) and rgb/rgba(...) — rejects
  // anything else (function-like values, url(), CSS variables, etc.) that
  // could break out of the attribute and inject markup.
  function safeColor(value) {
    const raw = String(value ?? '').trim();
    return /^(#[0-9a-f]{3,8}|rgb(a)?\([^)]+\))$/i.test(raw) ? raw : '';
  }

  function copyText(value) {
    navigator.clipboard?.writeText(value).then(() => toast('Copied'));
  }

  function storageGet(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise(resolve => chrome.storage.local.set(value, resolve));
  }

  function sendContext() {
    chrome.runtime.sendMessage({
      type: 'HALO_CONTEXT',
      data: detectContext()
    });
  }


  const HU_CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function huCrc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = HU_CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function huZipFiles(files) {
    const enc = new TextEncoder();
    const entries = [];
    let localOffset = 0;
    for (const [name, content] of files) {
      const nameBytes = enc.encode(name);
      const dataBytes = enc.encode(content);
      entries.push({ nameBytes, dataBytes, crc: huCrc32(dataBytes), offset: localOffset });
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

  function huXlsxColRef(n) {
    let s = '';
    for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
    return s;
  }

  function huXlsxEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function tableDataToXlsx(headers, rows) {
    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
    sheetXml += '<row r="1">' + headers.map((h, ci) =>
      `<c r="${huXlsxColRef(ci)}1" t="inlineStr"><is><t>${huXlsxEsc(h)}</t></is></c>`
    ).join('') + '</row>';
    rows.forEach((row, ri) => {
      const rowNum = ri + 2;
      sheetXml += `<row r="${rowNum}">` + row.map((val, ci) => {
        const ref = `${huXlsxColRef(ci)}${rowNum}`;
        const num = Number(val);
        if (val !== '' && !isNaN(num) && isFinite(num)) return `<c r="${ref}"><v>${num}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t>${huXlsxEsc(val)}</t></is></c>`;
      }).join('') + '</row>';
    });
    sheetXml += '</sheetData></worksheet>';
    return huZipFiles([
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
      ['xl/worksheets/sheet1.xml', sheetXml],
    ]);
  }

  function tableDataToCSV(headers, rows) {
    const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return [headers.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n');
  }

  function tableDataToJSON(headers, rows) {
    return JSON.stringify(rows.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))), null, 2);
  }

  function huDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportData(headers, rows, format, sourceName = 'halo-export') {
    if (!headers.length || !rows.length) return;
    const slug = (document.title || 'halo-export')
      .replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
    const filename = slug || sourceName;
    if (format === 'xlsx') {
      huDownloadBlob(new Blob([tableDataToXlsx(headers, rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`);
    } else if (format === 'csv') {
      huDownloadBlob(new Blob([tableDataToCSV(headers, rows)], { type: 'text/csv' }), `${filename}.csv`);
    } else if (format === 'json') {
      huDownloadBlob(new Blob([tableDataToJSON(headers, rows)], { type: 'application/json' }), `${filename}.json`);
    }
  }

  function exportTable(table, format) {
    const data = extractTableData(table, { displayedOnly: true });
    exportData(data.headers, data.rows, format);
  }

  function attachExportButton(target, getData) {
    if (target.dataset.huExport) return;
    target.dataset.huExport = '1';
    const bar = document.createElement('div');
    bar.className = 'hu-tbl-export-bar';
    bar.innerHTML = `
      <div class="hu-tbl-export-wrap">
        <div role="listbox" aria-expanded="false" class="ui button dropdown hu-tbl-export-dropdown" tabindex="0">
          <button type="button" class="${getExportButtonClass()}" title="Export" aria-label="Export" style="background-color: rgb(255, 155, 81) !important; color: white !important;">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <path d="M7 10l5 5 5-5"></path>
              <path d="M12 15V3"></path>
            </svg>
          </button>
          <div class="right menu transition right hu-tbl-export-menu hu-hidden">
            <div class="item hu-tbl-export-item" data-fmt="xlsx" role="option">
              <svg viewBox="0 0 384 512" aria-hidden="true"><path d="M369.9 97.9L286 14C277 5 264.8-.1 252.1-.1H48C21.5 0 0 21.5 0 48v416c0 26.5 21.5 48 48 48h288c26.5 0 48-21.5 48-48V131.9c0-12.7-5.1-25-14.1-34zM347.3 120.6c2.1 2.1 3.5 4.6 4.2 7.4H256V32.5c2.8.7 5.3 2.1 7.4 4.2l83.9 83.9zM336 480H48c-8.8 0-16-7.2-16-16V48c0-8.8 7.2-16 16-16h176v104c0 13.3 10.7 24 24 24h104v304c0 8.8-7.2 16-16 16zM211.7 308l50.5-81.8c4.8-8-.9-18.2-10.3-18.2h-4.1c-4.1 0-7.9 2.1-10.1 5.5-31 48.5-36.4 53.5-45.7 74.5-17.2-32.2-8.4-16-45.8-74.5-2.2-3.4-6-5.5-10.1-5.5H132c-9.4 0-15.1 10.3-10.2 18.2L173 308l-59.1 89.5c-5.1 8 .6 18.5 10.1 18.5h3.5c4.1 0 7.9-2.1 10.1-5.5 37.2-58 45.3-62.5 54.4-82.5 31.5 56.7 44.3 67.2 54.4 82.6 2.2 3.4 6 5.4 10 5.4h3.6c9.5 0 15.2-10.4 10.1-18.4L211.7 308z"/></svg>
              <span>Export to Excel</span>
            </div>
            <div class="item hu-tbl-export-item" data-fmt="csv" role="option">
              <svg viewBox="0 0 384 512" aria-hidden="true"><path d="M369.9 97.9L286 14C277 5 264.8-.1 252.1-.1H48C21.5 0 0 21.5 0 48v416c0 26.5 21.5 48 48 48h288c26.5 0 48-21.5 48-48V131.9c0-12.7-5.1-25-14.1-34zM347.3 120.6c2.1 2.1 3.5 4.6 4.2 7.4H256V32.5c2.8.7 5.3 2.1 7.4 4.2l83.9 83.9zM336 480H48c-8.8 0-16-7.2-16-16V48c0-8.8 7.2-16 16-16h176v104c0 13.3 10.7 24 24 24h104v304c0 8.8-7.2 16-16 16zM211.7 308l50.5-81.8c4.8-8-.9-18.2-10.3-18.2h-4.1c-4.1 0-7.9 2.1-10.1 5.5-31 48.5-36.4 53.5-45.7 74.5-17.2-32.2-8.4-16-45.8-74.5-2.2-3.4-6-5.5-10.1-5.5H132c-9.4 0-15.1 10.3-10.2 18.2L173 308l-59.1 89.5c-5.1 8 .6 18.5 10.1 18.5h3.5c4.1 0 7.9-2.1 10.1-5.5 37.2-58 45.3-62.5 54.4-82.5 31.5 56.7 44.3 67.2 54.4 82.6 2.2 3.4 6 5.4 10 5.4h3.6c9.5 0 15.2-10.4 10.1-18.4L211.7 308z"/></svg>
              <span>Export to CSV</span>
            </div>
            <div class="item hu-tbl-export-item" data-fmt="json" role="option">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3M9.5 8.5 7 12l2.5 3.5M14.5 8.5 17 12l-2.5 3.5M13 7l-2 10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span>Export to JSON</span>
            </div>
          </div>
        </div>
      </div>`;
    const dropdown = bar.querySelector('.hu-tbl-export-dropdown');
    const btn = bar.querySelector('.hu-tbl-export-btn');
    const menu = bar.querySelector('.hu-tbl-export-menu');
    const setOpen = isOpen => {
      dropdown.classList.toggle('active', isOpen);
      dropdown.classList.toggle('visible', isOpen);
      dropdown.setAttribute('aria-expanded', String(isOpen));
      menu.classList.toggle('hu-hidden', !isOpen);
      menu.classList.toggle('visible', isOpen);
      if (isOpen) alignExportMenu(menu);
    };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeExportMenus();
      setOpen(menu.classList.contains('hu-hidden'));
    });
    bar.querySelectorAll('.hu-tbl-export-item').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        setOpen(false);
        const data = getData({ displayedOnly: true });
        exportData(data.headers, data.rows, item.dataset.fmt);
      });
    });
    const anchor = findExportButtonAnchor(target);
    if (anchor?.parentElement) {
      bar.classList.add('hu-tbl-export-inline');
      anchor.insertAdjacentElement('afterend', bar);
    } else {
      target.parentNode.insertBefore(bar, target);
    }
    return;
  }

  function attachTableExport(table) {
    attachExportButton(table, options => extractTableData(table, options));
  }

  function attachGridExport(grid) {
    attachExportButton(grid, options => extractGridData(grid, options));
  }

  function getExportButtonClass() {
    return 'solidbutton hu-tbl-export-btn fabtn nhd-button curve glow-btn oneline headerGlowBtn';
  }

  function closeExportMenus() {
    document.querySelectorAll('.hu-tbl-export-dropdown').forEach(dropdown => {
      dropdown.classList.remove('active', 'visible');
      dropdown.setAttribute('aria-expanded', 'false');
      const menu = dropdown.querySelector('.hu-tbl-export-menu');
      if (menu) {
        menu.classList.add('hu-hidden');
        menu.classList.remove('visible');
      }
    });
  }

  function alignExportMenu(menu) {
    menu.classList.remove('hu-align-left', 'hu-align-right');
    menu.style.maxWidth = `${Math.max(160, window.innerWidth - 24)}px`;

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        menu.classList.add('hu-align-right');
      } else if (rect.left < 8) {
        menu.classList.add('hu-align-left');
      }
    });
  }

  function cleanCellText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function visibleNodes(nodes, options = {}) {
    if (options.displayedOnly === false) return [...nodes];
    return [...nodes].filter(node => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  }

  function findExportButtonAnchor(target) {
    const candidates = [];
    let scope = target.parentElement;
    for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
      const buttons = visibleNodes(scope.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'))
        .filter(isLikelyNewButton)
        .filter(button => !button.closest('.hu-tbl-export-bar, .hu-drawer, .hu-palette'));
      buttons.forEach(button => {
        const container = button.closest('.ui.button.dropdown, .buttons-container, .button-container') || button;
        candidates.push({ button: container, depth });
      });
      if (buttons.length) break;
    }

    return candidates.sort((a, b) => a.depth - b.depth)[0]?.button || null;
  }

  function isLikelyNewButton(button) {
    const label = [
      cleanCellText(button),
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.value
    ].filter(Boolean).join(' ').toLowerCase();

    return /(^|\s|\+)(new|add|create)(\s|$)/i.test(label) ||
      /\bnieuw\b/i.test(label) ||
      /\btoevoegen\b/i.test(label);
  }

  function extractTableData(table, options = {}) {
    let headers = visibleNodes(table.querySelectorAll('thead th, thead td'), options).map(cleanCellText).filter(Boolean);
    let bodyRows = visibleNodes(table.querySelectorAll('tbody tr'), options);

    if (!headers.length) {
      const firstHeaderRow = table.querySelector('tr:has(th), tr');
      const headerCells = firstHeaderRow ? visibleNodes(firstHeaderRow.querySelectorAll('th, td'), options) : [];
      headers = headerCells.map(cleanCellText).filter(Boolean);
      bodyRows = visibleNodes(table.querySelectorAll('tr'), options).filter(row => row !== firstHeaderRow);
    }

    const rows = bodyRows
      .map(row => visibleNodes(row.querySelectorAll('td, th'), options).map(cleanCellText))
      .filter(row => row.length >= 2 && row.some(Boolean));
    return normalizeExportData(headers, rows);
  }

  function extractGridData(grid, options = {}) {
    const headerSelectors = [
      '[role="columnheader"]',
      '.ag-header-cell-text',
      '.ReactVirtualized__Table__headerColumn',
      '.rt-th',
      '[class*="headercell" i]',
      '[class*="columnheader" i]'
    ].join(',');
    const cellSelectors = [
      '[role="gridcell"]',
      '[role="cell"]',
      '.ag-cell',
      '.ReactVirtualized__Table__rowColumn',
      '.rt-td',
      '[class*="gridcell" i]',
      '[class*="cell" i]'
    ].join(',');

    const headerNodes = visibleNodes(grid.querySelectorAll(headerSelectors), options);
    let headers = headerNodes.map(cleanCellText);
    const rows = visibleNodes(grid.querySelectorAll('[role="row"], .ag-row, .ReactVirtualized__Table__row, .rt-tr-group'), options)
      .filter(row => !row.querySelector('[role="columnheader"]'))
      .map(row => {
        const cells = visibleNodes(row.querySelectorAll(cellSelectors), options).map(cleanCellText);
        const rowId = getGridRowId(row);
        if (shouldInjectGridRowId(headers, cells, rowId)) {
          cells[0] = rowId;
          if (!headers[0]) headers[0] = 'ID';
        }
        return cells;
      })
      .filter(row => row.length >= 2 && row.some(Boolean));

    headers = headers.filter((header, index) => header || rows.some(row => row[index]));
    return normalizeExportData(headers, rows);
  }

  function getGridRowId(row) {
    const raw = row.getAttribute('data-id') ||
      row.getAttribute('data-row-id') ||
      row.getAttribute('row-id') ||
      row.id ||
      '';
    return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : '';
  }

  function shouldInjectGridRowId(headers, cells, rowId) {
    if (!rowId || !cells.length || cells[0]) return false;
    const cleanHeaders = headers.map(header => String(header || '').trim());
    const hasLeadingUtilityColumn = !cleanHeaders[0];
    const hasIdHeader = cleanHeaders.some(header => /\bid\b/i.test(header));
    const rowAlreadyContainsId = cells.some(cell => String(cell || '').trim() === rowId);
    return !hasLeadingUtilityColumn && !hasIdHeader && !rowAlreadyContainsId;
  }

  function normalizeExportData(headers, rows) {
    let cleanHeaders = headers.map(header => String(header || '').trim());
    let cleanRows = rows.map(row => row.map(value => String(value || '').trim()));

    while (
      cleanHeaders.length > 0 &&
      cleanRows.length > 0 &&
      cleanRows.some(row => row.length > cleanHeaders.length) &&
      cleanRows.every(row => !row[0])
    ) {
      cleanRows = cleanRows.map(row => row.slice(1));
    }

    let width = Math.max(cleanHeaders.length, ...cleanRows.map(row => row.length), 0);
    for (let index = width - 1; index >= 0; index -= 1) {
      const headerBlank = !cleanHeaders[index];
      const rowsBlank = cleanRows.every(row => !row[index]);
      if (headerBlank && rowsBlank) {
        cleanHeaders.splice(index, 1);
        cleanRows = cleanRows.map(row => {
          const next = row.slice();
          next.splice(index, 1);
          return next;
        });
      }
    }

    width = Math.max(cleanHeaders.length, ...cleanRows.map(row => row.length), 0);
    if (width < 2) return { headers: [], rows: [] };
    const normalizedHeaders = Array.from({ length: width }, (_, index) => cleanHeaders[index] || `Column ${index + 1}`);
    const normalizedRows = cleanRows.map(row => Array.from({ length: width }, (_, index) => row[index] || ''));
    return { headers: normalizedHeaders, rows: normalizedRows };
  }

  function scanForTables() {
    // Halo has its own built-in export, so HaloPlus no longer injects table export UI.
  }

  function injectTicket360Button() {
    if (HU.settings.ticket360Enabled === false) return;
    if (!getCurrentTicketId()) return;
    // Multi-Tab mode keeps every open ticket pane mounted in the DOM at the
    // same time, so we need to inject into every matching toolbar — not just
    // the first one. Only the visible (active) tab's button is reachable,
    // and clicks always target the URL-bar ticket id which already tracks
    // the visible tab.
    const containers = document.querySelectorAll('.buttons-container:has(button[title="Share"])');
    if (!containers.length) return;
    const drawerOpen = !!document.getElementById('hu-ticket360-drawer');
    containers.forEach(container => {
      if (container.querySelector('.hu-360-inject-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'solidbutton fabtn notext hu-360-inject-btn';
      btn.type = 'button';
      btn.title = 'Toggle Ticket 360 dashboard';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="1.5"/><line x1="10" y1="2" x2="10" y2="14"/><line x1="1" y1="6.5" x2="10" y2="6.5"/><line x1="1" y1="10.5" x2="10" y2="10.5"/></svg>`;
      if (drawerOpen) btn.classList.add('is-active');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (document.getElementById('hu-ticket360-drawer')) {
          closeDrawer('hu-ticket360-drawer');
        } else {
          openTicket360Panel();
        }
      });
      container.insertBefore(btn, container.firstChild);
    });
  }

  function scheduleAutoTicket360(attempt = 0) {
    if (HU.settings.ticket360Enabled === false) return;
    if (!HU.settings.auto360) return;
    const ticketId = getCurrentTicketId();
    if (ticketId) {
      if (HU.ticket360TicketId === ticketId && document.getElementById('hu-ticket360-drawer')) return;
      openTicket360Panel();
      return;
    }
    if (attempt < 10) {
      setTimeout(() => scheduleAutoTicket360(attempt + 1), 500);
    }
  }

  // Returns true if the mutation reflects a real DOM change Halo made, not
  // our own tag insertion/removal or click-to-copy text swap. Without this,
  // revealFieldNames (which adds/removes .hu-field-tag spans) would trigger
  // the MutationObserver in initNavigationTracking, which would re-run
  // revealFieldNames, which would trigger another mutation, forever.
  function mutationIsRelevant(m) {
    // If the mutation happened inside one of our tags (text swap, class
    // toggle), ignore it.
    let n = m.target;
    while (n && n.nodeType === 1) {
      if (n.classList && n.classList.contains('hu-field-tag')) return false;
      n = n.parentNode;
    }
    if (m.type !== 'childList') return true;
    // childList mutation — relevant only if at least one added or removed
    // node ISN'T one of our tags.
    const isTagEl = (node) => node.nodeType === 1 && node.classList && node.classList.contains('hu-field-tag');
    for (const node of m.addedNodes)   if (!isTagEl(node)) return true;
    for (const node of m.removedNodes) if (!isTagEl(node)) return true;
    return false;
  }

  function initNavigationTracking() {
    setTimeout(() => {
      sendContext();
      trackRecentRecord();
      maybeScrapeConfigPage();
      // Warm the slot-label cache (chrome.storage hit ~ms, first-ever fetch
      // 8 MB) so by the time the user activates the field overlay the map
      // is in HU.slotLabelMap. No await — revealFieldNames falls back to
      // value-matching if the map isn't ready yet.
      loadSlotLabelMap();
      // Warm the ticket value-map too if we're on a ticket page — same
      // motivation: by the time `/f` runs, the fetch is already cached.
      const ctxAtBoot = detectCustomFieldContext();
      if (ctxAtBoot && ctxAtBoot.type === 'Ticket') loadTicketRecord(ctxAtBoot.id);
      // Fire-and-forget probe of /api/Report so Data Viewer + Schema gating
      // has a definitive answer. Resend context once the probe resolves.
      probeReportApi().then(() => sendContext()).catch(() => {});
    }, 1200);

    let lastUrl = location.href;
    const observer = new MutationObserver((mutations) => {
      // Filter out mutations caused by our own tag insertion/removal AND by
      // the click-to-copy "Copied" text swap. Without this, revealFieldNames
      // re-renders every 400ms forever (each render is itself a mutation).
      const meaningful = mutations.some(mutationIsRelevant);
      if (!meaningful) return;

      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          sendContext();
          trackRecentRecord();
          maybeScrapeConfigPage();
          const ctxOnNav = detectCustomFieldContext();
          if (ctxOnNav && ctxOnNav.type === 'Ticket') loadTicketRecord(ctxOnNav.id);
          if (HU.fieldOverlayOn) revealFieldNames();
          injectTicket360Button();
          const newId = getCurrentTicketId();
          // Audit log is always tied to one ticket; close it on any ticket
          // navigation so the user doesn't see stale data for a different
          // record.
          closeDrawer('hu-audit-drawer');
          if (!newId) {
            closeDrawer('hu-ticket360-drawer');
            closeDrawer('hu-timeline-drawer');
          } else if (HU.settings.auto360) {
            scheduleAutoTicket360();
          } else {
            if (document.getElementById('hu-ticket360-drawer') && newId !== HU.ticket360TicketId) openTicket360Panel();
            if (document.getElementById('hu-timeline-drawer') && newId !== HU.timelineTicketId) openActionTimelinePanel();
          }
        }, 900);
      } else {
        if (HU.fieldOverlayOn) {
          clearTimeout(HU.overlayTimer);
          HU.overlayTimer = setTimeout(revealFieldNames, 400);
        }
        clearTimeout(HU.inject360Timer);
        HU.inject360Timer = setTimeout(injectTicket360Button, 600);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'HU_PING') {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    if (message.type === 'RUN_HALO_REPORT') {
      runHaloReport(message.data?.sql, message.data?.name)
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_OPEN_PALETTE') {
      openPalette(message.data?.seed || '');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HU_SHOW_RECENT') {
      showRecentPanel();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HU_OPEN_TICKET360') {
      openTicket360Panel()
        .then(ok => sendResponse(ok ? { ok: true } : { ok: false, error: 'Open a ticket first.' }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_OPEN_AUDIT') {
      const ticketId = getCurrentTicketId();
      if (!ticketId) {
        sendResponse({ ok: false, error: 'Open a ticket first.' });
        return false;
      }
      openAuditLogDrawer(ticketId);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HU_OPEN_TIMELINE') {
      openActionTimelinePanel()
        .then(ok => sendResponse(ok ? { ok: true } : { ok: false, error: 'Open a ticket first.' }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_TOGGLE_FIELDS') {
      toggleFieldOverlay();
      sendResponse({ ok: true, on: HU.fieldOverlayOn });
      return false;
    }

    if (message.type === 'HU_OPEN_JSON') {
      openJsonInspector();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HU_GET_CONTEXT') {
      sendResponse({ ok: true, data: detectContext() });
      return false;
    }

    if (message.type === 'HU_GET_PAGE_DIAGNOSTICS') {
      // Page-side state for the side panel's Diagnostics card. Bundles the
      // permission/claim summary, impersonation flag, entity-API access map,
      // and report API status so the panel can render a clear "who am I and
      // what works for me" view without re-probing.
      const permissions = readHaloPermissions();
      probeReportApi().then(reportOk => {
        sendResponse({
          ok: true,
          data: {
            permissions: {
              isAdmin: !!permissions.isAdmin,
              canImpersonate: !!permissions.canImpersonate,
              canLogTickets: !!permissions.canLogTickets,
              canEditClosedTickets: !!permissions.canEditClosedTickets,
              canRunPowerShell: !!permissions.canRunPowerShell,
              totalClaims: permissions.totalClaims || 0,
              currentAgentId: permissions.currentAgentId || '',
              parentAgentId: permissions.parentAgentId || '',
              isImpersonating: !!permissions.isImpersonating,
              staleImpersonationMarker: !!permissions.staleImpersonationMarker
            },
            reportApiOk: reportOk,
            reportApiError: HU.reportApiError || '',
            entityAccess: HU.entityAccess || null,
            ticketTypeCount: HU.ticketTypeCommands.length,
            ticketTypeTagsLoaded: !!HU.ticketTypeTagsLoaded
          }
        });
      }).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_GET_ENTITY_SAMPLES') {
      // Side-panel schema explorer asks for one sample record per entity so
      // it can harvest the API field names (canonical lowercase form) and
      // surface them alongside the SQL column names from tables.json.
      loadEntitySamples()
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_GET_FIELDINFO') {
      // Side-panel schema explorer asks for all custom fields per entity.
      // Returns { ticket: [...], user: [...], ... } — typically ~50-500 CFs
      // total, depending on tenant. Admin-gated by Halo; non-admins may
      // get empty arrays. The panel renders whatever comes back.
      loadAllCustomFields()
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_GET_VIEW_COLUMNS') {
      // Side-panel schema explorer asks for saved-view column metadata so
      // it can label otherwise-cryptic API field names with their list-
      // grid titles (e.g. `last_update_text` → "Last Updated").
      loadViewColumnLabels()
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_PANEL_LOG') {
      // Side panel has its own console nobody can open — surface logs in the Halo page DevTools.
      try { console.log(message.data?.text || ''); } catch (_) {}
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'HU_GET_COLUMN_PROFILES') {
      const entity = message.data?.entity;
      loadColumnProfilesForEntity(entity)
        .then(profiles => sendResponse({ ok: true, profiles }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_GET_REPORT_STATUS') {
      // Force a fresh probe if we've never run one (e.g. side panel opens
      // before the init delay fires). Otherwise return the cached tri-state.
      probeReportApi().then(ok => {
        sendResponse({
          ok: true,
          reportApiOk: ok,
          reportApiError: HU.reportApiError || ''
        });
      }).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_RUN_EXTENDED_PROBES') {
      runExtendedProbes()
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'HU_NAVIGATE') {
      const path = message.data?.path;
      if (path) navigateTo(path);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  document.addEventListener('dblclick', e => {
    if (HU.settings.doubleClickTechFields === false) return;
    const target = e.target;
    if (target.closest('#haloutils-palette-backdrop, .hu-drawer, .hu-toast')) return;
    // Skip anything inside or attached to a form — agents often double-click
    // labels, buttons, or option rows while editing and the overlay would
    // hijack that interaction. Also skip native form widgets even when
    // they're not wrapped in <form> (Halo's React app often omits it).
    if (target.closest('form')) return;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (target.closest('button, label, [role="button"], [role="combobox"], [role="listbox"], [role="textbox"], [role="searchbox"], [role="checkbox"], [role="radio"], [role="option"]')) return;
    toggleFieldOverlay();
  });

  const HU_EMAIL_VARS = {
    catalog: new Map(),
    state: { active: false, target: null, triggerStart: 0, query: '', selectedIndex: 0, popup: null, candidates: [], category: 'All' },
    harvested: false,
    pollTimer: null
  };

  function isEmailTemplatePage() {
    return /\/config\/email\//i.test(location.pathname);
  }

  async function loadEmailVarCatalog() {
    try {
      const resp = await fetch(chrome.runtime.getURL('schema/email-variables.json'));
      const json = await resp.json();
      (json.variables || []).forEach(v => {
        HU_EMAIL_VARS.catalog.set(v.name.toLowerCase(), {
          name: v.name,
          description: v.description || '',
          category: v.category || 'Other',
          isButton: !!v.isButton,
          source: 'seed'
        });
      });
    } catch (_) {}
    const data = await storageGet(['huEmailVarCatalog', 'huEmailVarCategory', 'huEmailVarCustomFields']);
    (data.huEmailVarCatalog || []).forEach(v => {
      if (!HU_EMAIL_VARS.catalog.has(v.name.toLowerCase())) {
        HU_EMAIL_VARS.catalog.set(v.name.toLowerCase(), { ...v, category: v.category || 'Other', isButton: !!v.isButton, source: v.source || 'learned' });
      }
    });
    if (data.huEmailVarCustomFields?.fields?.length) {
      mergeCustomFieldsIntoCatalog(data.huEmailVarCustomFields.fields);
    }
    if (data.huEmailVarCategory) HU_EMAIL_VARS.state.category = data.huEmailVarCategory;
  }

  function persistLearnedVars() {
    const learned = [...HU_EMAIL_VARS.catalog.values()].filter(v => v.source !== 'seed');
    chrome.storage.local.set({ huEmailVarCatalog: learned });
  }

  function harvestVariablesFromPage() {
    if (HU_EMAIL_VARS.harvested) return;
    HU_EMAIL_VARS.harvested = true;
    const text = document.body?.innerText || '';
    const matches = text.match(/\$[A-Za-z][A-Za-z0-9_]{1,40}/g) || [];
    let added = 0;
    matches.forEach(token => {
      const name = token.slice(1);
      const key = name.toLowerCase();
      if (HU_EMAIL_VARS.catalog.has(key)) return;
      HU_EMAIL_VARS.catalog.set(key, { name, label: name, description: 'Found in this template.', category: 'Other', source: 'learned' });
      added++;
    });
    if (added) persistLearnedVars();
  }

  function isTemplateField(el) {
    if (!el) return false;
    if (!el.matches) return false;
    if (el.matches('input[name="header_text"], input[name="subject"]')) return true;
    if (el.closest('.fr-element[contenteditable="true"]')) return true;
    if (el.matches('input[type="text"], input:not([type])') && el.closest('.fr-popup')) return true;
    return false;
  }

  const CF_TABLE_CATEGORY = {
    faults: 'Ticket custom fields',
    area: 'Organisation custom fields',
    users: 'End user custom fields',
    device: 'Asset custom fields',
    site: 'Site custom fields',
    uname: 'Agent custom fields'
  };
  const CF_DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function mergeCustomFieldsIntoCatalog(fields) {
    (fields || []).forEach(f => {
      const key = String(f.name || '').toLowerCase();
      if (!key) return;
      if (HU_EMAIL_VARS.catalog.has(key) && HU_EMAIL_VARS.catalog.get(key).source === 'seed') return;
      HU_EMAIL_VARS.catalog.set(key, {
        name: f.name,
        description: f.description || '',
        category: f.category || 'Custom fields',
        isButton: false,
        source: 'cf-discovery'
      });
    });
  }

  async function discoverEmailVarCustomFields() {
    if (HU_EMAIL_VARS.cfDiscoveryStarted) return;
    HU_EMAIL_VARS.cfDiscoveryStarted = true;
    try {
      const cached = await storageGet(['huEmailVarCustomFields']);
      const c = cached.huEmailVarCustomFields;
      if (c?.fields?.length && c.fetchedAt && (Date.now() - c.fetchedAt < CF_DISCOVERY_TTL_MS)) {
        mergeCustomFieldsIntoCatalog(c.fields);
        return;
      }

      const tables = Object.keys(CF_TABLE_CATEGORY).map(t => `'${t}'`).join(', ');
      const sql = `
SELECT TABLE_NAME, COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE COLUMN_NAME LIKE 'CF%'
  AND TABLE_NAME IN (${tables})
`.trim();

      const payload = await runHaloReport(sql, 'HaloPlus Email CF Discovery');
      const rows = extractRows(payload);
      const fields = rows
        .map(r => ({
          table: String(r.TABLE_NAME || r.table || '').toLowerCase(),
          column: String(r.COLUMN_NAME || r.column || '')
        }))
        .filter(r => r.table && r.column && /^CF[A-Za-z0-9_]+$/.test(r.column))
        .map(r => ({
          name: r.column,
          category: CF_TABLE_CATEGORY[r.table] || 'Custom fields',
          description: `Custom field on ${r.table}.`
        }));
      if (!fields.length) return;
      await new Promise(resolve => chrome.storage.local.set({ huEmailVarCustomFields: { fields, fetchedAt: Date.now() } }, resolve));
      mergeCustomFieldsIntoCatalog(fields);
    } catch (_) {
      // leave cfDiscoveryStarted set: next page load can retry
    }
  }

  function getTriggerInfo(target) {
    if (!target) return null;
    if (target.tagName === 'INPUT') {
      const caret = target.selectionStart;
      const before = target.value.slice(0, caret);
      const m = before.match(/\$([A-Za-z0-9_]*)$/);
      if (!m) return null;
      return { kind: 'input', node: target, triggerStart: caret - m[0].length, caret, query: m[1] };
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const editable = node.parentElement && node.parentElement.closest('.fr-element[contenteditable="true"]');
    if (!editable) return null;
    const before = node.textContent.slice(0, range.startOffset);
    const m = before.match(/\$([A-Za-z0-9_]*)$/);
    if (!m) return null;
    return { kind: 'ce', node, range, editable, triggerStart: range.startOffset - m[0].length, caret: range.startOffset, query: m[1] };
  }

  function getCaretRect(info) {
    if (info.kind === 'input') {
      const frPopup = info.node.closest && info.node.closest('.fr-popup');
      if (frPopup) {
        const fp = frPopup.getBoundingClientRect();
        const spaceRight = window.innerWidth - fp.right;
        if (spaceRight >= 340) {
          return { left: fp.right + 8, top: fp.top, height: 0 };
        }
        const spaceLeft = fp.left;
        if (spaceLeft >= 340) {
          return { left: fp.left - 328, top: fp.top, height: 0 };
        }
        return { left: Math.max(8, fp.left), top: fp.bottom + 6, height: 0 };
      }
      const r = info.node.getBoundingClientRect();
      return { left: r.left + 12, top: r.bottom, height: 0 };
    }
    const probe = document.createRange();
    probe.setStart(info.node, Math.max(0, info.caret - 1));
    probe.setEnd(info.node, info.caret);
    const rects = probe.getClientRects();
    if (rects.length) return { left: rects[0].right, top: rects[0].bottom, height: rects[0].height };
    const editableRect = info.editable.getBoundingClientRect();
    return { left: editableRect.left + 12, top: editableRect.top + 24, height: 0 };
  }

  function getCandidates(query, category) {
    const q = String(query || '').toLowerCase();
    const cat = category || 'All';
    let pool = [...HU_EMAIL_VARS.catalog.values()];
    if (cat !== 'All') pool = pool.filter(v => (v.category || 'Other') === cat);
    if (!q) return pool.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
    return pool
      .filter(v => v.name.toLowerCase().includes(q) || String(v.description || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 60);
  }

  function getAvailableCategories() {
    const present = new Set();
    HU_EMAIL_VARS.catalog.forEach(v => present.add(v.category || 'Other'));
    const regular = [...present].filter(c => !/Buttons?$/i.test(c)).sort();
    const buttonCats = [...present].filter(c => /Buttons?$/i.test(c)).sort();
    const ordered = ['All', ...regular, ...buttonCats];
    if (present.has('Other')) {
      const idx = ordered.indexOf('Other');
      if (idx > -1) ordered.splice(idx, 1);
      ordered.push('Other');
    }
    return ordered;
  }

  function ensureVarPopupStyles() {
    if (document.getElementById('hu-evp-styles')) return;
    const style = document.createElement('style');
    style.id = 'hu-evp-styles';
    style.textContent = `
      .hu-evp { position: fixed; z-index: 2147483647; isolation: isolate; width: 320px; max-height: 280px;
        background: #fff; border: 1px solid #d8dde8; border-radius: 8px;
        box-shadow: 0 16px 40px rgba(8,16,30,0.22); overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        font-size: 12.5px; color: #172033; display: flex; flex-direction: column; }
      .hu-evp-header { padding: 8px 10px; border-bottom: 1px solid #eef0f5; background: #fbfcff;
        font-size: 11px; color: #667085; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .hu-evp-header-left { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
      .hu-evp-category { font-size: 11px; padding: 2px 6px; border-radius: 4px; border: 1px solid #d8dde8; background: #fff; color: #172033; max-width: 150px; }
      html.hu-theme-dark .hu-evp-category { background: #171b22; border-color: #303744; color: #edf1f7; }
      .hu-evp-list { flex: 1; overflow-y: auto; padding: 4px; }
      .hu-evp-row { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px;
        border-radius: 5px; cursor: pointer; }
      .hu-evp-row:hover, .hu-evp-row.hu-evp-active { background: #eef4ff; }
      .hu-evp-row-top { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
      .hu-evp-name { font-family: "SF Mono", Consolas, monospace; font-size: 12px; font-weight: 700; color: #b85a18; white-space: nowrap; }
      .hu-evp-label { font-size: 11px; color: #475066; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; text-align: right; }
      .hu-evp-desc { font-size: 10.5px; color: #6a7280; line-height: 1.35; overflow: hidden;
        text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .hu-evp-empty { padding: 12px; color: #6a7280; font-size: 12px; text-align: center; }
      html.hu-theme-dark .hu-evp { background: #1a2236; color: #edf1f7; border-color: #303744; box-shadow: 0 16px 40px rgba(0,0,0,0.45); }
      html.hu-theme-dark .hu-evp-header { background: #161e2d; border-color: #2b3548; color: #a7afbd; }
      html.hu-theme-dark .hu-evp-row:hover, html.hu-theme-dark .hu-evp-row.hu-evp-active { background: #1d2a42; }
      html.hu-theme-dark .hu-evp-name { color: #ff9b51; }
      html.hu-theme-dark .hu-evp-label { color: #c7cedb; }
      html.hu-theme-dark .hu-evp-desc { color: #a7afbd; }
    `;
    document.documentElement.appendChild(style);
  }

  function renderVarPopup(info) {
    ensureVarPopupStyles();
    let popup = HU_EMAIL_VARS.state.popup;
    if (!popup) {
      popup = document.createElement('div');
      popup.className = 'hu-evp';
      const options = getAvailableCategories()
        .map(c => `<option value="${escapeHtml(c)}"${c === HU_EMAIL_VARS.state.category ? ' selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');
      popup.innerHTML = `
        <div class="hu-evp-header">
          <span class="hu-evp-header-left">
            <span>Variables</span>
            <select class="hu-evp-category" aria-label="Filter by category">${options}</select>
          </span>
          <span class="hu-evp-hint">Enter to insert</span>
        </div>
        <div class="hu-evp-list"></div>
      `;
      document.documentElement.appendChild(popup);
      HU_EMAIL_VARS.state.popup = popup;
      const select = popup.querySelector('.hu-evp-category');
      select.addEventListener('change', () => {
        HU_EMAIL_VARS.state.category = select.value;
        chrome.storage.local.set({ huEmailVarCategory: select.value });
        HU_EMAIL_VARS.state.candidates = getCandidates(HU_EMAIL_VARS.state.query, HU_EMAIL_VARS.state.category);
        HU_EMAIL_VARS.state.selectedIndex = 0;
        renderVarPopup(HU_EMAIL_VARS.state.triggerInfo);
        if (HU_EMAIL_VARS.state.target) HU_EMAIL_VARS.state.target.focus();
      });
      select.addEventListener('mousedown', e => e.stopPropagation());
    }
    if (popup.parentElement !== document.documentElement) {
      document.documentElement.appendChild(popup);
    }
    const rect = getCaretRect(info);
    const popupHeight = 280;
    const wantTop = rect.top + 4;
    const fitsBelow = wantTop + popupHeight < window.innerHeight - 8;
    popup.style.left = `${Math.min(Math.max(rect.left - 4, 8), window.innerWidth - 330)}px`;
    popup.style.top = `${fitsBelow ? wantTop : Math.max(rect.top - rect.height - popupHeight - 8, 8)}px`;

    const list = popup.querySelector('.hu-evp-list');
    const cands = HU_EMAIL_VARS.state.candidates;
    list.innerHTML = '';
    if (!cands.length) {
      list.innerHTML = `<div class="hu-evp-empty">No variables match "${escapeHtml(HU_EMAIL_VARS.state.query)}". Press Esc to dismiss.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    cands.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = `hu-evp-row${idx === HU_EMAIL_VARS.state.selectedIndex ? ' hu-evp-active' : ''}`;
      row.dataset.idx = String(idx);
      const token = v.isButton ? `{$${v.name}}` : `$${v.name}`;
      row.innerHTML = `
        <div class="hu-evp-row-top">
          <span class="hu-evp-name">${escapeHtml(token)}</span>
          <span class="hu-evp-label">${escapeHtml(v.category || '')}</span>
        </div>
        ${v.description ? `<div class="hu-evp-desc">${escapeHtml(v.description)}</div>` : ''}
      `;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); insertVariable(idx); });
      row.addEventListener('mousemove', () => {
        if (HU_EMAIL_VARS.state.selectedIndex !== idx) {
          HU_EMAIL_VARS.state.selectedIndex = idx;
          renderVarPopup(info);
        }
      });
      frag.appendChild(row);
    });
    list.appendChild(frag);
    const active = list.querySelector('.hu-evp-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function closeVarPopup() {
    const popup = HU_EMAIL_VARS.state.popup;
    const keepCategory = HU_EMAIL_VARS.state.category;
    if (popup) popup.remove();
    HU_EMAIL_VARS.state = { active: false, target: null, triggerStart: 0, query: '', selectedIndex: 0, popup: null, candidates: [], category: keepCategory };
    stopVarPoll();
  }

  function startVarPoll() {
    if (HU_EMAIL_VARS.pollTimer) return;
    let lastSig = '';
    HU_EMAIL_VARS.pollTimer = setInterval(() => {
      if (!HU_EMAIL_VARS.state.active) { stopVarPoll(); return; }
      const target = HU_EMAIL_VARS.state.target;
      if (!target || !document.contains(target)) { stopVarPoll(); return; }
      const sig = target.tagName === 'INPUT'
        ? `${target.value}|${target.selectionStart}`
        : (target.textContent || '');
      if (sig === lastSig) return;
      lastSig = sig;
      handleEmailFieldInput({ target });
    }, 80);
  }

  function stopVarPoll() {
    if (HU_EMAIL_VARS.pollTimer) {
      clearInterval(HU_EMAIL_VARS.pollTimer);
      HU_EMAIL_VARS.pollTimer = null;
    }
  }

  function insertVariable(idx) {
    const cands = HU_EMAIL_VARS.state.candidates;
    const chosen = cands[idx];
    if (!chosen) return;
    const target = HU_EMAIL_VARS.state.target;
    const trigger = HU_EMAIL_VARS.state.triggerInfo;
    if (!target || !trigger) { closeVarPopup(); return; }
    const replacement = chosen.isButton ? `{$${chosen.name}} ` : `$${chosen.name} `;

    if (trigger.kind === 'input') {
      const value = target.value;
      const before = value.slice(0, trigger.triggerStart);
      const after = value.slice(trigger.caret);
      target.value = before + replacement + after;
      const newCaret = (before + replacement).length;
      target.setSelectionRange(newCaret, newCaret);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const node = trigger.node;
      const text = node.textContent;
      const before = text.slice(0, trigger.triggerStart);
      const after = text.slice(trigger.caret);
      node.textContent = before + replacement + after;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(node, (before + replacement).length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      trigger.editable.dispatchEvent(new Event('input', { bubbles: true }));
    }
    closeVarPopup();
  }

  function refreshVarPopup() {
    const info = getTriggerInfo(HU_EMAIL_VARS.state.target);
    if (!info) { closeVarPopup(); return; }
    HU_EMAIL_VARS.state.triggerInfo = info;
    HU_EMAIL_VARS.state.triggerStart = info.triggerStart;
    HU_EMAIL_VARS.state.query = info.query;
    HU_EMAIL_VARS.state.candidates = getCandidates(info.query, HU_EMAIL_VARS.state.category);
    HU_EMAIL_VARS.state.selectedIndex = Math.min(HU_EMAIL_VARS.state.selectedIndex, Math.max(0, HU_EMAIL_VARS.state.candidates.length - 1));
    renderVarPopup(info);
  }

  function handleEmailFieldInput(event) {
    const target = event.target;
    if (!isTemplateField(target)) return;
    if (!HU_EMAIL_VARS.harvested) harvestVariablesFromPage();
    if (isEmailTemplatePage() && !HU_EMAIL_VARS.cfDiscoveryStarted) {
      discoverEmailVarCustomFields().catch(() => {});
    }
    const info = getTriggerInfo(target);
    if (!info) {
      if (HU_EMAIL_VARS.state.active) closeVarPopup();
      return;
    }
    const wasActive = HU_EMAIL_VARS.state.active;
    if (!wasActive) HU_EMAIL_VARS.state.category = 'All';
    HU_EMAIL_VARS.state.active = true;
    HU_EMAIL_VARS.state.target = target;
    HU_EMAIL_VARS.state.triggerInfo = info;
    HU_EMAIL_VARS.state.triggerStart = info.triggerStart;
    HU_EMAIL_VARS.state.query = info.query;
    HU_EMAIL_VARS.state.candidates = getCandidates(info.query, HU_EMAIL_VARS.state.category);
    if (HU_EMAIL_VARS.state.selectedIndex >= HU_EMAIL_VARS.state.candidates.length) {
      HU_EMAIL_VARS.state.selectedIndex = 0;
    }
    renderVarPopup(info);
    if (!wasActive) startVarPoll();
  }

  function handleEmailFieldKey(event) {
    if (!HU_EMAIL_VARS.state.active) return;
    if (HU_EMAIL_VARS.state.popup && HU_EMAIL_VARS.state.popup.contains(event.target)) return;
    const cands = HU_EMAIL_VARS.state.candidates;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeVarPopup();
      return;
    }
    if (!cands.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      HU_EMAIL_VARS.state.selectedIndex = Math.min(HU_EMAIL_VARS.state.selectedIndex + 1, cands.length - 1);
      renderVarPopup(HU_EMAIL_VARS.state.triggerInfo);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      HU_EMAIL_VARS.state.selectedIndex = Math.max(HU_EMAIL_VARS.state.selectedIndex - 1, 0);
      renderVarPopup(HU_EMAIL_VARS.state.triggerInfo);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insertVariable(HU_EMAIL_VARS.state.selectedIndex);
      return;
    }
  }

  function initEmailVarAutocomplete() {
    // Document-level listeners installed once at startup and intentionally
    // never removed. Halo's template-editor fields can mount/unmount any time
    // the user navigates between settings panes, so we listen at the document
    // level rather than attaching per-field. All handlers early-return when
    // the target isn't a template field, so the cost when idle is negligible.
    loadEmailVarCatalog();
    document.addEventListener('input', handleEmailFieldInput, true);
    document.addEventListener('keydown', handleEmailFieldKey, true);
    document.addEventListener('keyup', (event) => {
      if (HU_EMAIL_VARS.state.popup && HU_EMAIL_VARS.state.popup.contains(event.target)) return;
      if (!isTemplateField(event.target)) return;
      handleEmailFieldInput({ target: event.target });
    }, true);
    document.addEventListener('mousedown', (event) => {
      if (!HU_EMAIL_VARS.state.popup) return;
      if (HU_EMAIL_VARS.state.popup.contains(event.target)) return;
      if (event.target === HU_EMAIL_VARS.state.target) return;
      closeVarPopup();
    }, true);
    document.addEventListener('scroll', () => {
      if (HU_EMAIL_VARS.state.active) refreshVarPopup();
    }, true);
  }
  initTheme();
  injectStyles();
  loadShortcuts();
  loadCustomCommands();
  loadRecentCommands();
  loadCommandHistory();
  loadTicketTypes();
  loadRecent();
  loadImpersonationState();
  loadSettings();
  loadPaletteSettings();
  loadReviewState();
  loadConfigTree();
  initPalette();
  initNavigationTracking();
  initEmailVarAutocomplete();
  // Background probes:
  // - probeReportApi(): determines whether /api/Report (SQL) is callable.
  //   Result gates SQL fallbacks so non-admin agents don't flood the network
  //   tab with guaranteed 403s on every keystroke.
  // - probeEntityAccess(): per-entity API access for greying-out palette commands.
  setTimeout(() => { probeReportApi().catch(() => {}); }, 500);
  setTimeout(() => { probeEntityAccess().catch(() => {}); }, 2000);
  // Environment banner — read storage for any per-host override and paint
  // a thin coloured strip + chip at the top of the page. Re-paint when the
  // user changes the override in the side panel.
  refreshEnvironmentBanner();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.huCustomDomainsMeta) refreshEnvironmentBanner();
    });
  } catch (_) {}
  setTimeout(() => {
    injectTicket360Button();
    scheduleAutoTicket360();
  }, 1500);
  if (window === window.top) {
    setTimeout(() => { warmupConfigDiscovery().catch(() => {}); }, 8000);
  }
})();




