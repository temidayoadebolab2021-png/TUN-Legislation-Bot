// /template command
// Admins define the "forms" members fill out to propose resolutions.
// Example: a "Military Intervention" template with fields Target, Purpose, Duration...
// NOTE: Discord popup forms (modals) support a maximum of 5 fields, so each
// template can have up to 5 fields for now.
//
// Templates can optionally have SUBCATEGORIES - e.g. an "Economic Policy"
// template with subcategories "Tax Changes", "Grant Policy", "Bank Policy".
// If a template has subcategories, members pick one from a dropdown right
// after choosing the template in /propose, and it's recorded on the
// resolution and shown wherever the resolution is displayed.

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getConfig } = require('../lib/config');
const { isAdmin } = require('../lib/permissions');
const { getAllTemplates, saveAllTemplates, findTemplate, getAllResolutions, saveAllResolutions, ACTIVE_STATUSES } = require('../lib/resolutions');
const { logAudit } = require('../lib/audit');
const { findSubcategory, effectiveSettings } = require('../lib/subcategories');

const SUBCATEGORY_BODY_CHOICES = [
  { name: 'General Assembly only', value: 'GA' },
  { name: 'Security Council only', value: 'SC' },
  { name: 'Both (GA and SC must both approve)', value: 'Both' },
];

// Renders one sub-category's override summary for /template list - only
// mentions settings it actually overrides, since most won't override anything.
function describeSubcategoryOverrides(sub) {
  const parts = [];
  if (sub.allowedRole) parts.push(`restricted to <@&${sub.allowedRole}>`);
  if (sub.body) parts.push(`body: ${sub.body}${sub.body !== 'GA' ? ` (vetoable: ${sub.vetoable !== false})` : ''}`);
  else if (sub.vetoable !== null) parts.push(`vetoable: ${sub.vetoable}`);
  if (sub.fields) parts.push(`own fields: ${sub.fields.join(', ')}`);
  return parts.length ? ` _(${parts.join('; ')})_` : '';
}

