// voting.js
// Shared logic for opening/closing legislative votes.
//
// A resolution can require a vote in the General Assembly ("GA"), the
// Security Council ("SC"), or Both. Each body is called a "track" - each
// track has its own eligible voters, quorum, majority rule, channel, and
// voting card, and they run independently and simultaneously.
//
// The Security Council track can also carry a veto: Permanent Members can
// click a Veto button, which either ends that vote immediately or simply
// overturns a "Passed" result once voting closes, depending on config.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { getConfig } = require('./config');
const { upsertResolution, findTemplate } = require('./resolutions');
const { trackEmbed, resolutionEmbed } = require('./embeds');
const { logAudit, notify, dmUser } = require('./audit');
const { getMentionPrefix } = require('./mentions');
const { effectiveSettings } = require('./subcategories');

function bodiesFor(resolution) {
  return resolution.body === 'Both' ? ['GA', 'SC'] : [resolution.body || 'GA'];
}

// Everything about HOW a given body votes: which role counts, which channel
// it posts to, and what quorum/majority rule applies. `vetoableOverride`
// lets a sub-category's own vetoable setting win over the template's -
// pass undefined to just use the template's setting (e.g. for OVERRIDE
// votes, which are never vetoable regardless).
function getTrackSettings(body, config, template, vetoableOverride) {
  if (body === 'SC') {
    const sc = config.securityCouncil;
    const vetoable = vetoableOverride === undefined ? template.vetoable !== false : vetoableOverride;
    return {
      label: 'Security Council',
      roleId: sc.roles.member,
      channelId: sc.channels.voting,
      quorumPercent: sc.quorumPercent,
      thresholdPercent: template.requiresSupermajority ? sc.supermajorityPercent : sc.majorityPercent,
      requiresSupermajority: !!template.requiresSupermajority,
      votingDurationMinutes: sc.votingDurationMinutes,
      vetoEnabled: !!(sc.veto.enabled && vetoable),
    };
  }
  if (body === 'OVERRIDE') {
    const sc = config.securityCouncil;
    return {
      label: 'Veto Override Vote (General Assembly)',
      roleId: config.roles.gaVoter,
      channelId: config.channels.voting,
      quorumPercent: config.quorumPercent,
      thresholdPercent: sc.veto.overrideThresholdPercent,
      requiresSupermajority: true,
      votingDurationMinutes: sc.veto.overrideVotingDurationMinutes,
      vetoEnabled: false,
    };
  }
  // Default: GA
  return {
    label: 'General Assembly',
    roleId: config.roles.gaVoter,
    channelId: config.channels.voting,
    quorumPercent: config.quorumPercent,
    thresholdPercent: template.requiresSupermajority ? config.supermajorityPercent : config.majorityPercent,
    requiresSupermajority: !!template.requiresSupermajority,
    votingDurationMinutes: config.votingDurationMinutes,
    vetoEnabled: false,
  };
}

// Used right when a resolution is submitted - decides which review
// channel(s) to post it to, based on which body(s) will vote on it.
function getReviewChannelIds(resolution, config) {
  const bodies = bodiesFor(resolution);
  const channelIds = new Set();
  if (bodies.includes('GA') && config.channels.review) channelIds.add(config.channels.review);
  if (bodies.includes('SC') && config.securityCouncil.channels.review) channelIds.add(config.securityCouncil.channels.review);
  return [...channelIds];
}

// Builds an @mention of whichever reviewer role(s) (GA Reviewer / SC
// Reviewer) apply to this resolution's body, so reviewers are actually
// notified when something lands in their review channel. Returns '' if no
// reviewer role is configured for the relevant body/bodies.
function getReviewerMentions(resolution, config) {
  const bodies = bodiesFor(resolution);
  const mentions = new Set();
  for (const b of bodies) {
    const roles = b === 'SC' ? config.securityCouncil.roles.reviewer : config.roles.gaReviewer;
    (roles || []).forEach((id) => mentions.add(`<@&${id}>`));
  }
  return mentions.size ? `${[...mentions].join(' ')} ` : '';
}

// Posts a resolution to its review channel(s), tagging the appropriate
// reviewer role(s) so reviewers actually get notified. Used both right
// when a resolution needs no sponsors (posted immediately) and once a
// resolution collects enough sponsors (posted at that point instead).
async function postToReviewChannels(client, resolution, config) {
  const channelIds = getReviewChannelIds(resolution, config);
  const mention = getReviewerMentions(resolution, config);

  for (const channelId of channelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel
        .send({ content: `${mention}📋 A resolution is ready for review.`, embeds: [resolutionEmbed(resolution)] })
        .catch((err) => console.error('Failed to post to review channel:', err));
    }
  }
}

