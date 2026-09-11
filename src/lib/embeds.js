// embeds.js
// Builds the formatted Discord embed "cards" the bot posts.
//
// Visual language: every embed reads like an official filing rather than a
// generic chat card. Each one opens with a small-caps "letterhead" line
// (setAuthor) naming the body and record type, a bold title + italic
// subtitle, and a heavy horizontal rule before the substantive content.
// Section labels are capitalized (Discord already bolds field names) and
// body text is rendered as an indented quote block, echoing how a printed
// resolution or ballot actually reads. Status is always shown with a color
// dot AND a color-coded embed border, so the outcome is legible even to a
// glance or on a screen reader.

const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('./config');

const DIVIDER = '━'.repeat(28);
const BLANK = '\u200b'; // zero-width space, used as an invisible field name for divider rows

const STATUS_COLORS = {
  Draft: 0x8c98a4,
  'Awaiting Sponsors': 0xc9972c,
  'Under Administrative Review': 0xc9972c,
  'Returned for Revision': 0xb5651d,
  Debate: 0x2f6fa3,
  Voting: 0x6c3fa3,
  'Veto Override Vote': 0x6c3fa3,
  Passed: 0x2e8b57,
  Approved: 0x2e8b57,
  Failed: 0xa33a3a,
  Vetoed: 0xa33a3a,
  Withdrawn: 0x6b7280,
  Expired: 0x6b7280,
  Archived: 0x3d4451,
  Registration: 0xc9972c,
  Campaign: 0x2f6fa3,
  Certified: 0x2e8b57,
  Cancelled: 0xa33a3a,
  'Tied - Awaiting Manual Resolution': 0xb5651d,
};

const STATUS_ICONS = {
  Draft: '⚪',
  'Awaiting Sponsors': '🟡',
  'Under Administrative Review': '🟡',
  'Returned for Revision': '🟠',
  Debate: '🔵',
  Voting: '🟣',
  'Veto Override Vote': '🟣',
  Passed: '🟢',
  Approved: '🟢',
  Failed: '🔴',
  Vetoed: '🔴',
  Withdrawn: '⚪',
  Expired: '⚪',
  Archived: '⚪',
  Registration: '🟡',
  Campaign: '🔵',
  Certified: '🟢',
  Cancelled: '🔴',
  'Tied - Awaiting Manual Resolution': '🟠',
};

const AMENDMENT_TYPE_LABELS = {
  add: 'Add Text',
  remove: 'Remove Text',
  replace: 'Replace Text',
  format: 'Correct Formatting',
  reference: 'Correct References',
};

// Whether to reveal the Yes/No/Abstain breakdown (raw and weighted counts)
// anywhere at all - during voting or after it closes. When this is off,
// only aggregate participation and the final outcome are ever shown, which
// matters most for small bodies like the Security Council: with only a
// couple of Permanent Members holding distinct vote weights, even a
// post-close "weighted No: 3" can be enough to deduce exactly who cast it.
// Turning Public Voting off (and leaving Live Results off) hides the
// breakdown completely, at every stage, closing that inference gap.
function shouldShowVoteBreakdown() {
  const config = getConfig();
  return !!(config.publicVoting || config.liveResultsDuringVote);
}

function bodyLabel(body) {
  if (body === 'Both') return 'General Assembly + Security Council';
  if (body === 'SC') return 'Security Council';
  return 'General Assembly';
}

function letterhead(body, recordType) {
  const seal = body === 'SC' ? 'SECURITY COUNCIL' : body === 'Both' ? 'JOINT SESSION' : 'GENERAL ASSEMBLY';
  return `${seal}  ·  ${recordType}`;
}

