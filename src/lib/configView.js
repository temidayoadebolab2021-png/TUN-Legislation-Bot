// configView.js
// Turns the raw config.json into a friendly, categorized display for
// /config view. Role and channel settings are shown as clickable mentions
// instead of raw numeric IDs, durations are shown in human units (days /
// hours / minutes), and settings are grouped the way an admin actually
// thinks about them rather than however they happen to be nested in the
// file. A dropdown lets you switch between categories, same pattern as
// /help.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { DIVIDER, BLANK } = require('./embeds');

const CATEGORIES = ['General Assembly', 'Security Council', 'Amendments & Announcements', 'Elections', 'Resolution Numbering'];

function roleList(ids) {
  if (!ids || ids.length === 0) return '*Not set*';
  return ids.map((id) => `<@&${id}>`).join(', ');
}

function channelMention(id) {
  return id ? `<#${id}>` : '*Not set*';
}

function toggle(value) {
  return value ? '✅ On' : '❌ Off';
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '0 minutes';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.round(minutes % 60);
  const parts = [];
  if (days) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (mins) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : '0 minutes';
}

function voteWeightsList(weights) {
  const entries = Object.entries(weights || {});
  if (entries.length === 0) return '*Default — everyone gets 1 vote*';
  return entries.map(([roleId, weight]) => `<@&${roleId}> — **${weight}** vote${weight === 1 ? '' : 's'}`).join('\n');
}

function mentionTargetLabel(target) {
  if (!target || target.mentionType === 'none') return '*Nobody*';
  if (target.mentionType === 'everyone') return '@everyone';
  if (target.mentionType === 'role' && target.roleId) return `<@&${target.roleId}>`;
  return '*Nobody*';
}