// Used when opening debate (see review.js) - decides which debate channel(s)
// to announce in and how long debate should run for, based on which body(s)
// will vote on this resolution.
function getDebateInfo(resolution, config) {
  const bodies = bodiesFor(resolution);
  const channelIds = new Set();
  let durationMinutes = config.debateDurationMinutes;

  if (bodies.includes('GA') && config.channels.debate) channelIds.add(config.channels.debate);
  if (bodies.includes('SC') && config.securityCouncil.channels.debate) channelIds.add(config.securityCouncil.channels.debate);

  if (bodies.length > 1) {
    durationMinutes = Math.max(config.debateDurationMinutes, config.securityCouncil.debateDurationMinutes);
  } else if (bodies[0] === 'SC') {
    durationMinutes = config.securityCouncil.debateDurationMinutes;
  }

  return { channelIds: [...channelIds], durationMinutes };
}

// If the debate channel is a Discord Forum Channel, auto-applies any of
// its existing tags whose name matches this resolution's category,
// sub-category, or body (e.g. a tag literally named "Economic Policy" or
// "Security Council"). Alliances create/name their own forum tags in
// Discord's channel settings - the bot just matches against whatever
// exists, and applies nothing if none match. Discord allows at most 5
// applied tags per post.
function matchForumTags(channel, resolution) {
  if (!channel.availableTags || channel.availableTags.length === 0) return [];

  const candidates = [
    resolution.templateName,
    resolution.subcategory,
    resolution.body === 'SC' ? 'Security Council' : resolution.body === 'Both' ? 'Joint' : 'General Assembly',
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  return channel.availableTags
    .filter((tag) => candidates.includes(tag.name.toLowerCase()))
    .slice(0, 5)
    .map((tag) => tag.id);
}

// Opens debate for a resolution. For each relevant body's debate channel:
// - If it's a Forum Channel, creates a brand-new post (thread) just for
//   this resolution, tagged automatically where a matching forum tag
//   exists, and remembers that thread's ID on the resolution so every
//   later debate-related message (amendments, etc.) lands in the same
//   post instead of the parent channel.
// - If it's an ordinary text channel, posts a regular announcement
//   message instead, exactly like before - no configuration needed
//   either way, the channel type is detected automatically.
async function openDebateChannels(client, resolution, config) {
  const debateInfo = getDebateInfo(resolution, config);
  const mention = getMentionPrefix(config, resolution.body);
  resolution.debateThreads = resolution.debateThreads || {};

  const bodies = bodiesFor(resolution);
  for (const body of bodies) {
    const channelId = body === 'SC' ? config.securityCouncil.channels.debate : config.channels.debate;
    if (!channelId) continue;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;

    const introContent = `${mention}📣 Debate is now open for **${resolution.number}**. Debate closes <t:${Math.floor(resolution.debate.endsAt / 1000)}:R>.`;

    if (channel.type === ChannelType.GuildForum) {
      const appliedTags = matchForumTags(channel, resolution);
      const thread = await channel.threads
        .create({
          name: `${resolution.number} — ${resolution.title}`.slice(0, 100),
          message: { content: introContent, embeds: [resolutionEmbed(resolution)] },
          appliedTags,
        })
        .catch((err) => {
          console.error('Failed to create forum post for debate:', err);
          return null;
        });
      resolution.debateThreads[body] = thread ? thread.id : null;
    } else {
      await channel.send({ content: introContent, embeds: [resolutionEmbed(resolution)] }).catch((err) => console.error('Failed to post to debate channel:', err));
      resolution.debateThreads[body] = null;
    }
  }

  upsertResolution(resolution);
  return debateInfo;
}

// Where should follow-up debate-related messages (amendment proposals,
// amendment votes) actually be posted? If debate opened a forum post for
// a body, use that thread; otherwise fall back to the plain configured
// channel, same as before forum support existed.
function getDebateTargetChannelIds(resolution, config) {
  const bodies = bodiesFor(resolution);
  const ids = new Set();
  for (const b of bodies) {
    const threadId = resolution.debateThreads && resolution.debateThreads[b];
    if (threadId) {
      ids.add(threadId);
      continue;
    }
    const channelId = b === 'SC' ? config.securityCouncil.channels.debate : config.channels.debate;
    if (channelId) ids.add(channelId);
  }
  return [...ids];
}

function buildVoteButtons(number, body, disabled = false, includeVeto = false) {
  const buttons = [
    new ButtonBuilder().setCustomId(`vote_${body}_yes_${number}`).setLabel('Yes').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`vote_${body}_no_${number}`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`vote_${body}_abstain_${number}`).setLabel('Abstain').setEmoji('⚪').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  ];
  if (includeVeto) {
    buttons.push(
      new ButtonBuilder().setCustomId(`vote_${body}_veto_${number}`).setLabel('Veto').setEmoji('🚫').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
  }
  return new ActionRowBuilder().addComponents(buttons);
}

// Fetching the FULL member list from Discord is a "heavy" gateway request
// (opcode 8) that Discord rate-limits. Re-fetching it every time a vote
// opens can trip that limit and, if not handled carefully, leave the bot
// hanging. We cache the result for a few minutes and fall back to whatever
// is already cached if a fresh fetch fails or is rate-limited.
let memberCacheTimestamp = 0;
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getGuildMembers(client) {
  const guild = client.guilds.cache.first();
  if (!guild) return null;

  const isFresh = Date.now() - memberCacheTimestamp < MEMBER_CACHE_TTL_MS;
  if (isFresh && guild.members.cache.size > 0) {
    return guild.members.cache;
  }

  try {
    const fetched = await guild.members.fetch();
    memberCacheTimestamp = Date.now();
    return fetched;
  } catch (err) {
    console.error('Member list fetch failed (likely rate-limited) - using cached member list instead:', err.message);
    return guild.members.cache; // Better an approximate count than a hang or crash.
  }
}

async function getEligibleCount(client, roleIds) {
  const ids = Array.isArray(roleIds) ? roleIds : roleIds ? [roleIds] : [];
  if (ids.length === 0) return 0;
  const members = await getGuildMembers(client);
  if (!members) return 0;
  return members.filter((m) => ids.some((id) => m.roles.cache.has(id))).size;
}

async function refreshTrackMessage(client, resolution, body) {
  const track = resolution.tracks && resolution.tracks[body];
  if (!track || !track.channelId || !track.messageId) return;
  const channel = await client.channels.fetch(track.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(track.messageId).catch(() => null);
  if (!message) return;

  const embed = trackEmbed(resolution, body, track);
  const row = buildVoteButtons(resolution.number, body, track.closed, track.vetoEnabled);
  await message.edit({ embeds: [embed], components: [row] }).catch((err) => console.error('Failed to refresh vote message:', err));
}

async function openTrackVote(client, resolution, body) {
  const config = getConfig();
  const template = findTemplate(resolution.templateName) || {};
  // A sub-category can override its template's vetoable setting - the
  // resolution itself already stored the effective value at creation time
  // (see index.js), so prefer that over re-deriving it from the template
  // alone, which wouldn't know which sub-category this resolution used.
  const vetoableOverride = resolution.vetoable !== undefined ? resolution.vetoable : effectiveSettings(template, resolution.subcategory).vetoable;
  const settings = getTrackSettings(body, config, template, vetoableOverride);
  const eligibleCount = await getEligibleCount(client, settings.roleId);

  const track = {
    label: settings.label,
    ballots: {},
    eligibleCount,
    quorumPercent: settings.quorumPercent,
    thresholdPercent: settings.thresholdPercent,
    requiresSupermajority: settings.requiresSupermajority,
    vetoEnabled: settings.vetoEnabled,
    startedAt: Date.now(),
    endsAt: Date.now() + settings.votingDurationMinutes * 60000,
    closed: false,
    result: null,
    vetoedBy: null,
    channelId: null,
    messageId: null,
  };

  if (settings.channelId) {
    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (channel) {
      const embed = trackEmbed(resolution, body, track);
      const row = buildVoteButtons(resolution.number, body, false, settings.vetoEnabled);
      const mentionPrefix = getMentionPrefix(config, body === 'OVERRIDE' ? 'GA' : body);
      const message = await channel.send({ content: mentionPrefix || undefined, embeds: [embed], components: [row] });
      track.messageId = message.id;
      track.channelId = channel.id;
    }
  }

  resolution.tracks = resolution.tracks || {};
  resolution.tracks[body] = track;
  return track;
}

async function openVoting(client, resolution) {
  const bodies = bodiesFor(resolution);
  resolution.status = 'Voting';

  for (const body of bodies) {
    await openTrackVote(client, resolution, body);
  }

  upsertResolution(resolution);
  await logAudit(client, 'Vote Opened', `**${resolution.number}** — ${resolution.title} (${bodies.join(' + ')})`, resolution.body);
  await notify(client, `🗳️ Voting is now open for **${resolution.number}** — ${resolution.title}`, resolution.body);

  for (const body of bodies) {
    const track = resolution.tracks[body];
    dmUser(
      client,
      resolution.submittedBy,
      `🗳️ Voting has opened for your resolution **${resolution.number}** — ${resolution.title} (${track.label}). It closes <t:${Math.floor(track.endsAt / 1000)}:f>.`
    );
  }

  return resolution;
}

function tallyTrack(track) {
  const ballots = Object.values(track.ballots || {});
  const votesCast = ballots.length;
  const participation = track.eligibleCount > 0 ? (votesCast / track.eligibleCount) * 100 : 0;
  const weightedYes = ballots.filter((v) => v.choice === 'yes').reduce((s, v) => s + v.weight, 0);
  const weightedNo = ballots.filter((v) => v.choice === 'no').reduce((s, v) => s + v.weight, 0);
  const weightedAbstain = ballots.filter((v) => v.choice === 'abstain').reduce((s, v) => s + v.weight, 0);
  const decisive = weightedYes + weightedNo;
  // Share of DECISIVE (Yes+No) votes - what the majority/supermajority
  // threshold is actually measured against.
  const yesShare = decisive > 0 ? (weightedYes / decisive) * 100 : 0;

  // Share of ALL votes cast, including Abstain - i.e. "what percentage of
  // the room voted For / Against / Abstained", which is what people
  // actually want to see on a results card. These three always sum to 100%
  // (barring rounding) whenever at least one vote was cast.
  const totalWeight = weightedYes + weightedNo + weightedAbstain;
  const forPercent = totalWeight > 0 ? (weightedYes / totalWeight) * 100 : 0;
  const againstPercent = totalWeight > 0 ? (weightedNo / totalWeight) * 100 : 0;
  const abstainPercent = totalWeight > 0 ? (weightedAbstain / totalWeight) * 100 : 0;

  return {
    votesCast,
    participation,
    weightedYes,
    weightedNo,
    weightedAbstain,
    yesShare,
    forPercent,
    againstPercent,
    abstainPercent,
  };
}

async function closeTrackVote(client, resolution, body) {
  const track = resolution.tracks[body];
  if (!track || track.closed) return;

  const tally = tallyTrack(track);
  let result;
  if (track.vetoedBy) {
    result = 'Vetoed';
  } else if (tally.participation < track.quorumPercent) {
    result = 'Failed';
  } else if (tally.yesShare >= track.thresholdPercent) {
    result = 'Passed';
  } else {
    result = 'Failed';
  }

  track.closed = true;
  track.result = result;
  track.tally = tally;

  await refreshTrackMessage(client, resolution, body);
}

async function finalizeIfDone(client, resolution) {
  const bodies = bodiesFor(resolution);
  const allClosed = bodies.every((b) => resolution.tracks[b] && resolution.tracks[b].closed);

  if (!allClosed) {
    upsertResolution(resolution);
    return resolution;
  }

  const results = bodies.map((b) => resolution.tracks[b].result);
  let overall;
  if (results.includes('Vetoed')) overall = 'Vetoed';
  else if (results.every((r) => r === 'Passed')) overall = 'Passed';
  else overall = 'Failed';

  resolution.status = overall;
  resolution.archivedAt = Date.now();
  upsertResolution(resolution);

  const config = getConfig();
  const archiveChannelIds = new Set();
  if (bodies.includes('GA') && config.channels.archive) archiveChannelIds.add(config.channels.archive);
  if (bodies.includes('SC') && config.securityCouncil.channels.archive) archiveChannelIds.add(config.securityCouncil.channels.archive);

  for (const channelId of archiveChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [resolutionEmbed(resolution)] }).catch((err) => console.error(err));
  }

  const summary = bodies.map((b) => `${resolution.tracks[b].label}: ${resolution.tracks[b].result}`).join(' | ');
  await logAudit(client, 'Vote Closed', `**${resolution.number}** — Final Result: ${overall}\n${summary}`, resolution.body);
  await notify(client, `📜 Voting has closed for **${resolution.number}** — Result: **${overall}**`, resolution.body);
  dmUser(client, resolution.submittedBy, `📜 Your resolution **${resolution.number}** — ${resolution.title} has closed. Result: **${overall}**.`);

  return resolution;
}

