// index.js
// This is the file you run to start the bot: `npm start`
// It connects to Discord, loads all slash commands, and decides what to do
// whenever someone uses a command, clicks a button, picks a menu option,
// or submits a pop-up form.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Collection,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const { getConfig } = require('./lib/config');
const { initializeDataFiles } = require('./lib/storage');
const { isEligibleVoter, isSCMember, isSCPermanentMember, isAdmin, getVoteWeight } = require('./lib/permissions');
const { findTemplate, findResolution, getAllResolutions, getAllTemplates, upsertResolution, getActiveResolutionsByMember, EDITABLE_STATUSES, SELF_DELETABLE_STATUSES } = require('./lib/resolutions');
const { nextResolutionNumber } = require('./lib/numbering');
const { resolutionEmbed, amendmentEmbed } = require('./lib/embeds');
const { logAudit, notify, dmUser } = require('./lib/audit');
const { refreshTrackMessage, castVeto, postToReviewChannels, getDebateTargetChannelIds } = require('./lib/voting');
const {
  AMENDMENT_TYPE_LABELS,
  AMENDMENT_TYPE_MODAL_CONFIG,
  isAmendmentEligibleVoter,
  createAmendment,
  refreshAmendmentMessage,
} = require('./lib/amendments');
const { startScheduler } = require('./lib/scheduler');
const { renderHelpPage } = require('./lib/help');
const { renderConfigView } = require('./lib/configView');
const { findElection, getAllElections } = require('./lib/electionsData');
const { isEligibleElectionVoter, castBallot, refreshElectionMessage } = require('./lib/elections');
const { effectiveSettings } = require('./lib/subcategories');

// Make sure /data and every JSON file inside it exist before anything else
// runs. This matters most on hosts like Railway, where a freshly mounted
// persistent volume starts out completely empty - without this, the very
// first command would crash trying to read a file that doesn't exist yet.
initializeDataFiles();
console.log('Data files ready (config.json, resolutions.json, templates.json, counters.json, elections.json).');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// --- Load every command file in src/commands into a Collection ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Safety net: if something unexpected still slips through, log it instead
// of letting Node crash the whole bot process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (bot is still running):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (bot is still running):', err);
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  startScheduler(client);
});

// Re-checks whether a member is still allowed to use a template - called
// again at select-menu and modal-submit time (not just when /propose first
// built the dropdown) in case their roles changed in between.
function canUseTemplate(member, template, config) {
  if (template.allowedRole && !member.roles.cache.has(template.allowedRole)) return false;
  if ((template.body === 'SC' || template.body === 'Both') && !isSCMember(member, config)) return false;
  return true;
}

// Same idea as canUseTemplate(), but also accounts for a sub-category's own
// overrides (role restriction and/or GA/SC/Both) - a sub-category can be
// more restrictive than its template (e.g. a "Sanctions" sub-category that's
// SC-only under an otherwise GA-wide template), so this always needs to be
// re-checked once a specific sub-category is known, not just the template.
function canUseSubcategory(member, template, subcategoryName, config) {
  if (!canUseTemplate(member, template, config)) return false;
  if (!subcategoryName) return true;
  const settings = effectiveSettings(template, subcategoryName);
  if (settings.allowedRole && !member.roles.cache.has(settings.allowedRole)) return false;
  if ((settings.body === 'SC' || settings.body === 'Both') && !isSCMember(member, config)) return false;
  return true;
}

