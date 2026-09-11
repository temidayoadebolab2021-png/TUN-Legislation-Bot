// resolutions.js
// Helper functions to read/write resolutions (data/resolutions.json)
// and templates (data/templates.json).

const { readJSON, writeJSON } = require('./storage');
const { normalizeSubcategories } = require('./subcategories');

// A resolution counts as "active" (still in progress, not yet finished)
// if its status is one of these. Used to enforce "max active resolutions
// per member" and for autocomplete filtering.
const ACTIVE_STATUSES = [
  'Draft',
  'Awaiting Sponsors',
  'Under Administrative Review',
  'Returned for Revision',
  'Debate',
  'Voting',
  'Veto Override Vote',
];

// A resolution can only be self-edited, or self-deleted, before it's been
// approved into Debate - once debate/voting has started, the record
// should stay intact for the sake of transparency.
const EDITABLE_STATUSES = ['Draft', 'Awaiting Sponsors', 'Returned for Revision'];
const SELF_DELETABLE_STATUSES = ['Draft', 'Awaiting Sponsors', 'Under Administrative Review', 'Returned for Revision'];

function findActiveResolutionByMember(userId) {
  return getAllResolutions().find((r) => r.submittedBy === userId && ACTIVE_STATUSES.includes(r.status)) || null;
}

function getActiveResolutionsByMember(userId) {
  return getAllResolutions().filter((r) => r.submittedBy === userId && ACTIVE_STATUSES.includes(r.status));
}

function getAllResolutions() {
  return readJSON('resolutions.json', []) || [];
}

function saveAllResolutions(list) {
  writeJSON('resolutions.json', list);
}

function findResolution(number) {
  return getAllResolutions().find((r) => r.number === number) || null;
}

function upsertResolution(resolution) {
  const list = getAllResolutions();
  const idx = list.findIndex((r) => r.number === resolution.number);
  if (idx === -1) list.push(resolution);
  else list[idx] = resolution;
  saveAllResolutions(list);
  return resolution;
}

// Deletes one resolution entirely. Returns true if something was actually
// removed, false if no resolution with that number existed.
function deleteResolution(number) {
  const list = getAllResolutions();
  const filtered = list.filter((r) => r.number !== number);
  if (filtered.length === list.length) return false;
  saveAllResolutions(filtered);
  return true;
}

// Wipes every resolution and resets the numbering counter for the given
// prefix back to 0 (so the next one created starts again from 001). Does
// NOT touch elections or their own numbering counter, since they share
// counters.json but are keyed under a different prefix.
function clearAllResolutions(resolutionPrefix) {
  saveAllResolutions([]);
  const counters = readJSON('counters.json', {}) || {};
  for (const key of Object.keys(counters)) {
    if (key === resolutionPrefix || key.startsWith(`${resolutionPrefix}-`)) {
      delete counters[key];
    }
  }
  writeJSON('counters.json', counters);
}

// Normalizes every template's sub-categories on the way out (upgrading any
// old plain-string entries) so every consumer of this function always gets
// the same shape, regardless of what's actually on disk. See subcategories.js.
function getAllTemplates() {
  const templates = readJSON('templates.json', []) || [];
  for (const t of templates) {
    if (t.subcategories) t.subcategories = normalizeSubcategories(t.subcategories);
  }
  return templates;
}

function saveAllTemplates(list) {
  writeJSON('templates.json', list);
}

function findTemplate(name) {
  return getAllTemplates().find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
}

module.exports = {
  getAllResolutions,
  saveAllResolutions,
  findResolution,
  upsertResolution,
  deleteResolution,
  clearAllResolutions,
  getAllTemplates,
  saveAllTemplates,
  findTemplate,
  ACTIVE_STATUSES,
  EDITABLE_STATUSES,
  SELF_DELETABLE_STATUSES,
  findActiveResolutionByMember,
  getActiveResolutionsByMember,
};
