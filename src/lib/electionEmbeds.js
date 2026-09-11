// electionEmbeds.js
// Visual cards for the Election module - same "official filing" design
// language as embeds.js (letterhead line, dividers, capitalized section
// labels), kept in their own file since elections have a fairly different
// shape (candidates, phases, secret ballots) from resolutions.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { DIVIDER, BLANK, STATUS_COLORS, STATUS_ICONS, quoteBlock } = require('./embeds');

// Used wherever the FULL candidate list appears (the main election embed,
// /election candidate list, DMs, etc.) - these places render real Discord
// markdown, so a candidate's @mention always pings live and is always shown
// front and center. If the candidate also registered a "known as" name,
// it's appended alongside the mention so members can match the name they
// recognize from the ballot to the actual person being pinged.
function candidateLabel(candidate) {
  if (!candidate.userId) return candidate.label;
  const mention = `<@${candidate.userId}>`;
  return candidate.knownAs ? `${mention} — known as **${candidate.knownAs}**` : mention;
}

// Used ONLY for the voting dropdown (StringSelectMenu options), which
// cannot render @mentions or any other markdown - it's plain text. A raw
// Discord username/tag there is often not how anyone actually recognizes a
// candidate, so this prefers whatever "known as" name the candidate
// registered with, falling back to their username if they didn't set one.
function candidateName(candidate) {
  if (!candidate.userId) return candidate.label;
  return candidate.knownAs || candidate.tag || candidate.userId;
}