function buildGeneralAssemblyEmbed(config) {
  return new EmbedBuilder()
    .setAuthor({ name: 'BOT CONFIGURATION · GENERAL ASSEMBLY' })
    .setColor(0x2f6fa3)
    .addFields(
      {
        name: 'ROLES',
        value: [
          `Admin: ${roleList(config.roles.admin)}`,
          `Voter: ${roleList(config.roles.gaVoter)}`,
          `Reviewer: ${roleList(config.roles.gaReviewer)}`,
          `Sponsor Eligible: ${config.roles.sponsorEligible && config.roles.sponsorEligible.length ? roleList(config.roles.sponsorEligible) : '*Anyone*'}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'CHANNELS',
        value: [
          `Review: ${channelMention(config.channels.review)}`,
          `Debate: ${channelMention(config.channels.debate)}`,
          `Voting: ${channelMention(config.channels.voting)}`,
          `Archive: ${channelMention(config.channels.archive)}`,
          `Audit Log: ${channelMention(config.channels.audit)}`,
          `Notifications: ${channelMention(config.channels.notifications)}`,
        ].join('\n'),
        inline: false,
      },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'QUORUM', value: `${config.quorumPercent}%`, inline: true },
      { name: 'MAJORITY', value: `${config.majorityPercent}%`, inline: true },
      { name: 'SUPERMAJORITY', value: `${config.supermajorityPercent}%`, inline: true },
      { name: 'DEBATE DURATION', value: formatDuration(config.debateDurationMinutes), inline: true },
      { name: 'VOTING DURATION', value: formatDuration(config.votingDurationMinutes), inline: true },
      { name: 'SPONSORS REQUIRED', value: `${config.sponsorsRequired}`, inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'VOTE WEIGHTS', value: voteWeightsList(config.voteWeights), inline: false },
      { name: BLANK, value: DIVIDER, inline: false },
      {
        name: 'TOGGLES',
        value: [
          `Allow Vote Changes: ${toggle(config.allowVoteChanges)}`,
          `Public Voting: ${toggle(config.publicVoting)}${config.publicVoting ? '' : ' *(anonymous — Yes/No/Abstain breakdown hidden)*'}`,
          `Live Results During Vote: ${toggle(config.liveResultsDuringVote)}`,
          `DM Notifications to Proposer: ${toggle(config.dmNotifications)}`,
          `Max Active Resolutions Per Member: ${config.maxActiveResolutionsPerMember > 0 ? config.maxActiveResolutionsPerMember : '*Unlimited*'}`,
          `Voting Reminders: ${toggle(config.reminders.enabled)}${config.reminders.enabled ? ` (every ${config.reminders.intervalHours}h)` : ''}`,
        ].join('\n'),
        inline: false,
      }
    );
}

function buildSecurityCouncilEmbed(config) {
  const sc = config.securityCouncil;
  return new EmbedBuilder()
    .setAuthor({ name: 'BOT CONFIGURATION · SECURITY COUNCIL' })
    .setColor(0x6c3fa3)
    .addFields(
      {
        name: 'ROLES',
        value: [
          `Member: ${roleList(sc.roles.member)}`,
          `Permanent Member: ${roleList(sc.roles.permanentMember)}`,
          `Reviewer: ${roleList(sc.roles.reviewer)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'CHANNELS  (fully separate from General Assembly)',
        value: [
          `Review: ${channelMention(sc.channels.review)}`,
          `Debate: ${channelMention(sc.channels.debate)}`,
          `Voting: ${channelMention(sc.channels.voting)}`,
          `Archive: ${channelMention(sc.channels.archive)}`,
          `Audit Log: ${channelMention(sc.channels.audit)}`,
          `Notifications: ${channelMention(sc.channels.notifications)}`,
        ].join('\n'),
        inline: false,
      },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'QUORUM', value: `${sc.quorumPercent}%`, inline: true },
      { name: 'MAJORITY', value: `${sc.majorityPercent}%`, inline: true },
      { name: 'SUPERMAJORITY', value: `${sc.supermajorityPercent}%`, inline: true },
      { name: 'DEBATE DURATION', value: formatDuration(sc.debateDurationMinutes), inline: true },
      { name: 'VOTING DURATION', value: formatDuration(sc.votingDurationMinutes), inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      {
        name: '🚫 VETO SETTINGS',
        value: [
          `Enabled: ${toggle(sc.veto.enabled)}`,
          `Immediately Ends Vote: ${toggle(sc.veto.immediatelyTerminates)}`,
          `Allow Override: ${toggle(sc.veto.allowOverride)}`,
          `Override Threshold: ${sc.veto.overrideThresholdPercent}%`,
          `Override Voting Duration: ${formatDuration(sc.veto.overrideVotingDurationMinutes)}`,
        ].join('\n'),
        inline: false,
      }
    );
}

function buildAmendmentsAnnouncementsEmbed(config) {
  const a = config.amendments;
  const ann = config.announcements;
  return new EmbedBuilder()
    .setAuthor({ name: 'BOT CONFIGURATION · AMENDMENTS & ANNOUNCEMENTS' })
    .setColor(0xc9972c)
    .addFields(
      {
        name: 'AMENDMENTS',
        value: [
          `Enabled: ${toggle(a.enabled)}`,
          `Quorum: ${a.quorumPercent}%`,
          `Majority: ${a.majorityPercent}%`,
          `Debate Duration: ${formatDuration(a.debateDurationMinutes)}`,
          `Voting Duration: ${formatDuration(a.votingDurationMinutes)}`,
        ].join('\n'),
        inline: false,
      },
      { name: BLANK, value: DIVIDER, inline: false },
      {
        name: 'ANNOUNCEMENT MENTIONS',
        value: [
          `Enabled: ${toggle(ann.mentionsEnabled)}`,
          `General Assembly mentions: ${mentionTargetLabel(ann.ga)}`,
          `Security Council mentions: ${mentionTargetLabel(ann.sc)}`,
        ].join('\n'),
        inline: false,
      }
    );
}

function buildElectionsEmbed(config) {
  const e = config.elections;
  return new EmbedBuilder()
    .setAuthor({ name: 'BOT CONFIGURATION · ELECTIONS' })
    .setColor(0x9b59b6)
    .addFields(
      {
        name: 'CHANNELS',
        value: [
          `Announcements: ${channelMention(e.channels.announcements)}`,
          `Voting: ${channelMention(e.channels.voting)}`,
          `Archive: ${channelMention(e.channels.archive)}`,
        ].join('\n'),
        inline: false,
      },
      { name: 'VOTER ROLE', value: e.voterRole && e.voterRole.length ? roleList(e.voterRole) : '*Everyone (excluding bots)*', inline: false },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'DEFAULT REGISTRATION', value: `${e.defaultRegistrationDays} day(s)`, inline: true },
      { name: 'DEFAULT CAMPAIGN', value: `${e.defaultCampaignDays} day(s)`, inline: true },
      { name: 'DEFAULT VOTING', value: `${e.defaultVotingDays} day(s)`, inline: true },
      { name: 'DECISION MODE', value: e.decisionMode === 'majority' ? `Majority (${e.majorityThresholdPercent}% threshold)` : 'Plurality', inline: true },
      { name: 'QUORUM', value: e.quorumPercent > 0 ? `${e.quorumPercent}%` : '*None required*', inline: true },
      { name: 'VOTE CHANGES', value: toggle(e.allowVoteChanges), inline: true },
      { name: 'LIVE RESULTS', value: toggle(e.liveResults), inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      {
        name: 'RUNOFFS & TIE-BREAKING',
        value: [`Runoffs Enabled: ${toggle(e.runoffEnabled)}`, `Runoff Voting Duration: ${e.runoffVotingDays} day(s)`, `Tie-Break Method: **${e.tieBreak}**`].join('\n'),
        inline: false,
      },
      { name: BLANK, value: DIVIDER, inline: false },
      {
        name: 'DEFAULT CANDIDATE ELIGIBILITY',
        value: [
          `Required Role: ${e.eligibility.requiredRole && e.eligibility.requiredRole.length ? roleList(e.eligibility.requiredRole) : '*None*'}`,
          `Sanction Role (disqualifies): ${e.eligibility.sanctionRole && e.eligibility.sanctionRole.length ? roleList(e.eligibility.sanctionRole) : '*None*'}`,
          `Minimum Membership: ${e.eligibility.minMembershipDays > 0 ? `${e.eligibility.minMembershipDays} day(s)` : '*None*'}`,
          `Requires Admin Approval: ${toggle(e.eligibility.requireAdminApproval)}`,
        ].join('\n'),
        inline: false,
      }
    );
}

function buildNumberingEmbed(config) {
  const n = config.resolutionNumbering;
  const example = n.format.replace('{prefix}', n.prefix).replace('{year}', String(new Date().getFullYear())).replace('{seq}', '001');
  return new EmbedBuilder()
    .setAuthor({ name: 'BOT CONFIGURATION · RESOLUTION NUMBERING' })
    .setColor(0x3d4451)
    .addFields(
      { name: 'PREFIX', value: n.prefix, inline: true },
      { name: 'FORMAT', value: `\`${n.format}\``, inline: true },
      { name: 'RESET YEARLY', value: toggle(n.resetYearly), inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'EXAMPLE', value: example, inline: false }
    );
}

function buildConfigViewEmbed(config, category) {
  if (category === 'Security Council') return buildSecurityCouncilEmbed(config);
  if (category === 'Amendments & Announcements') return buildAmendmentsAnnouncementsEmbed(config);
  if (category === 'Elections') return buildElectionsEmbed(config);
  if (category === 'Resolution Numbering') return buildNumberingEmbed(config);
  return buildGeneralAssemblyEmbed(config);
}

function buildConfigViewComponents(activeCategory) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('configview_select')
    .setPlaceholder('Jump to a settings category...')
    .addOptions(CATEGORIES.map((name) => ({ label: name, value: name, default: name === activeCategory })));

  return [new ActionRowBuilder().addComponents(select)];
}

// One-stop function: builds the embed + dropdown for a category, always
// freshly generated from whatever config currently holds.
function renderConfigView(config, requestedCategory) {
  const activeCategory = CATEGORIES.includes(requestedCategory) ? requestedCategory : CATEGORIES[0];
  const embed = buildConfigViewEmbed(config, activeCategory);
  const components = buildConfigViewComponents(activeCategory);
  return { embed, components };
}

module.exports = { renderConfigView, CATEGORIES };