// Closes one specific track (body) if given, otherwise closes every track
// this resolution has open, then certifies the overall outcome once all
// applicable tracks are closed.
async function closeVoting(client, resolution, body = null) {
  const bodies = body ? [body] : bodiesFor(resolution);
  for (const b of bodies) {
    if (resolution.tracks[b] && !resolution.tracks[b].closed) {
      await closeTrackVote(client, resolution, b);
    }
  }
  return finalizeIfDone(client, resolution);
}

// A Permanent Security Council Member clicked the Veto button (or used
// /veto cast).
async function castVeto(client, resolution, member, reason) {
  const config = getConfig();
  const track = resolution.tracks.SC;
  if (!track || track.closed) return;

  track.vetoedBy = {
    id: member.id,
    tag: member.user ? member.user.tag : member.tag,
    reason: reason || null,
    timestamp: Date.now(),
  };

  if (config.securityCouncil.veto.immediatelyTerminates) {
    track.closed = true;
    track.result = 'Vetoed';
    track.tally = tallyTrack(track);
    await refreshTrackMessage(client, resolution, 'SC');

    // If a General Assembly track is still open on the same resolution, a
    // Security Council veto makes it moot - close it without tallying.
    if (resolution.tracks.GA && !resolution.tracks.GA.closed) {
      resolution.tracks.GA.closed = true;
      resolution.tracks.GA.result = 'Moot (Vetoed by Security Council)';
      await refreshTrackMessage(client, resolution, 'GA');
    }

    await finalizeIfDone(client, resolution);
  } else {
    upsertResolution(resolution);
    await refreshTrackMessage(client, resolution, 'SC');
  }

  await logAudit(
    client,
    'Veto Cast',
    `**${resolution.number}** — Vetoed by ${track.vetoedBy.tag}${reason ? `\nReason: ${reason}` : ''}`,
    resolution.body
  );
  await notify(client, `🚫 **${resolution.number}** has been vetoed by a Permanent Security Council Member.`, resolution.body);
  dmUser(client, resolution.submittedBy, `🚫 Your resolution **${resolution.number}** — ${resolution.title} has been vetoed by a Permanent Security Council Member.${reason ? ` Reason: ${reason}` : ''}`);
}