// The main reference card for an election - phase, schedule, candidate
// list, and (once certified, or if live results are on) the tally.
function electionEmbed(election, config) {
  const statusIcon = STATUS_ICONS[election.status] || '⚪';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `ELECTIONS · ${election.type.toUpperCase()}` })
    .setTitle(`${election.number} — ${election.title}`)
    .setDescription([election.description ? `*${election.description}*` : '', DIVIDER].filter(Boolean).join('\n'))
    .setColor(STATUS_COLORS[election.status] || 0x2c3e50)
    .addFields(
      { name: 'STATUS', value: `${statusIcon} **${election.status.toUpperCase()}**`, inline: true },
      { name: 'TYPE', value: election.type, inline: true },
      { name: BLANK, value: BLANK, inline: true }
    )
    .setFooter({ text: `Called by ${election.createdByTag}  ·  ${election.number}` })
    .setTimestamp(new Date(election.createdAt));

  const s = election.schedule;
  embed.addFields(
    { name: BLANK, value: DIVIDER, inline: false },
    { name: 'REGISTRATION CLOSES', value: `<t:${Math.floor(s.registrationClosesAt / 1000)}:f>`, inline: true },
    { name: 'VOTING OPENS', value: `<t:${Math.floor(s.campaignEndsAt / 1000)}:f>`, inline: true },
    { name: 'VOTING CLOSES', value: `<t:${Math.floor(s.votingEndsAt / 1000)}:f>`, inline: true }
  );

  const approved = election.candidates.filter((c) => c.status === 'Approved');
  const pending = election.candidates.filter((c) => c.status === 'Pending');

  embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
  if (approved.length) {
    embed.addFields({
      name: `CANDIDATES / OPTIONS (${approved.length})`,
      value: approved.map((c) => `• ${candidateLabel(c)}`).join('\n').slice(0, 1024),
      inline: false,
    });
  } else {
    embed.addFields({ name: 'CANDIDATES / OPTIONS', value: '*None approved yet.*', inline: false });
  }
  if (pending.length) {
    embed.addFields({
      name: `PENDING APPROVAL (${pending.length})`,
      value: pending.map((c) => `• ${candidateLabel(c)}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  // Results: only shown once certified, or during voting if live results
  // are turned on. Otherwise we only ever show aggregate participation,
  // never who voted for whom.
  const showResults = election.status === 'Certified' || (election.status === 'Voting' && config && config.elections.liveResults);
  if (election.results && showResults) {
    embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
    const lines = approved.map((c) => `${candidateLabel(c)} — **${election.results[c.id] ?? 0}** vote${election.results[c.id] === 1 ? '' : 's'}`);
    if (election.results.abstain !== undefined) lines.push(`Abstain — **${election.results.abstain}**`);
    embed.addFields({ name: 'RESULTS', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  if (election.status === 'Certified' && election.winner) {
    const winnerText =
      election.winner === 'tie'
        ? '*Resolved by tie-break procedure - see below.*'
        : `🏆 ${candidateLabel(election.candidates.find((c) => c.id === election.winner) || {})}`;
    embed.addFields({ name: 'WINNER', value: winnerText, inline: false });
  }

  if (election.tieNote) {
    embed.addFields({ name: '📌 OUTCOME NOTE', value: quoteBlock(election.tieNote), inline: false });
  }

  if (election.runoffOf) {
    embed.addFields({ name: 'RUNOFF OF', value: election.runoffOf, inline: true });
  }
  if (election.runoffChildNumber) {
    embed.addFields({ name: 'RUNOFF ELECTION', value: election.runoffChildNumber, inline: true });
  }

  // Attached images/documents, if any. The first image (if there is one)
  // gets shown as a large inline preview; everything else is listed as a
  // clickable link, image or not.
  if (election.attachments && election.attachments.length) {
    embed.addFields({ name: BLANK, value: DIVIDER, inline: false });
    const firstImage = election.attachments.find((a) => (a.contentType || '').startsWith('image/'));
    if (firstImage) embed.setImage(firstImage.url);

    const lines = election.attachments.map((a, i) => {
      const isImage = (a.contentType || '').startsWith('image/');
      const icon = isImage ? '🖼️' : '📄';
      const desc = a.description ? ` — ${a.description}` : '';
      return `${icon} **${i + 1}.** [${a.filename}](${a.url})${desc} — *by ${a.uploadedByTag}*`;
    });
    embed.addFields({ name: `ATTACHMENTS (${election.attachments.length})`, value: lines.join('\n').slice(0, 1024), inline: false });
  }

  return embed;
}

// The interactive voting card - a dropdown of candidates/options plus
// Abstain. Never shows per-candidate tallies unless live results are on;
// always shows aggregate participation so people can see turnout.
function electionVotingEmbed(election, config) {
  const ballots = Object.values(election.ballots || {});
  const votesCast = ballots.length;
  const participation = election.eligibleCount > 0 ? ((votesCast / election.eligibleCount) * 100).toFixed(1) : '0.0';
  const closed = election.status === 'Certified' || election.status === 'Cancelled';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `ELECTIONS · ${election.type.toUpperCase()} · SECRET BALLOT` })
    .setTitle(`${election.number} — ${election.title}`)
    .setDescription(DIVIDER)
    .setColor(closed ? STATUS_COLORS[election.status] || 0x2c3e50 : STATUS_COLORS.Voting)
    .addFields(
      { name: 'STATUS', value: closed ? `${STATUS_ICONS[election.status] || '⚪'} **${election.status.toUpperCase()}**` : '🟣 **VOTING OPEN**', inline: true },
      { name: 'CLOSES', value: `<t:${Math.floor(election.schedule.votingEndsAt / 1000)}:R>`, inline: true },
      { name: 'BALLOT TYPE', value: 'Secret · Equal Weight', inline: true },
      { name: BLANK, value: DIVIDER, inline: false },
      { name: 'ELIGIBLE', value: `${election.eligibleCount}`, inline: true },
      { name: 'CAST', value: `${votesCast}`, inline: true },
      { name: 'PARTICIPATION', value: `${participation}%`, inline: true }
    );

  const showResults = election.status === 'Certified' || (election.status === 'Voting' && config && config.elections.liveResults);
  if (election.results && showResults) {
    const approved = election.candidates.filter((c) => c.status === 'Approved');
    const lines = approved.map((c) => `${candidateLabel(c)} — **${election.results[c.id] ?? 0}**`);
    if (election.results.abstain !== undefined) lines.push(`Abstain — **${election.results.abstain}**`);
    embed.addFields({ name: BLANK, value: DIVIDER, inline: false }, { name: 'RESULTS', value: lines.join('\n').slice(0, 1024), inline: false });
  } else if (!closed) {
    embed.addFields({
      name: BLANK,
      value: '*Individual votes are never visible to anyone, including administrators. Only aggregate turnout is shown until the election closes.*',
      inline: false,
    });
  }

  // Show the first attached image (if any) right on the voting card itself
  // - e.g. album art for a "pick our anthem" referendum - without cluttering
  // the card with the full attachment list (see /election view for that).
  if (election.attachments && election.attachments.length) {
    const firstImage = election.attachments.find((a) => (a.contentType || '').startsWith('image/'));
    if (firstImage) embed.setImage(firstImage.url);
  }

  return embed;
}

function buildElectionVoteMenu(election, disabled = false) {
  const approved = election.candidates.filter((c) => c.status === 'Approved');
  const options = approved.slice(0, 24).map((c) => ({
    label: candidateName(c).slice(0, 100),
    value: c.id,
  }));
  options.push({ label: 'Abstain', value: 'abstain', emoji: '⚪' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`electvote_${encodeURIComponent(election.number)}`)
    .setPlaceholder(disabled ? 'Voting has closed' : 'Cast your secret ballot...')
    .setDisabled(disabled)
    .addOptions(options);

  return [new ActionRowBuilder().addComponents(menu)];
}

module.exports = { electionEmbed, electionVotingEmbed, buildElectionVoteMenu, candidateLabel, candidateName };