// Wraps body text as an indented quote block, the way a filed document's
// clauses read - each line prefixed with "> " - and keeps it under
// Discord's 1024-character field value limit.
function quoteBlock(text, limit = 950) {
  const clean = (text ?? '').toString().trim();
  if (!clean) return '> —';
  const truncated = clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
  return truncated
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function resolutionEmbed(resolution) {
  const statusIcon = STATUS_ICONS[resolution.status] || '⚪';
  const subtitle = resolution.subcategory ? `${resolution.templateName} — ${resolution.subcategory}` : resolution.templateName;

  const embed = new EmbedBuilder()
    .setAuthor({ name: letterhead(resolution.body, 'OFFICIAL RECORD') })
    .setTitle(`RESOLUTION ${resolution.number}`)
    .setDescription([`**${resolution.title}**`, `*${subtitle}*`, DIVIDER].join('\n'))
    .setColor(STATUS_COLORS[resolution.status] || 0x2c3e50)
    .addFields(
      { name: 'STATUS', value: `${statusIcon} **${resolution.status.toUpperCase()}**`, inline: true },
      { name: 'BODY', value: bodyLabel(resolution.body), inline: true },
      { name: 'SPONSORS', value: resolution.sponsors.length ? resolution.sponsors.map((s) => `<@${s}>`).join(', ') : '*None yet*', inline: true },
      { name: BLANK, value: DIVIDER, inline: false }
    )
    .setFooter({ text: `Filed by ${resolution.submittedByTag}  ·  ${resolution.number}` })
    .setTimestamp(new Date(resolution.createdAt));

  for (const [fieldName, value] of Object.entries(resolution.fields)) {
    embed.addFields({ name: fieldName.toUpperCase(), value: quoteBlock(value), inline: false });
  }

  // If this resolution went through voting, show each body's result as its
  // own clearly separated section.
  if (resolution.tracks) {
    const closedTracks = Object.entries(resolution.tracks).filter(([, track]) => track.closed);
    if (closedTracks.length) {
      const showBreakdown = shouldShowVoteBreakdown();
      embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
      for (const [, track] of closedTracks) {
        const icon = STATUS_ICONS[track.result] || '⚪';
        let value = `${icon} **${(track.result || '').toUpperCase()}**`;
        if (track.tally) {
          value += showBreakdown
            ? `\nFor **${track.tally.weightedYes}** (${track.tally.forPercent.toFixed(1)}%)  ·  Against **${track.tally.weightedNo}** (${track.tally.againstPercent.toFixed(1)}%)  ·  Abstain **${track.tally.weightedAbstain}** (${track.tally.abstainPercent.toFixed(1)}%)\nParticipation **${track.tally.participation.toFixed(1)}%**`
            : `\nParticipation **${track.tally.participation.toFixed(1)}%** *(anonymous vote - breakdown not disclosed)*`;
        }
        embed.addFields({ name: `${track.label.toUpperCase()} — VOTE RESULT`, value, inline: false });
      }
    }
  }

  // Veto details, if this resolution was vetoed.
  const scTrack = resolution.tracks && resolution.tracks.SC;
  if (scTrack && scTrack.vetoedBy) {
    embed.addFields({
      name: '🚫 VETOED',
      value: `By <@${scTrack.vetoedBy.id}>  ·  <t:${Math.floor(scTrack.vetoedBy.timestamp / 1000)}:f>\n${quoteBlock(scTrack.vetoedBy.reason || 'No reason given.')}`,
      inline: false,
    });
  }
  if (resolution.overrideNote) {
    embed.addFields({ name: '⚖️ VETO OVERRIDE', value: resolution.overrideNote, inline: false });
  }

  // Amendment history, if any amendments were proposed on this resolution.
  if (resolution.amendments && resolution.amendments.length) {
    embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
    const lines = resolution.amendments.map((a) => {
      const label = AMENDMENT_TYPE_LABELS[a.type] || a.type;
      const icon = STATUS_ICONS[a.status] || '⚪';
      const note = a.appliedNote ? ` — _${a.appliedNote}_` : '';
      return `${icon} **${a.id}** — ${label} → *${a.targetField}* — **${a.status}**${note}`;
    });
    embed.addFields({ name: 'AMENDMENT HISTORY', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  // Attached images/documents, if any. The first image (if there is one)
  // gets shown as a large inline preview; everything else is listed as a
  // clickable link, image or not.
  if (resolution.attachments && resolution.attachments.length) {
    embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
    const firstImage = resolution.attachments.find((a) => (a.contentType || '').startsWith('image/'));
    if (firstImage) embed.setImage(firstImage.url);

    const lines = resolution.attachments.map((a, i) => {
      const isImage = (a.contentType || '').startsWith('image/');
      const icon = isImage ? '🖼️' : '📄';
      const desc = a.description ? ` — ${a.description}` : '';
      return `${icon} **${i + 1}.** [${a.filename}](${a.url})${desc} — *by ${a.uploadedByTag}*`;
    });
    embed.addFields({ name: `ATTACHMENTS (${resolution.attachments.length})`, value: lines.join('\n').slice(0, 1024), inline: false });
  }

  return embed;
}

// Renders the interactive voting card for ONE track (body) of a resolution,
// e.g. the General Assembly vote or the Security Council vote.
function trackEmbed(resolution, body, track) {
  const ballots = Object.values(track.ballots || {});
  const yes = ballots.filter((v) => v.choice === 'yes');
  const no = ballots.filter((v) => v.choice === 'no');
  const abstain = ballots.filter((v) => v.choice === 'abstain');

  const rawYes = yes.length;
  const rawNo = no.length;
  const rawAbstain = abstain.length;
  const weightedYes = yes.reduce((s, v) => s + v.weight, 0);
  const weightedNo = no.reduce((s, v) => s + v.weight, 0);
  const weightedAbstain = abstain.reduce((s, v) => s + v.weight, 0);
  const totalWeight = weightedYes + weightedNo + weightedAbstain;
  const yesPercent = totalWeight > 0 ? ((weightedYes / totalWeight) * 100).toFixed(1) : '0.0';
  const noPercent = totalWeight > 0 ? ((weightedNo / totalWeight) * 100).toFixed(1) : '0.0';
  const abstainPercent = totalWeight > 0 ? ((weightedAbstain / totalWeight) * 100).toFixed(1) : '0.0';

  const votesCast = ballots.length;
  const participation = track.eligibleCount > 0 ? ((votesCast / track.eligibleCount) * 100).toFixed(1) : '0.0';
  const recordType = body === 'OVERRIDE' ? 'VETO OVERRIDE BALLOT' : 'OFFICIAL BALLOT';
  const statusLabel = track.closed ? `${STATUS_ICONS[track.result] || '⚪'} **CLOSED — ${(track.result || '').toUpperCase()}**` : '🟣 **VOTING OPEN**';
  const showBreakdown = shouldShowVoteBreakdown();

  const embed = new EmbedBuilder()
    .setAuthor({ name: letterhead(body === 'OVERRIDE' ? 'GA' : body, recordType) })
    .setTitle(resolution.number)
    .setDescription([`**${resolution.title}**`, DIVIDER].join('\n'))
    .setColor(track.closed ? STATUS_COLORS[track.result] || 0x2c3e50 : STATUS_COLORS.Voting)
    .addFields(
      { name: 'STATUS', value: statusLabel, inline: true },
      {
        name: 'RULE',
        value: `${track.requiresSupermajority ? 'Supermajority' : 'Simple Majority'} **${track.thresholdPercent}%**\nQuorum **${track.quorumPercent}%**`,
        inline: true,
      },
      { name: 'CLOSES', value: `<t:${Math.floor(track.endsAt / 1000)}:R>`, inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'ELIGIBLE', value: `${track.eligibleCount}`, inline: true },
      { name: 'CAST', value: `${votesCast}`, inline: true },
      { name: 'PARTICIPATION', value: `${participation}%`, inline: true }
    );

  if (showBreakdown) {
    embed.addFields(
      { name: '✅ YES', value: `${rawYes} raw  ·  **${weightedYes}** weighted  ·  **${yesPercent}%**`, inline: false },
      { name: '❌ NO', value: `${rawNo} raw  ·  **${weightedNo}** weighted  ·  **${noPercent}%**`, inline: false },
      { name: '⚪ ABSTAIN', value: `${rawAbstain} raw  ·  **${weightedAbstain}** weighted  ·  **${abstainPercent}%**`, inline: false }
    );
  } else {
    embed.addFields({
      name: BLANK,
      value: '*This is an anonymous vote — individual choices and the Yes/No/Abstain breakdown are never disclosed, only aggregate turnout and the final result.*',
      inline: false,
    });
  }

  if (track.vetoEnabled) {
    embed.addFields({ name: '🚫 VETO POWER', value: 'Permanent Security Council Members may veto using the button below.', inline: false });
  }
  if (track.vetoedBy) {
    embed.addFields({ name: '🚫 VETOED BY', value: `<@${track.vetoedBy.id}>${track.vetoedBy.reason ? ` — ${track.vetoedBy.reason}` : ''}`, inline: false });
  }

  return embed;
}

// Renders the interactive voting card for a single amendment.
function amendmentEmbed(resolution, amendment) {
  const vote = amendment.vote;
  const ballots = Object.values((vote && vote.ballots) || {});
  const yes = ballots.filter((v) => v.choice === 'yes');
  const no = ballots.filter((v) => v.choice === 'no');
  const abstain = ballots.filter((v) => v.choice === 'abstain');
  const weightedYes = yes.reduce((s, v) => s + v.weight, 0);
  const weightedNo = no.reduce((s, v) => s + v.weight, 0);
  const weightedAbstain = abstain.reduce((s, v) => s + v.weight, 0);
  const totalWeight = weightedYes + weightedNo + weightedAbstain;
  const yesPercent = totalWeight > 0 ? ((weightedYes / totalWeight) * 100).toFixed(1) : '0.0';
  const noPercent = totalWeight > 0 ? ((weightedNo / totalWeight) * 100).toFixed(1) : '0.0';
  const abstainPercent = totalWeight > 0 ? ((weightedAbstain / totalWeight) * 100).toFixed(1) : '0.0';
  const votesCast = ballots.length;
  const eligibleCount = vote ? vote.eligibleCount : 0;
  const participation = eligibleCount > 0 ? ((votesCast / eligibleCount) * 100).toFixed(1) : '0.0';
  const closed = vote ? vote.closed : false;
  const statusLabel = closed ? `${STATUS_ICONS[amendment.status] || '⚪'} **CLOSED — ${amendment.status.toUpperCase()}**` : `🔵 **${amendment.status.toUpperCase()}**`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: letterhead(resolution.body, `PROPOSED AMENDMENT · ${(AMENDMENT_TYPE_LABELS[amendment.type] || amendment.type).toUpperCase()}`) })
    .setTitle(`Amendment ${amendment.id} to ${resolution.number}`)
    .setDescription(DIVIDER)
    .setColor(closed ? STATUS_COLORS[amendment.status] || 0x2c3e50 : STATUS_COLORS.Debate)
    .addFields(
      { name: 'TARGET FIELD', value: amendment.targetField, inline: true },
      { name: 'SPONSOR', value: `<@${amendment.sponsor}>`, inline: true },
      { name: 'STATUS', value: statusLabel, inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'ORIGINAL TEXT', value: quoteBlock(amendment.originalText), inline: false },
      { name: 'NEW TEXT', value: quoteBlock(amendment.newText), inline: false }
    );

  if (vote) {
    const showBreakdown = shouldShowVoteBreakdown();
    embed.addFields(
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'CLOSES', value: `<t:${Math.floor(vote.endsAt / 1000)}:R>`, inline: true },
      { name: 'ELIGIBLE', value: `${eligibleCount}`, inline: true },
      { name: 'PARTICIPATION', value: `${participation}%`, inline: true }
    );
    if (showBreakdown) {
      embed.addFields(
        { name: '✅ YES', value: `**${weightedYes}** weighted (**${yesPercent}%**)`, inline: true },
        { name: '❌ NO', value: `**${weightedNo}** weighted (**${noPercent}%**)`, inline: true },
        { name: '⚪ ABSTAIN', value: `**${weightedAbstain}** weighted (**${abstainPercent}%**)`, inline: true }
      );
    }
  }

  return embed;
}

module.exports = { resolutionEmbed, trackEmbed, amendmentEmbed, DIVIDER, BLANK, STATUS_COLORS, STATUS_ICONS, quoteBlock };
