// HTML escape helper — prevents XSS when inserting user data into innerHTML
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Phase 2.1: the Phase 1 schema migration renamed the legacy 'superadmin'
// role to 'platform_admin'. Existing frontend checks still match the old
// string; this helper accepts both so we don't have to splatter the array
// at every call site. Use everywhere the UI gates on platform-level access.
export function isPlatformAdmin(user) {
  return !!(user && (user.role === 'superadmin' || user.role === 'platform_admin'));
}
