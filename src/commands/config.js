// /config command
// This is the heart of "nothing is hardcoded". Admins use this to set
// roles, channels, quorum %, majority %, durations, vote weights, etc.

const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { getConfig, setValue, getValue, setFullConfig } = require('../lib/config');
const { readJSON, writeJSON } = require('../lib/storage');
const { isAdmin } = require('../lib/permissions');
const { renderConfigView } = require('../lib/configView');
const { logAudit } = require('../lib/audit');

const ROLE_KEY_CHOICES = [
  { name: 'Admin', value: 'roles.admin' },
  { name: 'General Assembly Voter', value: 'roles.gaVoter' },
  { name: 'General Assembly Reviewer (e.g. GA President)', value: 'roles.gaReviewer' },
  { name: 'Sponsor Eligible', value: 'roles.sponsorEligible' },
  { name: 'Security Council Member', value: 'securityCouncil.roles.member' },
  { name: 'Security Council Permanent Member', value: 'securityCouncil.roles.permanentMember' },
  { name: 'Security Council Reviewer (e.g. UNSC Chair)', value: 'securityCouncil.roles.reviewer' },
  { name: 'Election Voter (blank = everyone)', value: 'elections.voterRole' },
  { name: 'Election Candidate Required Role', value: 'elections.eligibility.requiredRole' },
  { name: 'Election Sanction Role (disqualifies candidates)', value: 'elections.eligibility.sanctionRole' },
];