// Builds the pop-up form for a template. If a subcategory was chosen, it's
// baked into the modal's customId (double-colon-separated, both parts
// URI-encoded) so we know it again once the member submits the form. Fields
// come from the sub-category's own field list if it has one, otherwise the
// template's - see lib/subcategories.js.
function buildResolutionModal(templateName, template, subcategory) {
  const fields = effectiveSettings(template, subcategory).fields;
  const modal = new ModalBuilder()
    .setCustomId(`propose_modal_${encodeURIComponent(templateName)}::${encodeURIComponent(subcategory || '')}`)
    .setTitle((subcategory ? `${templateName} — ${subcategory}` : templateName).slice(0, 45));

  for (let i = 0; i < fields.length; i++) {
    const input = new TextInputBuilder()
      .setCustomId(`field_${i}`)
      .setLabel(fields[i].slice(0, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

// Builds the pop-up form for an amendment, once its type and target field
// are already known. Both are baked into the modal's customId (double-colon
// separated, each part URI-encoded) so we know them again on submit.
function buildAmendmentModal(type, targetField, resolutionNumber) {
  const typeConfig = AMENDMENT_TYPE_MODAL_CONFIG[type];
  const modal = new ModalBuilder()
    .setCustomId(`amendment_modal_${encodeURIComponent(type)}::${encodeURIComponent(targetField)}::${encodeURIComponent(resolutionNumber)}`)
    .setTitle(`${AMENDMENT_TYPE_LABELS[type]} — ${targetField}`.slice(0, 45));

  const originalInput = new TextInputBuilder()
    .setCustomId('original_text')
    .setLabel(typeConfig.originalLabel.slice(0, 45))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(typeConfig.originalRequired);

  const newInput = new TextInputBuilder()
    .setCustomId('new_text')
    .setLabel(typeConfig.newLabel.slice(0, 45))
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(typeConfig.newRequired);

  modal.addComponents(new ActionRowBuilder().addComponents(originalInput), new ActionRowBuilder().addComponents(newInput));
  return modal;
}

client.on('interactionCreate', async (interaction) => {
  try {
    // 0) Autocomplete: as the user types in a "number" field, suggest
    // matching resolutions showing their title, proposer, and status - so
    // nobody has to memorize a resolution number.
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const cmd = interaction.commandName;
      const sub = interaction.options.getSubcommand(false);

      if (focused.name === 'amendment_id') {
        const numberValue = interaction.options.getString('number');
        const resolution = numberValue ? findResolution(numberValue) : null;
        let amendments = resolution ? resolution.amendments || [] : [];

        if (sub === 'vote-start') amendments = amendments.filter((a) => a.status === 'Debate');
        else if (sub === 'vote-close') amendments = amendments.filter((a) => a.status === 'Voting');
        else if (sub === 'withdraw') amendments = amendments.filter((a) => a.status === 'Debate' || a.status === 'Voting');

        const query = focused.value.toLowerCase();
        amendments = amendments.filter(
          (a) => a.id.toLowerCase().includes(query) || a.targetField.toLowerCase().includes(query)
        );

        return interaction
          .respond(
            amendments.slice(0, 25).map((a) => ({
              name: `${a.id} — ${AMENDMENT_TYPE_LABELS[a.type] || a.type} → ${a.targetField} (${a.status})`.slice(0, 100),
              value: a.id,
            }))
          )
          .catch(() => {});
      }

      if (cmd === 'template' && focused.name === 'name') {
        const query = focused.value.toLowerCase();
        const templates = getAllTemplates().filter((t) => t.name.toLowerCase().includes(query));
        return interaction
          .respond(
            templates.slice(0, 25).map((t) => ({
              name: `${t.name} (${t.enabled ? 'enabled' : 'disabled'}, body: ${t.body || 'GA'})`.slice(0, 100),
              value: t.name,
            }))
          )
          .catch(() => {});
      }

      if (cmd === 'template' && focused.name === 'subcategory') {
        const templateName = interaction.options.getString('name');
        const template = templateName ? findTemplate(templateName) : null;
        const query = focused.value.toLowerCase();
        const subcategories = template ? (template.subcategories || []).filter((s) => s.name.toLowerCase().includes(query)) : [];
        return interaction
          .respond(subcategories.slice(0, 25).map((s) => ({ name: s.name.slice(0, 100), value: s.name })))
          .catch(() => {});
      }

      if (cmd === 'election') {
        const query = focused.value.toLowerCase();

        if (focused.name === 'candidate_id') {
          const numberValue = interaction.options.getString('number');
          const election = numberValue ? findElection(numberValue) : null;
          let candidates = election ? election.candidates : [];

          if (sub === 'approve' || sub === 'reject') candidates = candidates.filter((c) => c.status === 'Pending');
          else if (sub === 'withdraw') candidates = candidates.filter((c) => c.status === 'Pending' || c.status === 'Approved');
          else if (sub === 'declare-winner') candidates = candidates.filter((c) => election.tieCandidateIds && election.tieCandidateIds.includes(c.id));
          else if (sub === 'known-as') candidates = candidates.filter((c) => c.status === 'Pending' || c.status === 'Approved');

          candidates = candidates.filter(
            (c) => c.id.toLowerCase().includes(query) || (c.tag || c.label || '').toLowerCase().includes(query) || (c.knownAs || '').toLowerCase().includes(query)
          );

          return interaction
            .respond(
              candidates.slice(0, 25).map((c) => ({
                name: `${c.id} — ${c.tag || c.label}${c.knownAs ? ` (known as ${c.knownAs})` : ''} (${c.status})`.slice(0, 100),
                value: c.id,
              }))
            )
            .catch(() => {});
        }

        if (focused.name === 'number') {
          let elections = getAllElections();
          if (sub === 'register' || sub === 'nominate') elections = elections.filter((e) => e.status === 'Registration' || e.status === 'Campaign');
          else if (sub === 'open-voting') elections = elections.filter((e) => e.status === 'Registration' || e.status === 'Campaign');
          else if (sub === 'close') elections = elections.filter((e) => e.status === 'Voting');
          else if (sub === 'declare-winner') elections = elections.filter((e) => e.status === 'Tied - Awaiting Manual Resolution');

          elections = elections.filter((e) => e.number.toLowerCase().includes(query) || e.title.toLowerCase().includes(query));
          elections = elections.slice(-25).reverse();

          return interaction
            .respond(elections.map((e) => ({ name: `${e.number} — ${e.title} (${e.status})`.slice(0, 100), value: e.number })))
            .catch(() => {});
        }

        return interaction.respond([]).catch(() => {});
      }

      if (focused.name !== 'number') {
        return interaction.respond([]);
      }

      const query = focused.value.toLowerCase();
      let list = getAllResolutions();

      if (cmd === 'sponsor') list = list.filter((r) => ['Draft', 'Awaiting Sponsors'].includes(r.status));
      else if (cmd === 'review') list = list.filter((r) => r.status === 'Under Administrative Review');
      else if (cmd === 'debate') list = list.filter((r) => r.status === 'Debate');
      else if (cmd === 'vote' && sub === 'start') list = list.filter((r) => r.status === 'Debate');
      else if (cmd === 'vote' && sub === 'close') list = list.filter((r) => r.status === 'Voting');
      else if (cmd === 'veto') list = list.filter((r) => r.tracks && r.tracks.SC);
      else if (cmd === 'amendment' && sub === 'propose') list = list.filter((r) => r.status === 'Debate');
      else if (cmd === 'resolution' && sub === 'edit') list = list.filter((r) => EDITABLE_STATUSES.includes(r.status));
      else if (cmd === 'resolution' && sub === 'delete') list = list.filter((r) => SELF_DELETABLE_STATUSES.includes(r.status));
      // /resolution view, /resolution admin-delete, and /amendment list/vote-start/vote-close/withdraw: no extra filter here.

      list = list.filter(
        (r) =>
          r.number.toLowerCase().includes(query) ||
          r.title.toLowerCase().includes(query) ||
          (r.submittedByTag || '').toLowerCase().includes(query)
      );

      list = list.slice(-25).reverse();

      return interaction
        .respond(
          list.map((r) => ({
            name: `${r.number} — ${r.title} (by ${r.submittedByTag}, ${r.status})`.slice(0, 100),
            value: r.number,
          }))
        )
        .catch(() => {}); // Autocomplete responses can go stale fast - safe to ignore failures.
    }

    // 1) Slash commands (/config, /propose, /vote, etc.)
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    // 2a) Member picked a category from the /help dropdown -> show that category, page 0
    if (interaction.isStringSelectMenu() && interaction.customId === 'help_category_select') {
      const category = interaction.values[0];
      const { embed, components } = renderHelpPage(client, category, 0);
      return interaction.update({ embeds: [embed], components });
    }

    // 2b) Member clicked Previous/Next on /help -> show the requested page
    if (interaction.isButton() && interaction.customId.startsWith('help_nav_')) {
      const rest = interaction.customId.replace('help_nav_', '');
      const lastUnderscore = rest.lastIndexOf('_');
      const category = decodeURIComponent(rest.slice(0, lastUnderscore));
      const pageIndex = parseInt(rest.slice(lastUnderscore + 1), 10) || 0;
      const { embed, components } = renderHelpPage(client, category, pageIndex);
      return interaction.update({ embeds: [embed], components });
    }

    // 2c) Admin picked a category from the /config view dropdown -> show that category
    if (interaction.isStringSelectMenu() && interaction.customId === 'configview_select') {
      const category = interaction.values[0];
      const { embed, components } = renderConfigView(getConfig(), category);
      return interaction.update({ embeds: [embed], components });
    }

    // 2) Member picked a template from the /propose dropdown -> either show a
    // second dropdown for sub-category (if the template has any), or go
    // straight to the form.
    if (interaction.isStringSelectMenu() && interaction.customId === 'propose_select_template') {
      const templateName = interaction.values[0];
      const template = findTemplate(templateName);
      if (!template || !template.enabled) {
        return interaction.update({ content: '❌ That template is no longer available.', components: [] });
      }
      if (!canUseTemplate(interaction.member, template, getConfig())) {
        return interaction.update({ content: '❌ You are no longer eligible to use this template.', components: [] });
      }

      if (template.subcategories && template.subcategories.length > 0) {
        const config = getConfig();
        // A sub-category can be more restrictive than its template (its own
        // role and/or GA/SC/Both override) - only offer the ones this
        // member is actually eligible for, rather than letting them pick
        // one just to be rejected on the next step.
        const usableSubcategories = template.subcategories.filter((s) => canUseSubcategory(interaction.member, template, s.name, config));

        if (usableSubcategories.length === 0) {
          return interaction.update({ content: `❌ There are no sub-categories of **${templateName}** available to you right now.`, components: [] });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`propose_select_subcategory_${encodeURIComponent(templateName)}`)
          .setPlaceholder('Choose a sub-category...')
          .addOptions(
            usableSubcategories.slice(0, 25).map((s) => {
              const settings = effectiveSettings(template, s.name);
              const tag = settings.body !== (template.body || 'GA') ? (settings.body === 'SC' ? '🔒 Security Council' : settings.body === 'Both' ? '🔒 GA + SC' : null) : null;
              return {
                label: (tag ? `${s.name} — ${tag}` : s.name).slice(0, 100),
                value: s.name,
                description: s.fields ? `Own fields: ${s.fields.join(', ')}`.slice(0, 100) : undefined,
              };
            })
          );

        return interaction.update({
          content: `Select the sub-category for **${templateName}**:`,
          components: [new ActionRowBuilder().addComponents(menu)],
        });
      }

      return interaction.showModal(buildResolutionModal(templateName, template, null));
    }

    // 2b) Member picked a sub-category -> show the form
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('propose_select_subcategory_')) {
      const templateName = decodeURIComponent(interaction.customId.replace('propose_select_subcategory_', ''));
      const subcategory = interaction.values[0];
      const template = findTemplate(templateName);
      if (!template || !template.enabled) {
        return interaction.update({ content: '❌ That template is no longer available.', components: [] });
      }
      if (!canUseSubcategory(interaction.member, template, subcategory, getConfig())) {
        return interaction.update({ content: '❌ You are no longer eligible to use this sub-category.', components: [] });
      }

      return interaction.showModal(buildResolutionModal(templateName, template, subcategory));
    }

    // 3) Member submitted the resolution form -> create the resolution
    if (interaction.isModalSubmit() && interaction.customId.startsWith('propose_modal_')) {
      const raw = interaction.customId.replace('propose_modal_', '');
      const sepIndex = raw.indexOf('::');
      const templateName = decodeURIComponent(sepIndex === -1 ? raw : raw.slice(0, sepIndex));
      const subcategory = sepIndex === -1 ? null : decodeURIComponent(raw.slice(sepIndex + 2)) || null;
      const template = findTemplate(templateName);
      if (!template) {
        return interaction.reply({ content: '❌ That template no longer exists.', ephemeral: true });
      }

      const config = getConfig();

      if (!canUseSubcategory(interaction.member, template, subcategory, config)) {
        return interaction.reply({ content: '❌ You are not eligible to use this template/sub-category.', ephemeral: true });
      }

      const limit = config.maxActiveResolutionsPerMember;
      if (limit > 0) {
        const active = getActiveResolutionsByMember(interaction.user.id);
        if (active.length >= limit) {
          const list = active.map((r) => `**${r.number}** — ${r.title} (${r.status})`).join('\n');
          return interaction.reply({
            content: `❌ You already have ${active.length}/${limit} active resolution(s) — the maximum allowed at once:\n${list}\nYou can propose a new one once one of these is resolved.`,
            ephemeral: true,
          });
        }
      }

      // A sub-category can have its own field list, and its own body/vetoable
      // overrides - resolve all of that once here, and use it for
      // everything below, instead of assuming the template's own settings.
      const effective = effectiveSettings(template, subcategory);

      const fields = {};
      effective.fields.forEach((fieldName, i) => {
        fields[fieldName] = interaction.fields.getTextInputValue(`field_${i}`);
      });

      const number = nextResolutionNumber(config);
      // The proposer automatically counts as the first sponsor - they
      // don't need to run /sponsor add on their own resolution.
      const sponsors = [interaction.user.id];
      const resolution = {
        number,
        title: `${templateName}${subcategory ? ` — ${subcategory}` : ''} — ${fields[effective.fields[0]]}`.slice(0, 200),
        templateName,
        subcategory,
        fields,
        sponsors,
        status: sponsors.length >= config.sponsorsRequired ? 'Under Administrative Review' : 'Awaiting Sponsors',
        submittedBy: interaction.user.id,
        submittedByTag: interaction.user.tag,
        createdAt: Date.now(),
        body: effective.body,
        vetoable: effective.vetoable,
      };

      upsertResolution(resolution);

      // Reply immediately, then handle the slower side effects afterward
      // so we never risk missing Discord's 3-second reply window.
      const stillNeeded = config.sponsorsRequired - resolution.sponsors.length;
      await interaction.reply({
        content: `✅ Your resolution **${resolution.number}** has been submitted! You are automatically its first sponsor. ${
          stillNeeded > 0
            ? `It needs ${stillNeeded} more sponsor(s) — ask others to use \`/sponsor add\`.`
            : 'It is now under review.'
        }`,
        embeds: [resolutionEmbed(resolution)],
        ephemeral: true,
      });

      logAudit(client, 'Resolution Created', `**${resolution.number}** — ${resolution.title}\nBy: ${interaction.user.tag}`, resolution.body).catch((err) => console.error(err));
      notify(client, `📝 A new resolution has been submitted: **${resolution.number}** — ${resolution.title}`, resolution.body).catch((err) => console.error(err));

      // Only post to the review channel once the resolution is actually
      // ready for review - if it still needs sponsors, that happens later
      // in /sponsor add, once the threshold is met.
      if (resolution.status === 'Under Administrative Review') {
        postToReviewChannels(client, resolution, config).catch((err) => console.error(err));
      }
      return;
    }

    // 5) Member picked which field an amendment applies to -> show the form
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('amendment_select_field_')) {
      const rest = interaction.customId.replace('amendment_select_field_', '');
      const lastUnderscore = rest.lastIndexOf('_');
      const type = rest.slice(0, lastUnderscore);
      const resolutionNumber = decodeURIComponent(rest.slice(lastUnderscore + 1));
      const targetField = interaction.values[0];

      const resolution = findResolution(resolutionNumber);
      if (!resolution || resolution.status !== 'Debate') {
        return interaction.update({ content: '❌ This resolution is no longer in debate; the amendment cannot be proposed.', components: [] });
      }

      return interaction.showModal(buildAmendmentModal(type, targetField, resolutionNumber));
    }

    // 6) Member submitted the amendment form -> create the amendment
    if (interaction.isModalSubmit() && interaction.customId.startsWith('amendment_modal_')) {
      const raw = interaction.customId.replace('amendment_modal_', '');
      const [rawType, rawField, rawNumber] = raw.split('::');
      const type = decodeURIComponent(rawType);
      const targetField = decodeURIComponent(rawField);
      const resolutionNumber = decodeURIComponent(rawNumber);

      const resolution = findResolution(resolutionNumber);
      if (!resolution || resolution.status !== 'Debate') {
        return interaction.reply({ content: '❌ This resolution is no longer in debate; the amendment cannot be submitted.', ephemeral: true });
      }

      const originalText = interaction.fields.getTextInputValue('original_text').trim() || null;
      const newText = interaction.fields.getTextInputValue('new_text').trim() || null;

      const amendment = createAmendment(resolution, { type, targetField, originalText, newText, sponsorId: interaction.user.id });

      await interaction.reply({
        content: `✅ Amendment **${amendment.id}** (${AMENDMENT_TYPE_LABELS[type]} → ${targetField}) proposed on **${resolution.number}**. Debate on it closes <t:${Math.floor(amendment.debate.endsAt / 1000)}:f>, after which voting opens automatically.`,
        ephemeral: true,
      });

      const config = getConfig();
      const targetChannelIds = getDebateTargetChannelIds(resolution, config);
      for (const channelId of targetChannelIds) {
        client.channels
          .fetch(channelId)
          .then(
            (channel) =>
              channel &&
              channel.send({
                content: `📝 A new amendment (**${amendment.id}**) has been proposed on **${resolution.number}** by ${interaction.user.tag}.`,
                embeds: [amendmentEmbed(resolution, amendment)],
              })
          )
          .catch((err) => console.error('Failed to post amendment to debate channel:', err));
      }

      logAudit(client, 'Amendment Proposed', `**${resolution.number}** ${amendment.id} (${AMENDMENT_TYPE_LABELS[type]} → ${targetField}) by ${interaction.user.tag}`, resolution.body).catch((err) => console.error(err));
      if (resolution.submittedBy !== interaction.user.id) {
        dmUser(client, resolution.submittedBy, `📝 A new amendment (${amendment.id}) has been proposed on your resolution **${resolution.number}**.`);
      }
      return;
    }

    // 6b) Member submitted the /resolution edit form -> apply the changes
    if (interaction.isModalSubmit() && interaction.customId.startsWith('resedit_modal_')) {
      const number = decodeURIComponent(interaction.customId.replace('resedit_modal_', ''));
      const config = getConfig();
      const resolution = findResolution(number);

      if (!resolution) {
        return interaction.reply({ content: `❌ **${number}** no longer exists.`, ephemeral: true });
      }
      const canEdit = isAdmin(interaction.member, config) || resolution.submittedBy === interaction.user.id;
      if (!canEdit) {
        return interaction.reply({ content: '❌ Only the proposer or an admin can edit this resolution.', ephemeral: true });
      }
      if (!EDITABLE_STATUSES.includes(resolution.status)) {
        return interaction.reply({ content: `❌ This resolution can no longer be edited (status: ${resolution.status}).`, ephemeral: true });
      }

      const template = findTemplate(resolution.templateName);
      if (!template) {
        return interaction.reply({ content: '❌ The template this resolution was created from no longer exists.', ephemeral: true });
      }

      const wasReturnedForRevision = resolution.status === 'Returned for Revision';

      // Use whichever field list actually applies to this resolution's
      // sub-category (it may have its own, distinct from the template's) -
      // this has to match what /resolution edit used to build the form.
      const editFields = effectiveSettings(template, resolution.subcategory).fields;
      editFields.forEach((fieldName, i) => {
        resolution.fields[fieldName] = interaction.fields.getTextInputValue(`field_${i}`);
      });
      resolution.title = `${resolution.templateName}${resolution.subcategory ? ` — ${resolution.subcategory}` : ''} — ${resolution.fields[editFields[0]]}`.slice(0, 200);

      // Editing after a revision request sends it straight back to review
      // (its sponsors already met the threshold before revision was
      // requested, so there's no need to re-collect them).
      if (wasReturnedForRevision) {
        resolution.status = 'Under Administrative Review';
        resolution.reviewNote = null;
      }
      upsertResolution(resolution);

      await interaction.reply({
        content: `✅ **${resolution.number}** has been updated.${wasReturnedForRevision ? ' It has been sent back to review.' : ''}`,
        embeds: [resolutionEmbed(resolution)],
        ephemeral: true,
      });

      logAudit(client, 'Resolution Edited', `**${resolution.number}** edited by ${interaction.user.tag}.`, resolution.body).catch((err) => console.error(err));
      if (resolution.submittedBy !== interaction.user.id) {
        dmUser(client, resolution.submittedBy, `✏️ Your resolution **${resolution.number}** was edited by an admin.`);
      }
      if (wasReturnedForRevision) {
        postToReviewChannels(client, resolution, config).catch((err) => console.error(err));
      }
      return;
    }

    // 7) Member clicked Yes/No/Abstain on an amendment voting card
    // Button IDs look like: amendvote_<amendmentId>_<choice>_<number>
    if (interaction.isButton() && interaction.customId.startsWith('amendvote_')) {
      const parts = interaction.customId.split('_');
      const amendmentId = parts[1];
      const choice = parts[2];
      const number = parts.slice(3).join('_');

      const resolution = findResolution(number);
      const amendment = resolution && (resolution.amendments || []).find((a) => a.id === amendmentId);
      const config = getConfig();

      if (!resolution || !amendment || amendment.status !== 'Voting' || !amendment.vote || amendment.vote.closed) {
        return interaction.reply({ content: '❌ This amendment vote is not currently open.', ephemeral: true });
      }

      if (!isAmendmentEligibleVoter(interaction.member, resolution, config)) {
        return interaction.reply({ content: '❌ You are not eligible to vote on this amendment.', ephemeral: true });
      }

      const alreadyVoted = amendment.vote.ballots[interaction.user.id];
      if (alreadyVoted && !config.allowVoteChanges) {
        return interaction.reply({ content: `You have already voted (${alreadyVoted.choice}). Vote changes are not allowed.`, ephemeral: true });
      }

      const weight = getVoteWeight(interaction.member, config);
      amendment.vote.ballots[interaction.user.id] = { choice, weight, votedAt: Date.now() };
      upsertResolution(resolution);

      await interaction.reply({
        content: alreadyVoted ? `✅ Your vote has been updated to **${choice}**.` : `✅ Your vote (**${choice}**) has been recorded.`,
        ephemeral: true,
      });

      refreshAmendmentMessage(client, resolution, amendment).catch((err) => console.error('Failed to refresh amendment message:', err));
      logAudit(client, 'Amendment Vote Cast', `${interaction.user.tag} voted on amendment ${amendment.id} of ${resolution.number}.`, resolution.body).catch((err) => console.error(err));
      return;
    }

    // 4) Member clicked Yes/No/Abstain/Veto on a voting card
    // Button IDs look like: vote_<body>_<choice>_<number>  e.g. vote_SC_yes_UNGA/2026/001
    if (interaction.isButton() && interaction.customId.startsWith('vote_')) {
      const parts = interaction.customId.split('_');
      const body = parts[1]; // 'GA', 'SC', or 'OVERRIDE'
      const choice = parts[2]; // 'yes', 'no', 'abstain', or 'veto'
      const number = parts.slice(3).join('_');

      const resolution = findResolution(number);
      const config = getConfig();

      const track = resolution && resolution.tracks && resolution.tracks[body];
      if (!resolution || !track || track.closed) {
        return interaction.reply({ content: '❌ This vote is not currently open.', ephemeral: true });
      }

      // --- Veto button ---
      if (choice === 'veto') {
        if (!isSCPermanentMember(interaction.member, config)) {
          return interaction.reply({ content: '❌ Only Permanent Security Council Members may cast a veto.', ephemeral: true });
        }
        await interaction.reply({ content: `🚫 You have cast a veto on **${resolution.number}**.`, ephemeral: true });
        castVeto(client, resolution, interaction.member, null).catch((err) => console.error('Failed to process veto:', err));
        return;
      }

      // --- Yes / No / Abstain ---
      const eligible = body === 'SC' ? isSCMember(interaction.member, config) : isEligibleVoter(interaction.member, config);
      if (!eligible) {
        return interaction.reply({ content: '❌ You are not eligible to vote in this track.', ephemeral: true });
      }

      const alreadyVoted = track.ballots[interaction.user.id];
      if (alreadyVoted && !config.allowVoteChanges) {
        return interaction.reply({ content: `You have already voted (${alreadyVoted.choice}). Vote changes are not allowed.`, ephemeral: true });
      }

      const weight = getVoteWeight(interaction.member, config);
      track.ballots[interaction.user.id] = { choice, weight, votedAt: Date.now() };
      upsertResolution(resolution);

      // Reply to the user immediately (Discord requires a response within
      // 3 seconds) - the slower follow-up work happens after, and can't
      // crash the bot even if it fails, since it's wrapped in .catch().
      await interaction.reply({
        content: alreadyVoted ? `✅ Your vote has been updated to **${choice}**.` : `✅ Your vote (**${choice}**) has been recorded.`,
        ephemeral: true,
      });

      refreshTrackMessage(client, resolution, body).catch((err) => console.error('Failed to refresh vote message:', err));
      logAudit(client, 'Vote Cast', `${interaction.user.tag} voted on ${resolution.number} (${track.label}).`, body === 'OVERRIDE' ? 'GA' : body).catch((err) => console.error('Failed to write audit log:', err));
      return;
    }

    // 8) Member cast a secret ballot in an election
    // Select menu ID looks like: electvote_<election number>
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('electvote_')) {
      const number = decodeURIComponent(interaction.customId.replace('electvote_', ''));
      const election = findElection(number);
      const config = getConfig();

      if (!election || election.status !== 'Voting') {
        return interaction.reply({ content: '❌ Voting is not currently open for this election.', ephemeral: true });
      }

      if (!isEligibleElectionVoter(interaction.member, election)) {
        return interaction.reply({ content: '❌ You are not eligible to vote in this election.', ephemeral: true });
      }

      const candidateId = interaction.values[0];
      const alreadyVoted = election.ballots[interaction.user.id];
      if (alreadyVoted && !config.elections.allowVoteChanges) {
        return interaction.reply({ content: 'You have already cast your ballot. Vote changes are not allowed in this election.', ephemeral: true });
      }

      castBallot(election, interaction.user.id, candidateId);

      // Reply immediately (Discord requires a response within 3 seconds).
      // This confirmation is ephemeral, so only the voter themselves ever
      // sees their own choice - nobody else, including admins, can see it.
      await interaction.reply({
        content: alreadyVoted ? '✅ Your vote has been updated.' : '✅ Your secret ballot has been recorded.',
        ephemeral: true,
      });

      refreshElectionMessage(client, election).catch((err) => console.error('Failed to refresh election message:', err));
      logAudit(client, 'Election Vote Cast', `${interaction.user.tag} cast a ballot in ${election.number}.`).catch((err) => console.error('Failed to write audit log:', err));
      return;
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const errorMessage = '⚠️ Something went wrong handling that. Check the bot logs.';
    try {
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: errorMessage });
      } else if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (e) {
      console.error('Failed to notify user of error:', e);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
