// subcategories.js
// Sub-categories used to be plain strings (just a label for the dropdown).
// They can now each optionally override their parent template's role
// restriction, voting body (GA/SC/Both), veto eligibility, and field list -
// e.g. a "Foreign Policy" template could be GA-wide by default, but have a
// "Sanctions" sub-category that's SC-only, restricted to a role, and not
// vetoable, all without affecting the template's other sub-categories or
// the template's own default settings.
//
// Anything a sub-category doesn't explicitly set simply inherits the
// template's own setting - so existing templates/sub-categories keep working
// exactly as before unless an admin opts into an override.

// Upgrades an old plain-string sub-category into the same shape a new,
// override-capable one has, so both are handled identically everywhere else.
function normalizeSubcategory(entry) {
  if (typeof entry === 'string') {
    return { name: entry, allowedRole: null, body: null, vetoable: null, fields: null };
  }
  return {
    name: entry.name,
    allowedRole: entry.allowedRole || null,
    body: entry.body || null,
    vetoable: entry.vetoable === undefined || entry.vetoable === null ? null : !!entry.vetoable,
    fields: entry.fields && entry.fields.length ? entry.fields : null,
  };
}

function normalizeSubcategories(list) {
  return (list || []).map(normalizeSubcategory);
}

function findSubcategory(template, name) {
  if (!name) return null;
  const list = normalizeSubcategories(template.subcategories);
  return list.find((s) => s.name.toLowerCase() === name.toLowerCase()) || null;
}

// Resolves the effective rule set for a template, optionally narrowed down
// by a chosen sub-category. A sub-category override always wins; anything
// it leaves unset (null) falls back to the template's own setting - exactly
// like the template's own settings already fall back to sensible defaults.
function effectiveSettings(template, subcategoryName) {
  const sub = findSubcategory(template, subcategoryName);
  return {
    allowedRole: (sub && sub.allowedRole) || template.allowedRole || null,
    body: (sub && sub.body) || template.body || 'GA',
    vetoable: sub && sub.vetoable !== null ? sub.vetoable : template.vetoable !== false,
    fields: (sub && sub.fields) || template.fields || [],
    // Whether this sub-category actually customizes anything, for display purposes.
    isOverridden: !!(sub && (sub.allowedRole || sub.body || sub.vetoable !== null || sub.fields)),
  };
}

module.exports = { normalizeSubcategory, normalizeSubcategories, findSubcategory, effectiveSettings };