module.exports = {
  category: 'Administration',
  data: new SlashCommandBuilder()
    .setName('template')
    .setDescription('Manage resolution templates (admin only)')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new resolution template')
        .addStringOption((o) => o.setName('name').setDescription('Template name, e.g. Economic Policy').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('fields')
            .setDescription('Comma-separated field names (max 5), e.g. Target,Purpose,Duration,Funding,Notes')
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName('subcategories')
            .setDescription('Optional: comma-separated sub-categories, e.g. Tax Changes,Grant Policy,Bank Policy')
            .setRequired(false)
        )
        .addBooleanOption((o) => o.setName('supermajority').setDescription('Require supermajority instead of simple majority?').setRequired(false))
        .addRoleOption((o) => o.setName('restrict_to_role').setDescription('Only members with this role may use this template').setRequired(false))
        .addStringOption((o) =>
          o
            .setName('body')
            .setDescription('Which body votes on this? Default: General Assembly')
            .setRequired(false)
            .addChoices(
              { name: 'General Assembly only', value: 'GA' },
              { name: 'Security Council only', value: 'SC' },
              { name: 'Both (GA and SC must both approve)', value: 'Both' }
            )
        )
        .addBooleanOption((o) => o.setName('vetoable').setDescription('Can Permanent SC Members veto this? Default: true (only matters if body includes SC)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit an existing template - only fields you provide get changed')
        .addStringOption((o) => o.setName('name').setDescription('Current template name').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('new_name').setDescription('Rename the template').setRequired(false))
        .addStringOption((o) => o.setName('fields').setDescription('Replace the entire field list (comma-separated, max 5)').setRequired(false))
        .addStringOption((o) =>
          o
            .setName('subcategories')
            .setDescription('Replace the whole list (comma-separated) - wipes per-sub-category overrides. Type "none" to clear.')
            .setRequired(false)
        )
        .addBooleanOption((o) => o.setName('supermajority').setDescription('Require supermajority instead of simple majority?').setRequired(false))
        .addRoleOption((o) => o.setName('restrict_to_role').setDescription('Only members with this role may use this template').setRequired(false))
        .addBooleanOption((o) => o.setName('clear_role_restriction').setDescription('Set to True to remove any role restriction').setRequired(false))
        .addStringOption((o) =>
          o
            .setName('body')
            .setDescription('Which body votes on this?')
            .setRequired(false)
            .addChoices(
              { name: 'General Assembly only', value: 'GA' },
              { name: 'Security Council only', value: 'SC' },
              { name: 'Both (GA and SC must both approve)', value: 'Both' }
            )
        )
        .addBooleanOption((o) => o.setName('vetoable').setDescription('Can Permanent SC Members veto this?').setRequired(false))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable this template').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all templates')
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Enable or disable a template')
        .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled?').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Delete a template')
        .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-subcategory')
        .setDescription('Add a sub-category, optionally overriding the template\'s own rules for it')
        .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('subcategory').setDescription('Sub-category to add, e.g. Tax Changes').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('fields')
            .setDescription("Its own comma-separated fields (max 5). Blank = use the template's fields.")
            .setRequired(false)
        )
        .addRoleOption((o) => o.setName('restrict_to_role').setDescription("Only this role may use it (overrides the template's own restriction)").setRequired(false))
        .addStringOption((o) => o.setName('body').setDescription("Which body votes on it. Blank = inherit the template's.").setRequired(false).addChoices(...SUBCATEGORY_BODY_CHOICES))
        .addBooleanOption((o) => o.setName('vetoable').setDescription("Is it vetoable? Blank = inherit the template's.").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit-subcategory')
        .setDescription('Change a sub-category\'s own overrides (role/body/vetoable/fields)')
        .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('subcategory').setDescription('Sub-category to edit').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('new_name').setDescription('Rename this sub-category').setRequired(false))
        .addStringOption((o) => o.setName('fields').setDescription('Its own fields (comma-separated, max 5). "inherit" = use the template\'s.').setRequired(false))
        .addRoleOption((o) => o.setName('restrict_to_role').setDescription("Restrict it to a role (overrides the template's own restriction)").setRequired(false))
        .addBooleanOption((o) => o.setName('clear_role_restriction').setDescription("True = remove its own role restriction (falls back to the template's)").setRequired(false))
        .addStringOption((o) => o.setName('body').setDescription('Override which body votes on it').setRequired(false).addChoices(...SUBCATEGORY_BODY_CHOICES, { name: 'Inherit from template', value: 'inherit' }))
        .addBooleanOption((o) => o.setName('vetoable').setDescription('Override whether it is vetoable').setRequired(false))
        .addBooleanOption((o) => o.setName('clear_vetoable_override').setDescription("True = remove its own vetoable override (falls back to the template's)").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-subcategory')
        .setDescription('Remove a sub-category from a template')
        .addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('subcategory').setDescription('Sub-category to remove').setRequired(true).setAutocomplete(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const config = getConfig();
    if (!isAdmin(interaction.member, config)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const name = interaction.options.getString('name');
      const fieldsRaw = interaction.options.getString('fields');
      const fields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);

      if (fields.length === 0 || fields.length > 5) {
        return interaction.reply({ content: '❌ Please provide between 1 and 5 field names, separated by commas.', ephemeral: true });
      }
      if (findTemplate(name)) {
        return interaction.reply({ content: `❌ A template named **${name}** already exists.`, ephemeral: true });
      }

      const subcategoriesRaw = interaction.options.getString('subcategories');
      const subcategories = subcategoriesRaw
        ? subcategoriesRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      if (subcategories.length > 25) {
        return interaction.reply({ content: '❌ A template can have at most 25 sub-categories (a Discord dropdown limit).', ephemeral: true });
      }

      const supermajority = interaction.options.getBoolean('supermajority') || false;
      const restrictRole = interaction.options.getRole('restrict_to_role');
      const body = interaction.options.getString('body') || 'GA';
      const vetoable = interaction.options.getBoolean('vetoable');

      const templates = getAllTemplates();
      templates.push({
        name,
        fields,
        subcategories,
        enabled: true,
        requiresSupermajority: supermajority,
        allowedRole: restrictRole ? restrictRole.id : null,
        body,
        vetoable: vetoable === null ? true : vetoable,
      });
      saveAllTemplates(templates);

      return interaction.reply({
        content: `✅ Template **${name}** created with fields: ${fields.join(', ')}.${
          subcategories.length ? ` Sub-categories: ${subcategories.join(', ')}.` : ''
        } Body: ${body}${body !== 'GA' ? ` (vetoable: ${vetoable === null ? true : vetoable})` : ''}`,
        ephemeral: true,
      });
    }

    if (sub === 'edit') {
      const name = interaction.options.getString('name');
      const templates = getAllTemplates();
      const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });

      const changes = [];

      const newName = interaction.options.getString('new_name');
      if (newName && newName.trim() && newName.trim().toLowerCase() !== t.name.toLowerCase()) {
        const collision = templates.find((x) => x.name.toLowerCase() === newName.trim().toLowerCase());
        if (collision) {
          return interaction.reply({ content: `❌ A template named **${newName.trim()}** already exists.`, ephemeral: true });
        }
        const oldName = t.name;
        t.name = newName.trim();
        changes.push(`name → **${t.name}**`);

        // Resolutions look their template back up BY NAME (to read live
        // rules like majority threshold and veto eligibility right up
        // until voting opens), so a rename has to follow any resolution
        // still in progress - otherwise it would silently lose its rules.
        const resolutions = getAllResolutions();
        let relinked = 0;
        for (const r of resolutions) {
          if (r.templateName === oldName && ACTIVE_STATUSES.includes(r.status)) {
            r.templateName = t.name;
            relinked += 1;
          }
        }
        if (relinked > 0) {
          saveAllResolutions(resolutions);
          changes.push(`${relinked} in-progress resolution(s) relinked to the new name`);
        }
      }

      const fieldsRaw = interaction.options.getString('fields');
      if (fieldsRaw) {
        const fields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);
        if (fields.length === 0 || fields.length > 5) {
          return interaction.reply({ content: '❌ Please provide between 1 and 5 field names, separated by commas.', ephemeral: true });
        }
        t.fields = fields;
        changes.push(`fields → ${fields.join(', ')}`);
      }

      const subcategoriesRaw = interaction.options.getString('subcategories');
      if (subcategoriesRaw !== null) {
        if (subcategoriesRaw.trim().toLowerCase() === 'none' || subcategoriesRaw.trim() === '') {
          t.subcategories = [];
          changes.push('sub-categories → cleared');
        } else {
          const subcategories = subcategoriesRaw.split(',').map((s) => s.trim()).filter(Boolean);
          if (subcategories.length > 25) {
            return interaction.reply({ content: '❌ A template can have at most 25 sub-categories (a Discord dropdown limit).', ephemeral: true });
          }
          t.subcategories = subcategories;
          changes.push(`sub-categories → ${subcategories.join(', ')}`);
        }
      }

      const supermajority = interaction.options.getBoolean('supermajority');
      if (supermajority !== null) {
        t.requiresSupermajority = supermajority;
        changes.push(`requires supermajority → ${supermajority}`);
      }

      const clearRole = interaction.options.getBoolean('clear_role_restriction');
      const restrictRole = interaction.options.getRole('restrict_to_role');
      if (clearRole) {
        t.allowedRole = null;
        changes.push('role restriction → cleared');
      } else if (restrictRole) {
        t.allowedRole = restrictRole.id;
        changes.push(`restricted to → <@&${restrictRole.id}>`);
      }

      const body = interaction.options.getString('body');
      if (body) {
        t.body = body;
        changes.push(`body → ${body}`);
      }

      const vetoable = interaction.options.getBoolean('vetoable');
      if (vetoable !== null) {
        t.vetoable = vetoable;
        changes.push(`vetoable → ${vetoable}`);
      }

      const enabled = interaction.options.getBoolean('enabled');
      if (enabled !== null) {
        t.enabled = enabled;
        changes.push(`enabled → ${enabled}`);
      }

      if (changes.length === 0) {
        return interaction.reply({ content: '❌ You must provide at least one thing to change.', ephemeral: true });
      }

      saveAllTemplates(templates);
      logAudit(interaction.client, 'Template Edited', `**${t.name}** edited by ${interaction.user.tag}:\n${changes.join('\n')}`).catch((err) => console.error(err));

      return interaction.reply({
        content: `✅ Template **${t.name}** updated:\n${changes.map((c) => `• ${c}`).join('\n')}`,
        ephemeral: true,
      });
    }

    if (sub === 'list') {
      const templates = getAllTemplates();
      if (templates.length === 0) {
        return interaction.reply({ content: 'No templates exist yet. Use `/template create` to add one.', ephemeral: true });
      }

      // Each template becomes one embed field instead of one line of plain
      // text - fields have a much higher combined limit (6000 chars, 25
      // fields per embed) than a single message's content (2000 chars
      // total), so this can't blow past Discord's limit as the list grows.
      const fields = templates.map((t) => {
        const subcategoryLines =
          t.subcategories && t.subcategories.length
            ? `Sub-categories:\n${t.subcategories.map((s) => `  • ${s.name}${describeSubcategoryOverrides(s)}`).join('\n')}`
            : null;

        const details = [
          `Fields: ${t.fields.join(', ')}`,
          subcategoryLines,
          t.requiresSupermajority ? 'Requires supermajority' : null,
          t.allowedRole ? `Restricted to <@&${t.allowedRole}>` : null,
          `Body: ${t.body || 'GA'}${(t.body || 'GA') !== 'GA' ? ` (vetoable: ${t.vetoable !== false})` : ''}`,
        ]
          .filter(Boolean)
          .join('\n');

        return {
          name: `${t.enabled ? '✅' : '⛔'} ${t.name}`.slice(0, 256),
          value: details.slice(0, 1024),
        };
      });

      const MAX_FIELDS_PER_EMBED = 20;
      const MAX_CHARS_PER_EMBED = 5000;

      const fieldGroups = [];
      let currentFields = [];
      let currentChars = 0;
      for (const field of fields) {
        const fieldChars = field.name.length + field.value.length;
        const wouldOverflow = currentFields.length >= MAX_FIELDS_PER_EMBED || currentChars + fieldChars > MAX_CHARS_PER_EMBED;
        if (wouldOverflow && currentFields.length > 0) {
          fieldGroups.push(currentFields);
          currentFields = [];
          currentChars = 0;
        }
        currentFields.push(field);
        currentChars += fieldChars;
      }
      if (currentFields.length > 0) fieldGroups.push(currentFields);

      // Discord allows at most 10 embeds per message.
      const embeds = fieldGroups.slice(0, 10).map((group, i) =>
        new EmbedBuilder()
          .setTitle(i === 0 ? '📋 Resolution Templates' : undefined)
          .setColor(0x5865f2)
          .addFields(group)
      );

      const overflowNote =
        fieldGroups.length > 10 ? `⚠️ Showing the first ${10 * MAX_FIELDS_PER_EMBED} templates - you have more configured than fit here.` : undefined;

      return interaction.reply({ content: overflowNote, embeds, ephemeral: true });
    }

    if (sub === 'toggle') {
      const name = interaction.options.getString('name');
      const enabled = interaction.options.getBoolean('enabled');
      const templates = getAllTemplates();
      const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });
      t.enabled = enabled;
      saveAllTemplates(templates);
      return interaction.reply({ content: `✅ Template **${name}** is now ${enabled ? 'enabled' : 'disabled'}.`, ephemeral: true });
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('name');
      const templates = getAllTemplates();
      const filtered = templates.filter((x) => x.name.toLowerCase() !== name.toLowerCase());
      if (filtered.length === templates.length) {
        return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });
      }
      saveAllTemplates(filtered);
      return interaction.reply({ content: `🗑️ Template **${name}** deleted.`, ephemeral: true });
    }

    if (sub === 'add-subcategory') {
      const name = interaction.options.getString('name');
      const subcategory = interaction.options.getString('subcategory').trim();
      const templates = getAllTemplates();
      const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });

      t.subcategories = t.subcategories || [];
      if (findSubcategory(t, subcategory)) {
        return interaction.reply({ content: `**${subcategory}** is already a sub-category of **${name}**.`, ephemeral: true });
      }
      if (t.subcategories.length >= 25) {
        return interaction.reply({ content: '❌ A template can have at most 25 sub-categories (a Discord dropdown limit).', ephemeral: true });
      }

      const fieldsRaw = interaction.options.getString('fields');
      let fields = null;
      if (fieldsRaw) {
        fields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);
        if (fields.length === 0 || fields.length > 5) {
          return interaction.reply({ content: '❌ A sub-category can have between 1 and 5 of its own fields, separated by commas.', ephemeral: true });
        }
      }
      const restrictRole = interaction.options.getRole('restrict_to_role');
      const body = interaction.options.getString('body');
      const vetoable = interaction.options.getBoolean('vetoable');

      const entry = {
        name: subcategory,
        allowedRole: restrictRole ? restrictRole.id : null,
        body: body || null,
        vetoable: vetoable === null ? null : vetoable,
        fields,
      };
      t.subcategories.push(entry);
      saveAllTemplates(templates);

      logAudit(interaction.client, 'Sub-category Added', `**${subcategory}** added to **${t.name}** by ${interaction.user.tag}.${describeSubcategoryOverrides(entry)}`).catch((err) => console.error(err));

      return interaction.reply({
        content: `✅ Added sub-category **${subcategory}** to **${name}**.${describeSubcategoryOverrides(entry)}\nCurrent: ${t.subcategories.map((s) => s.name).join(', ')}`,
        ephemeral: true,
      });
    }

    if (sub === 'edit-subcategory') {
      const name = interaction.options.getString('name');
      const subcategoryName = interaction.options.getString('subcategory').trim();
      const templates = getAllTemplates();
      const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });

      t.subcategories = t.subcategories || [];
      const sc = t.subcategories.find((s) => s.name.toLowerCase() === subcategoryName.toLowerCase());
      if (!sc) return interaction.reply({ content: `❌ **${subcategoryName}** is not currently a sub-category of **${name}**.`, ephemeral: true });

      const changes = [];

      const newName = interaction.options.getString('new_name');
      if (newName && newName.trim() && newName.trim().toLowerCase() !== sc.name.toLowerCase()) {
        if (t.subcategories.some((s) => s !== sc && s.name.toLowerCase() === newName.trim().toLowerCase())) {
          return interaction.reply({ content: `❌ **${name}** already has a sub-category named **${newName.trim()}**.`, ephemeral: true });
        }
        const oldName = sc.name;
        sc.name = newName.trim();
        changes.push(`name → **${sc.name}**`);

        // Same reasoning as renaming a template (see 'edit' above): any
        // in-progress resolution filed under the old sub-category name has
        // to follow the rename, or it would silently lose its rules/fields.
        const resolutions = getAllResolutions();
        let relinked = 0;
        for (const r of resolutions) {
          if (r.templateName === t.name && r.subcategory === oldName && ACTIVE_STATUSES.includes(r.status)) {
            r.subcategory = sc.name;
            relinked += 1;
          }
        }
        if (relinked > 0) {
          saveAllResolutions(resolutions);
          changes.push(`${relinked} in-progress resolution(s) relinked to the new name`);
        }
      }

      const fieldsRaw = interaction.options.getString('fields');
      if (fieldsRaw !== null) {
        if (fieldsRaw.trim().toLowerCase() === 'inherit' || fieldsRaw.trim() === '') {
          sc.fields = null;
          changes.push("own fields → cleared (now inherits the template's)");
        } else {
          const fields = fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean);
          if (fields.length === 0 || fields.length > 5) {
            return interaction.reply({ content: '❌ A sub-category can have between 1 and 5 of its own fields, separated by commas.', ephemeral: true });
          }
          sc.fields = fields;
          changes.push(`own fields → ${fields.join(', ')}`);
        }
      }

      const clearRole = interaction.options.getBoolean('clear_role_restriction');
      const restrictRole = interaction.options.getRole('restrict_to_role');
      if (clearRole) {
        sc.allowedRole = null;
        changes.push("own role restriction → cleared (now inherits the template's)");
      } else if (restrictRole) {
        sc.allowedRole = restrictRole.id;
        changes.push(`own role restriction → <@&${restrictRole.id}>`);
      }

      const body = interaction.options.getString('body');
      if (body === 'inherit') {
        sc.body = null;
        changes.push("own body → cleared (now inherits the template's)");
      } else if (body) {
        sc.body = body;
        changes.push(`own body → ${body}`);
      }

      const clearVetoable = interaction.options.getBoolean('clear_vetoable_override');
      const vetoable = interaction.options.getBoolean('vetoable');
      if (clearVetoable) {
        sc.vetoable = null;
        changes.push("own vetoable override → cleared (now inherits the template's)");
      } else if (vetoable !== null) {
        sc.vetoable = vetoable;
        changes.push(`own vetoable → ${vetoable}`);
      }

      if (changes.length === 0) {
        return interaction.reply({ content: '❌ You must provide at least one thing to change.', ephemeral: true });
      }

      saveAllTemplates(templates);
      logAudit(interaction.client, 'Sub-category Edited', `**${t.name} → ${sc.name}** edited by ${interaction.user.tag}:\n${changes.join('\n')}`).catch((err) => console.error(err));

      return interaction.reply({
        content: `✅ Sub-category **${sc.name}** of **${t.name}** updated:\n${changes.map((c) => `• ${c}`).join('\n')}`,
        ephemeral: true,
      });
    }

    if (sub === 'remove-subcategory') {
      const name = interaction.options.getString('name');
      const subcategory = interaction.options.getString('subcategory').trim();
      const templates = getAllTemplates();
      const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) return interaction.reply({ content: `❌ No template named **${name}**.`, ephemeral: true });

      t.subcategories = t.subcategories || [];
      if (!findSubcategory(t, subcategory)) {
        return interaction.reply({ content: `**${subcategory}** is not currently a sub-category of **${name}**.`, ephemeral: true });
      }

      t.subcategories = t.subcategories.filter((s) => s.name.toLowerCase() !== subcategory.toLowerCase());
      saveAllTemplates(templates);
      return interaction.reply({
        content: `✅ Removed sub-category **${subcategory}** from **${name}**. ${t.subcategories.length ? `Remaining: ${t.subcategories.map((s) => s.name).join(', ')}` : 'No sub-categories remain.'}`,
        ephemeral: true,
      });
    }
  },
};