// Role settings can hold multiple roles (e.g. two different Admin roles).
// This always returns the current list as an array, even if an older config
// still has a single role ID saved as a plain string.
function getRoleArray(key) {
  const value = getValue(key);
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  category: 'Administration',
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View or change TUN bot configuration (admin only)')
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('Show the current configuration')
    )
    .addSubcommand((sub) =>
      sub.setName('backup').setDescription('Download a full backup: settings, templates, resolutions, elections, and numbering')
    )
    .addSubcommand((sub) =>
      sub
        .setName('restore')
        .setDescription('Restore from backup file(s) created by /config backup - attach only what you want to restore')
        .addAttachmentOption((opt) => opt.setName('config_file').setDescription('Settings backup (config.json)').setRequired(false))
        .addAttachmentOption((opt) => opt.setName('templates_file').setDescription('Templates backup (templates.json)').setRequired(false))
        .addAttachmentOption((opt) => opt.setName('resolutions_file').setDescription('Resolutions archive backup (resolutions.json)').setRequired(false))
        .addAttachmentOption((opt) => opt.setName('elections_file').setDescription('Elections backup (elections.json)').setRequired(false))
        .addAttachmentOption((opt) => opt.setName('counters_file').setDescription('Numbering counters backup (counters.json)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-role')
        .setDescription('Add a role to a role setting (settings can hold more than one role)')
        .addStringOption((opt) => opt.setName('key').setDescription('Which role setting to add to').setRequired(true).addChoices(...ROLE_KEY_CHOICES))
        .addRoleOption((opt) => opt.setName('role').setDescription('The Discord role to add').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-role')
        .setDescription('Remove a role from a role setting')
        .addStringOption((opt) => opt.setName('key').setDescription('Which role setting to remove from').setRequired(true).addChoices(...ROLE_KEY_CHOICES))
        .addRoleOption((opt) => opt.setName('role').setDescription('The Discord role to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list-roles')
        .setDescription('Show every role currently assigned to a role setting')
        .addStringOption((opt) => opt.setName('key').setDescription('Which role setting to view').setRequired(true).addChoices(...ROLE_KEY_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-channel')
        .setDescription('Set a channel used by the bot')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Which channel to set')
            .setRequired(true)
            .addChoices(
              { name: 'Review', value: 'channels.review' },
              { name: 'Debate', value: 'channels.debate' },
              { name: 'Voting', value: 'channels.voting' },
              { name: 'Archive', value: 'channels.archive' },
              { name: 'Audit Log', value: 'channels.audit' },
              { name: 'Notifications', value: 'channels.notifications' },
              { name: 'Security Council Review', value: 'securityCouncil.channels.review' },
              { name: 'Security Council Debate', value: 'securityCouncil.channels.debate' },
              { name: 'Security Council Voting', value: 'securityCouncil.channels.voting' },
              { name: 'Security Council Archive', value: 'securityCouncil.channels.archive' },
              { name: 'Security Council Notifications', value: 'securityCouncil.channels.notifications' },
              { name: 'Security Council Audit Log', value: 'securityCouncil.channels.audit' },
              { name: 'Election Announcements', value: 'elections.channels.announcements' },
              { name: 'Election Voting', value: 'elections.channels.voting' },
              { name: 'Election Archive', value: 'elections.channels.archive' }
            )
        )
        .addChannelOption((opt) => opt.setName('channel').setDescription('The Discord channel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-number')
        .setDescription('Set a numeric setting (percentages, durations, sponsor count)')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Which setting to change')
            .setRequired(true)
            .addChoices(
              { name: 'Quorum %', value: 'quorumPercent' },
              { name: 'Majority %', value: 'majorityPercent' },
              { name: 'Supermajority %', value: 'supermajorityPercent' },
              { name: 'Debate duration (minutes)', value: 'debateDurationMinutes' },
              { name: 'Voting duration (minutes)', value: 'votingDurationMinutes' },
              { name: 'Sponsors required', value: 'sponsorsRequired' },
              { name: 'Max Active Resolutions Per Member (0 = unlimited)', value: 'maxActiveResolutionsPerMember' },
              { name: 'SC Quorum %', value: 'securityCouncil.quorumPercent' },
              { name: 'SC Majority %', value: 'securityCouncil.majorityPercent' },
              { name: 'SC Supermajority %', value: 'securityCouncil.supermajorityPercent' },
              { name: 'SC Debate duration (minutes)', value: 'securityCouncil.debateDurationMinutes' },
              { name: 'SC Voting duration (minutes)', value: 'securityCouncil.votingDurationMinutes' },
              { name: 'Veto Override Threshold %', value: 'securityCouncil.veto.overrideThresholdPercent' },
              { name: 'Veto Override Voting duration (minutes)', value: 'securityCouncil.veto.overrideVotingDurationMinutes' },
              { name: 'Amendment Quorum %', value: 'amendments.quorumPercent' },
              { name: 'Amendment Majority %', value: 'amendments.majorityPercent' },
              { name: 'Amendment Debate duration (minutes)', value: 'amendments.debateDurationMinutes' },
              { name: 'Amendment Voting duration (minutes)', value: 'amendments.votingDurationMinutes' },
              { name: 'Voting Reminder Interval (hours)', value: 'reminders.intervalHours' }
            )
        )
        .addNumberOption((opt) => opt.setName('value').setDescription('New numeric value').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-election-number')
        .setDescription('Set an election-related numeric setting')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Which election setting to change')
            .setRequired(true)
            .addChoices(
              { name: 'Election Default Registration Days', value: 'elections.defaultRegistrationDays' },
              { name: 'Election Default Campaign Days', value: 'elections.defaultCampaignDays' },
              { name: 'Election Default Voting Days', value: 'elections.defaultVotingDays' },
              { name: 'Election Majority Threshold %', value: 'elections.majorityThresholdPercent' },
              { name: 'Election Quorum %', value: 'elections.quorumPercent' },
              { name: 'Election Runoff Voting Days', value: 'elections.runoffVotingDays' },
              { name: 'Election Min Membership Days (default)', value: 'elections.eligibility.minMembershipDays' }
            )
        )
        .addNumberOption((opt) => opt.setName('value').setDescription('New numeric value').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-toggle')
        .setDescription('Turn a yes/no setting on or off')
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Which setting to change')
            .setRequired(true)
            .addChoices(
              { name: 'Allow vote changes', value: 'allowVoteChanges' },
              { name: 'Public Voting (off = anonymous, hides Yes/No/Abstain breakdown)', value: 'publicVoting' },
              { name: 'Live Results During Vote (shows breakdown live even if not Public)', value: 'liveResultsDuringVote' },
              { name: 'DM Notifications to Proposer', value: 'dmNotifications' },
              { name: 'Veto Enabled', value: 'securityCouncil.veto.enabled' },
              { name: 'Veto Immediately Ends Vote', value: 'securityCouncil.veto.immediatelyTerminates' },
              { name: 'Allow Veto Override', value: 'securityCouncil.veto.allowOverride' },
              { name: 'Amendments Enabled', value: 'amendments.enabled' },
              { name: 'Announcement Mentions Enabled', value: 'announcements.mentionsEnabled' },
              { name: 'Voting Reminders Enabled (DMs non-voters on open votes)', value: 'reminders.enabled' },
              { name: 'Election Vote Changes Allowed', value: 'elections.allowVoteChanges' },
              { name: 'Election Live Results', value: 'elections.liveResults' },
              { name: 'Election Runoff Enabled', value: 'elections.runoffEnabled' },
              { name: 'Election Require Admin Approval (default)', value: 'elections.eligibility.requireAdminApproval' }
            )
        )
        .addBooleanOption((opt) => opt.setName('value').setDescription('On (true) or off (false)').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-weight')
        .setDescription('Set how many votes a role is worth in legislative votes')
        .addRoleOption((opt) => opt.setName('role').setDescription('The role').setRequired(true))
        .addIntegerOption((opt) => opt.setName('weight').setDescription('Vote weight (0 or more)').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('numbering')
        .setDescription('Configure resolution numbering format')
        .addStringOption((opt) => opt.setName('prefix').setDescription('e.g. UNGA').setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName('format')
            .setDescription('Use {prefix} {year} {seq}, e.g. {prefix}/{year}/{seq}')
            .setRequired(true)
        )
        .addBooleanOption((opt) => opt.setName('reset_yearly').setDescription('Restart numbering each year?').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-announcement-mention')
        .setDescription('Choose who gets pinged on important announcements for a body')
        .addStringOption((opt) =>
          opt
            .setName('body')
            .setDescription('Which body this applies to')
            .setRequired(true)
            .addChoices({ name: 'General Assembly', value: 'GA' }, { name: 'Security Council', value: 'SC' })
        )
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Who to mention')
            .setRequired(true)
            .addChoices(
              { name: 'None (no mention)', value: 'none' },
              { name: '@everyone', value: 'everyone' },
              { name: 'A specific role', value: 'role' }
            )
        )
        .addRoleOption((opt) => opt.setName('role').setDescription('The role to mention (only needed if type is "A specific role")').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-election-decision-mode')
        .setDescription('How an election decides a winner')
        .addStringOption((opt) =>
          opt
            .setName('mode')
            .setDescription('Majority requires a % threshold (else runoff); Plurality is just most votes')
            .setRequired(true)
            .addChoices({ name: 'Majority (with runoff if nobody reaches the threshold)', value: 'majority' }, { name: 'Plurality (most votes wins outright)', value: 'plurality' })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-election-tiebreak')
        .setDescription('How a tied election gets resolved')
        .addStringOption((opt) =>
          opt
            .setName('method')
            .setDescription('What happens when candidates are tied for first place')
            .setRequired(true)
            .addChoices(
              { name: 'Runoff (new vote between the tied candidates)', value: 'runoff' },
              { name: 'Random Draw (bot picks randomly, announced transparently)', value: 'random' },
              { name: 'Manual (admin decides with /election declare-winner)', value: 'manual' }
            )
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const config = getConfig();

    if (!isAdmin(interaction.member, config)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const { embed, components } = renderConfigView(config, null);
      return interaction.reply({ embeds: [embed], components, ephemeral: true });
    }

    if (sub === 'backup') {
      const today = new Date().toISOString().slice(0, 10);
      const files = [
        { data: config, name: `tun-bot-config-backup-${today}.json` },
        { data: readJSON('templates.json', []), name: `tun-bot-templates-backup-${today}.json` },
        { data: readJSON('resolutions.json', []), name: `tun-bot-resolutions-backup-${today}.json` },
        { data: readJSON('elections.json', []), name: `tun-bot-elections-backup-${today}.json` },
        { data: readJSON('counters.json', {}), name: `tun-bot-counters-backup-${today}.json` },
      ].map(({ data, name }) => new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), { name }));

      return interaction.reply({
        content:
          '📦 Here is a full backup: settings, templates, resolutions archive, elections, and numbering counters. **Download all five files and save them somewhere safe** (your computer, cloud storage, etc.) - if anything is ever lost, restore any of them with `/config restore` (attach only the ones you need).',
        files,
      });
    }

    if (sub === 'restore') {
      const attachmentSpecs = [
        { option: 'config_file', filename: 'config.json', label: 'Settings' },
        { option: 'templates_file', filename: 'templates.json', label: 'Templates' },
        { option: 'resolutions_file', filename: 'resolutions.json', label: 'Resolutions archive' },
        { option: 'elections_file', filename: 'elections.json', label: 'Elections' },
        { option: 'counters_file', filename: 'counters.json', label: 'Numbering counters' },
      ];

      const provided = attachmentSpecs
        .map((spec) => ({ ...spec, attachment: interaction.options.getAttachment(spec.option) }))
        .filter((spec) => spec.attachment);

      if (provided.length === 0) {
        return interaction.reply({
          content: '❌ Attach at least one backup file to restore (e.g. `config_file` for settings, `templates_file` for templates, etc.).',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const restoredLabels = [];
      const failedLabels = [];
      const preRestoreBackups = [];

      for (const spec of provided) {
        try {
          const response = await fetch(spec.attachment.url);
          const text = await response.text();
          const parsed = JSON.parse(text);

          if (spec.filename === 'config.json') {
            if (!parsed.roles || !parsed.channels || !parsed.securityCouncil || !parsed.elections) {
              failedLabels.push(`${spec.label} (doesn't look like a valid settings backup)`);
              continue;
            }
            preRestoreBackups.push(new AttachmentBuilder(Buffer.from(JSON.stringify(config, null, 2), 'utf8'), { name: `pre-restore-config-${Date.now()}.json` }));
            setFullConfig(parsed);
          } else if (spec.filename === 'counters.json') {
            if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
              failedLabels.push(`${spec.label} (expected an object, not a list)`);
              continue;
            }
            preRestoreBackups.push(new AttachmentBuilder(Buffer.from(JSON.stringify(readJSON('counters.json', {}), null, 2), 'utf8'), { name: `pre-restore-counters-${Date.now()}.json` }));
            writeJSON('counters.json', parsed);
          } else {
            if (!Array.isArray(parsed)) {
              failedLabels.push(`${spec.label} (expected a list of records)`);
              continue;
            }
            preRestoreBackups.push(new AttachmentBuilder(Buffer.from(JSON.stringify(readJSON(spec.filename, []), null, 2), 'utf8'), { name: `pre-restore-${spec.filename}` }));
            writeJSON(spec.filename, parsed);
          }
          restoredLabels.push(spec.label);
        } catch (err) {
          console.error(`Failed to restore ${spec.filename}:`, err);
          failedLabels.push(`${spec.label} (couldn't be read - make sure it's valid JSON)`);
        }
      }

      logAudit(interaction.client, 'Configuration/Data Restored', `${restoredLabels.join(', ') || 'Nothing'} restored from uploaded backup(s) by ${interaction.user.tag}.`).catch((err) => console.error(err));

      const summary = [
        restoredLabels.length ? `✅ Restored: ${restoredLabels.join(', ')}.` : null,
        failedLabels.length ? `❌ Skipped: ${failedLabels.join(', ')}.` : null,
        preRestoreBackups.length ? 'For safety, backups of what was just replaced are attached below.' : null,
      ]
        .filter(Boolean)
        .join('\n');

      return interaction.editReply({ content: summary, files: preRestoreBackups });
    }

    if (sub === 'add-role') {
      const key = interaction.options.getString('key');
      const role = interaction.options.getRole('role');
      const current = getRoleArray(key);
      if (current.includes(role.id)) {
        return interaction.reply({ content: `<@&${role.id}> is already set for **${key}**.`, ephemeral: true });
      }
      current.push(role.id);
      setValue(key, current);
      return interaction.reply({
        content: `✅ Added <@&${role.id}> to **${key}**. Current roles: ${current.map((id) => `<@&${id}>`).join(', ')}`,
        ephemeral: true,
      });
    }

    if (sub === 'remove-role') {
      const key = interaction.options.getString('key');
      const role = interaction.options.getRole('role');
      const current = getRoleArray(key);
      if (!current.includes(role.id)) {
        return interaction.reply({ content: `<@&${role.id}> is not currently set for **${key}**.`, ephemeral: true });
      }
      const updated = current.filter((id) => id !== role.id);
      setValue(key, updated);
      return interaction.reply({
        content: `✅ Removed <@&${role.id}> from **${key}**. ${updated.length ? `Remaining roles: ${updated.map((id) => `<@&${id}>`).join(', ')}` : 'No roles remain set for this key.'}`,
        ephemeral: true,
      });
    }

    if (sub === 'list-roles') {
      const key = interaction.options.getString('key');
      const current = getRoleArray(key);
      return interaction.reply({
        content: current.length ? `**${key}**: ${current.map((id) => `<@&${id}>`).join(', ')}` : `**${key}** has no roles set yet. Use \`/config add-role\`.`,
        ephemeral: true,
      });
    }

    if (sub === 'set-channel') {
      const key = interaction.options.getString('key');
      const channel = interaction.options.getChannel('channel');
      setValue(key, channel.id);
      return interaction.reply({ content: `✅ Set **${key}** to <#${channel.id}>.`, ephemeral: true });
    }

    if (sub === 'set-number' || sub === 'set-election-number') {
      const key = interaction.options.getString('key');
      const value = interaction.options.getNumber('value');
      setValue(key, value);
      return interaction.reply({ content: `✅ Set **${key}** to **${value}**.`, ephemeral: true });
    }

    if (sub === 'set-toggle') {
      const key = interaction.options.getString('key');
      const value = interaction.options.getBoolean('value');
      setValue(key, value);
      return interaction.reply({ content: `✅ Set **${key}** to **${value}**.`, ephemeral: true });
    }

    if (sub === 'set-weight') {
      const role = interaction.options.getRole('role');
      const weight = interaction.options.getInteger('weight');
      const updated = getConfig();
      updated.voteWeights[role.id] = weight;
      setValue('voteWeights', updated.voteWeights);
      return interaction.reply({ content: `✅ <@&${role.id}> now has vote weight **${weight}**.`, ephemeral: true });
    }

    if (sub === 'numbering') {
      const prefix = interaction.options.getString('prefix');
      const format = interaction.options.getString('format');
      const resetYearly = interaction.options.getBoolean('reset_yearly');
      setValue('resolutionNumbering', { prefix, format, resetYearly });
      return interaction.reply({ content: `✅ Numbering format updated: \`${format}\``, ephemeral: true });
    }

    if (sub === 'set-announcement-mention') {
      const body = interaction.options.getString('body');
      const type = interaction.options.getString('type');
      const role = interaction.options.getRole('role');

      if (type === 'role' && !role) {
        return interaction.reply({ content: '❌ Please specify a role when type is "A specific role".', ephemeral: true });
      }

      const path = body === 'SC' ? 'announcements.sc' : 'announcements.ga';
      setValue(path, { mentionType: type, roleId: type === 'role' ? role.id : '' });

      const description = type === 'none' ? 'nobody' : type === 'everyone' ? '@everyone' : `<@&${role.id}>`;
      const bodyLabel = body === 'SC' ? 'Security Council' : 'General Assembly';
      const mentionsOffWarning = getConfig().announcements.mentionsEnabled
        ? ''
        : '\n⚠️ Note: "Announcement Mentions Enabled" is currently OFF, so no mention will actually be sent yet - turn it on with `/config set-toggle key:Announcement Mentions Enabled value:True`.';
      return interaction.reply({
        content: `✅ ${bodyLabel} announcements will now mention: ${description}.${mentionsOffWarning}`,
        ephemeral: true,
      });
    }

    if (sub === 'set-election-decision-mode') {
      const mode = interaction.options.getString('mode');
      setValue('elections.decisionMode', mode);
      return interaction.reply({ content: `✅ Elections will now decide winners by **${mode}**.`, ephemeral: true });
    }

    if (sub === 'set-election-tiebreak') {
      const method = interaction.options.getString('method');
      setValue('elections.tieBreak', method);
      return interaction.reply({ content: `✅ Tied elections will now be resolved by **${method}**.`, ephemeral: true });
    }
  },
};