async function openOverrideVote(client, resolution) {
  const config = getConfig();
  if (resolution.status !== 'Vetoed') throw new Error('This resolution is not currently vetoed.');
  if (!config.securityCouncil.veto.allowOverride) throw new Error('Veto overrides are disabled in configuration.');

  resolution.status = 'Veto Override Vote';
  await openTrackVote(client, resolution, 'OVERRIDE');
  upsertResolution(resolution);

  await logAudit(client, 'Veto Override Started', `**${resolution.number}** — override vote opened.`, 'GA');
  await notify(client, `⚖️ A veto override vote has opened for **${resolution.number}**.`, 'GA');
  return resolution;
}

async function closeOverrideVote(client, resolution) {
  await closeTrackVote(client, resolution, 'OVERRIDE');
  const track = resolution.tracks.OVERRIDE;

  if (track.result === 'Passed') {
    resolution.status = 'Passed';
    resolution.overrideNote = 'Veto overridden by Assembly vote.';
  } else {
    resolution.status = 'Vetoed';
    resolution.overrideNote = 'Veto override failed; original veto stands.';
  }
  resolution.archivedAt = Date.now();
  upsertResolution(resolution);

  const config = getConfig();
  if (config.channels.archive) {
    const channel = await client.channels.fetch(config.channels.archive).catch(() => null);
    if (channel) await channel.send({ embeds: [resolutionEmbed(resolution)] }).catch((err) => console.error(err));
  }

  await logAudit(client, 'Veto Override Closed', `**${resolution.number}** — Result: ${resolution.status}`, 'GA');
  await notify(client, `⚖️ Veto override vote closed for **${resolution.number}** — Result: **${resolution.status}**`, 'GA');
  dmUser(client, resolution.submittedBy, `⚖️ The veto override vote on your resolution **${resolution.number}** has closed. Result: **${resolution.status}**.`);
  return resolution;
}

module.exports = {
  bodiesFor,
  getTrackSettings,
  getDebateInfo,
  openDebateChannels,
  getDebateTargetChannelIds,
  getReviewChannelIds,
  getReviewerMentions,
  postToReviewChannels,
  buildVoteButtons,
  getEligibleCount,
  getGuildMembers,
  refreshTrackMessage,
  openVoting,
  closeVoting,
  castVeto,
  openOverrideVote,
  closeOverrideVote,
};
