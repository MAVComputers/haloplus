// Constants shared between the service worker and the side panel. Content
// script doesn't currently need these, so it inlines its own values.
//
// Requires at least one subdomain segment. The bare apex (haloitsm.com, etc.)
// is Halo's public docs / marketing site — not a real tenant instance.
var HALO_HOST_PATTERN = /\.(halopsa\.com|haloitsm\.com|haloservicedesk\.com)$/i;

// Environment detection. Looks at the subdomain for hints — `sandbox`,
// `dev`, `staging` etc. — and falls back to "prod" for plain tenant names
// on the standard Halo apex domains. Custom domains with no obvious marker
// return "unknown"; the user can override per-host in Settings.
//
// Used everywhere we surface the "you are working in PROD" affordance:
// side panel header, palette footer, and a thin coloured bar at the top
// of the Halo page itself.
var HU_ENVIRONMENT_SPECS = {
  prod:    { label: 'PROD',    color: '#dc2626', bg: '#fee2e2', text: '#7f1d1d' },
  staging: { label: 'STAGING', color: '#f59e0b', bg: '#fef3c7', text: '#78350f' },
  uat:     { label: 'UAT',     color: '#8b5cf6', bg: '#ede9fe', text: '#4c1d95' },
  test:    { label: 'TEST',    color: '#3b82f6', bg: '#dbeafe', text: '#1e3a8a' },
  sandbox: { label: 'SANDBOX', color: '#10b981', bg: '#d1fae5', text: '#064e3b' },
  dev:     { label: 'DEV',     color: '#10b981', bg: '#d1fae5', text: '#064e3b' },
  unknown: { label: 'CUSTOM',  color: '#64748b', bg: '#e2e8f0', text: '#334155' }
};

function huDetectEnvironment(hostname) {
  if (!hostname) return 'unknown';
  const h = String(hostname).toLowerCase();
  // Hostnames concatenate words without separators (`pinkacademysandbox`),
  // so we deliberately don't use word boundaries here. Any false positive
  // can be fixed per-tenant via the env override dropdown.
  if (/(sandbox|sbx)/.test(h)) return 'sandbox';
  if (/(staging|stage|stg)/.test(h)) return 'staging';
  if (/(uat)/.test(h)) return 'uat';
  if (/(test|tst)/.test(h)) return 'test';
  if (/(devel|dev)/.test(h)) return 'dev';
  // Standard Halo apex with a plain tenant subdomain → assume production.
  if (HALO_HOST_PATTERN.test(h)) return 'prod';
  return 'unknown';
}
