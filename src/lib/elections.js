// elections.js
// Core election lifecycle: create -> Registration -> Campaign -> Voting ->
// Certified. Candidates register (or get nominated by an admin), get
// approved, and are voted on with a single secret, equally-weighted ballot
// per member. If nobody reaches the configured majority threshold (and
// runoffs are enabled), the bot automatically opens a runoff between the
// top candidates. Ties are resolved according to the configured
// tie-break procedure: another runoff, a random draw, or manual admin
// decision.
//
// IMPORTANT: individual ballots (who voted for whom) are never exposed by
// any function here - not in audit logs, not in DMs, not in any embed.
// Only aggregate counts are ever surfaced.

const { getConfig } = require('./config');
const { upsertElection } = require('./electionsData');
const { nextElectionNumber } = require('./numbering');
const { electionEmbed, electionVotingEmbed, buildElectionVoteMenu } = require('./electionEmbeds');
const { logAudit, notify, dmUser } = require('./audit');
const { getMentionPrefix } = require('./mentions');

const REFERENDUM_TYPES = ['Referendum', 'Recall Vote', 'Confidence Vote'];

function isReferendumType(type) {
  return REFERENDUM_TYPES.includes(type);
}

let candidateSeq = 0;
function nextCandidateId(election) {
  const existingIds = new Set((election.candidates || []).map((c) => c.id));
  let id;
  do {
    candidateSeq += 1;
    id = `C${election.candidates.length + candidateSeq}`;
  } while (existingIds.has(id));
  return id;
}

// --- Creation -----------------------------------------------------------

function createElection(client, { title, type, description, createdBy, createdByTag, registrationDays, campaignDays, votingDays, requiredRole, minMembershipDays, requireAdminApproval, sanctionRoleId, options }) {
  const config = getConfig();
  const now = Date.now();
  const referendum = isReferendumType(type);

  // Referendum-style elections never need registration or a campaign
  // period - there's nobody to register, and (per how alliances actually
  // use these) no need to wait around before voting can start.
  const effectiveRegistrationDays = referendum ? 0 : registrationDays;
  const effectiveCampaignDays = referendum ? 0 : campaignDays;

  const registrationClosesAt = now + effectiveRegistrationDays * 86400000;
  const campaignEndsAt = registrationClosesAt + effectiveCampaignDays * 86400000;
  const votingEndsAt = campaignEndsAt + votingDays * 86400000;

  const election = {
    number: nextElectionNumber(config),
    title,
    type,
    description: description || '',
    status: 'Registration',
    createdBy,
    createdByTag,
    createdAt: now,
    schedule: { registrationOpensAt: now, registrationClosesAt, campaignEndsAt, votingEndsAt },
    eligibility: {
      requiredRole: requiredRole || null,
      minMembershipDays: minMembershipDays || 0,
      requireAdminApproval: !!requireAdminApproval,
      sanctionRoleId: sanctionRoleId || null,
    },
    candidates: [],
    voterRole: config.elections.voterRole,
    eligibleCount: 0,
    ballots: {},
    results: null,
    winner: null,
    tieCandidateIds: null,
    tieNote: null,
    channelId: null,
    messageId: null,
    runoffOf: null,
    runoffChildNumber: null,
    archivedAt: null,
  };

  if (referendum) {
    // A plain Referendum can use custom options (e.g. "Soundtrack A,
    // Soundtrack B, Soundtrack C") instead of Yes/No - Recall Vote and
    // Confidence Vote stay fixed to Yes/No, since those are inherently
    // binary decisions.
    let optionLabels = ['Yes', 'No'];
    if (type === 'Referendum' && options) {
      const custom = options
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 24); // leave room for the automatic Abstain option in the vote menu
      if (custom.length >= 2) optionLabels = custom;
    }

    election.candidates = optionLabels.map((label, i) => ({
      id: `C${i + 1}`,
      userId: null,
      label,
      tag: null,
      status: 'Approved',
      registeredAt: now,
      nominatedBy: null,
    }));

    // No registration or campaign to wait through - go straight to voting.
    election.schedule.registrationClosesAt = now;
    election.schedule.campaignEndsAt = now;
    election.status = 'Voting';
  }

  upsertElection(election);
  return election;
}

// --- Candidates -----------------------------------------------------------

function checkEligibility(election, member) {
  const e = election.eligibility;
  if (e.requiredRole && !member.roles.cache.has(e.requiredRole)) {
    return 'You do not have the role required to run in this election.';
  }
  if (e.sanctionRoleId && member.roles.cache.has(e.sanctionRoleId)) {
    return 'You are currently under a disciplinary sanction that makes you ineligible to run.';
  }
  if (e.minMembershipDays > 0 && member.joinedAt) {
    const daysInServer = (Date.now() - member.joinedAt.getTime()) / 86400000;
    if (daysInServer < e.minMembershipDays) {
      return `You must have been a member for at least ${e.minMembershipDays} day(s) to run. You've been here for ${Math.floor(daysInServer)}.`;
    }
  }
  return null;
}

// A candidate's registered Discord username is often not how members
// actually recognize them (nicknames, IRL names, alliance handles). Up to
// 100 characters to match Discord's select-menu option label limit.
const MAX_KNOWN_AS_LENGTH = 100;

function normalizeKnownAs(knownAs) {
  if (!knownAs) return null;
  const trimmed = knownAs.trim();
  return trimmed ? trimmed.slice(0, MAX_KNOWN_AS_LENGTH) : null;
}

function registerCandidate(election, member, knownAs) {
  if (election.candidates.some((c) => c.userId === member.id && c.status !== 'Withdrawn' && c.status !== 'Rejected')) {
    return { error: 'You are already registered as a candidate in this election.' };
  }
  const ineligible = checkEligibility(election, member);
  if (ineligible) return { error: ineligible };

  const candidate = {
    id: nextCandidateId(election),
    userId: member.id,
    label: null,
    tag: member.user.tag,
    knownAs: normalizeKnownAs(knownAs),
    status: election.eligibility.requireAdminApproval ? 'Pending' : 'Approved',
    registeredAt: Date.now(),
    nominatedBy: null,
  };
  election.candidates.push(candidate);
  upsertElection(election);
  return { candidate };
}

function nominateCandidate(election, targetMember, nominatorId, knownAs) {
  if (election.candidates.some((c) => c.userId === targetMember.id && c.status !== 'Withdrawn' && c.status !== 'Rejected')) {
    return { error: 'That member is already registered as a candidate in this election.' };
  }
  const candidate = {
    id: nextCandidateId(election),
    userId: targetMember.id,
    label: null,
    tag: targetMember.user.tag,
    knownAs: normalizeKnownAs(knownAs),
    status: 'Approved', // An admin nomination is itself the approval.
    registeredAt: Date.now(),
    nominatedBy: nominatorId,
  };
  election.candidates.push(candidate);
  upsertElection(election);
  return { candidate };
}

// Lets a candidate register or change the recognizable name shown in the
// voting dropdown (see electionEmbeds.js's candidateName()) - either at
// registration time, or any time after, right up until voting closes.
// Admins can set this on behalf of any candidate (e.g. one they nominated).
function setCandidateKnownAs(election, candidateId, knownAs) {
  const candidate = election.candidates.find((c) => c.id === candidateId);
  if (!candidate) return { error: 'No candidate found with that ID.' };
  if (!candidate.userId) return { error: 'This option/candidate is not tied to a member and cannot have a "known as" name.' };
  if (election.status === 'Certified' || election.status === 'Cancelled') {
    return { error: `This election has already ended (status: ${election.status}).` };
  }
  candidate.knownAs = normalizeKnownAs(knownAs);
  upsertElection(election);
  return { candidate };
}

// --- Voter eligibility ----------------------------------------------------

async function getElectionEligibleCount(client, election) {
  const { getEligibleCount, getGuildMembers } = require('./voting');
  if (election.voterRole && election.voterRole.length) {
    return getEligibleCount(client, election.voterRole);
  }
  const members = await getGuildMembers(client);
  if (!members) return 0;
  return members.filter((m) => !m.user.bot).size;
}

function isEligibleElectionVoter(member, election) {
  if (election.voterRole && election.voterRole.length) {
    return election.voterRole.some((id) => member.roles.cache.has(id));
  }
  return !member.user.bot;
}

// --- Opening / closing phases ----------------------------------------------

async function openCampaign(client, election) {
  election.status = 'Campaign';
  upsertElection(election);

  const config = getConfig();
  const channelId = config.elections.channels.announcements;
  const mention = getMentionPrefix(config, 'GA');
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel
        .send({ content: `${mention}📣 Candidate registration has closed for **${election.number}** — campaigning is now open.`, embeds: [electionEmbed(election, config)] })
        .catch((err) => console.error('Failed to post campaign announcement:', err));
    }
  }
  await logAudit(client, 'Election Campaign Opened', `**${election.number}** — ${election.title}`);
  return election;
}

async function openElectionVoting(client, election) {
  const config = getConfig();
  election.status = 'Voting';
  election.eligibleCount = await getElectionEligibleCount(client, election);

  const channelId = config.elections.channels.voting;
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      const mention = getMentionPrefix(config, 'GA');
      const embed = electionVotingEmbed(election, config);
      const components = buildElectionVoteMenu(election, false);
      const message = await channel.send({ content: mention || undefined, embeds: [embed], components });
      election.messageId = message.id;
      election.channelId = channel.id;
    }
  }

  upsertElection(election);
  await logAudit(client, 'Election Voting Opened', `**${election.number}** — ${election.title}`);
  await notify(client, `🗳️ Voting is now open for **${election.number}** — ${election.title}`, 'GA');
  return election;
}

async function refreshElectionMessage(client, election) {
  if (!election.channelId || !election.messageId) return;
  const config = getConfig();
  const channel = await client.channels.fetch(election.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(election.messageId).catch(() => null);
  if (!message) return;

  const closed = election.status === 'Certified' || election.status === 'Cancelled';
  const embed = electionVotingEmbed(election, config);
  const components = buildElectionVoteMenu(election, closed);
  await message.edit({ embeds: [embed], components }).catch((err) => console.error('Failed to refresh election message:', err));
}

function castBallot(election, userId, candidateId) {
  election.ballots[userId] = { candidateId, votedAt: Date.now() };
  upsertElection(election);
}

function tallyElection(election) {
  const ballots = Object.values(election.ballots || {});
  const counts = {};
  for (const c of election.candidates) counts[c.id] = 0;
  let abstain = 0;

  for (const b of ballots) {
    if (b.candidateId === 'abstain') abstain += 1;
    else if (counts[b.candidateId] !== undefined) counts[b.candidateId] += 1;
  }

  const votesCast = ballots.length;
  const participation = election.eligibleCount > 0 ? (votesCast / election.eligibleCount) * 100 : 0;
  return { counts, abstain, votesCast, participation };
}

// Figures out the outcome of a tally: a clear winner, a tie, or "no
// majority" (only relevant when decisionMode is 'majority').
function determineOutcome(election, tally, config) {
  const approved = election.candidates.filter((c) => c.status === 'Approved');
  const decisiveVotes = approved.reduce((sum, c) => sum + tally.counts[c.id], 0);

  if (decisiveVotes === 0) return { outcome: 'no-votes' };

  let max = -1;
  let leaders = [];
  for (const c of approved) {
    const count = tally.counts[c.id];
    if (count > max) {
      max = count;
      leaders = [c.id];
    } else if (count === max) {
      leaders.push(c.id);
    }
  }

  if (leaders.length > 1) return { outcome: 'tie', tieCandidateIds: leaders };

  if (config.elections.decisionMode === 'majority') {
    const share = (max / decisiveVotes) * 100;
    if (share < config.elections.majorityThresholdPercent) {
      return { outcome: 'no-majority', leaderId: leaders[0] };
    }
  }

  return { outcome: 'winner', winnerId: leaders[0] };
}

function topTwoCandidateIds(election, tally) {
  const approved = election.candidates.filter((c) => c.status === 'Approved');
  const sorted = [...approved].sort((a, b) => tally.counts[b.id] - tally.counts[a.id]);
  return sorted.slice(0, 2).map((c) => c.id);
}

async function createRunoff(client, parentElection, candidateIds) {
  const config = getConfig();
  const now = Date.now();
  const votingDays = config.elections.runoffVotingDays;

  const runoff = {
    number: nextElectionNumber(config),
    title: `${parentElection.title} (Runoff)`,
    type: 'Runoff Election',
    description: `Runoff for ${parentElection.number}.`,
    status: 'Voting',
    createdBy: parentElection.createdBy,
    createdByTag: parentElection.createdByTag,
    createdAt: now,
    schedule: { registrationOpensAt: now, registrationClosesAt: now, campaignEndsAt: now, votingEndsAt: now + votingDays * 86400000 },
    eligibility: { ...parentElection.eligibility },
    candidates: parentElection.candidates
      .filter((c) => candidateIds.includes(c.id))
      .map((c) => ({ ...c, status: 'Approved' })),
    voterRole: parentElection.voterRole,
    eligibleCount: 0,
    ballots: {},
    results: null,
    winner: null,
    tieCandidateIds: null,
    tieNote: null,
    channelId: null,
    messageId: null,
    runoffOf: parentElection.number,
    runoffChildNumber: null,
    archivedAt: null,
  };

  parentElection.runoffChildNumber = runoff.number;
  upsertElection(parentElection);
  upsertElection(runoff);

  await openElectionVoting(client, runoff);
  await logAudit(client, 'Runoff Election Created', `**${runoff.number}** created as a runoff of **${parentElection.number}**.`);
  await notify(client, `🗳️ A runoff election has opened: **${runoff.number}** (following **${parentElection.number}**).`, 'GA');
  return runoff;
}

async function certify(client, election, tally, winnerId, note) {
  election.status = 'Certified';
  election.results = { ...tally.counts, abstain: tally.abstain };
  election.winner = winnerId || null;
  if (note) election.tieNote = note;
  election.archivedAt = Date.now();
  upsertElection(election);

  await refreshElectionMessage(client, election);

  const config = getConfig();
  const archiveChannelId = config.elections.channels.archive;
  if (archiveChannelId) {
    const channel = await client.channels.fetch(archiveChannelId).catch(() => null);
    if (channel) await channel.send({ embeds: [electionEmbed(election, config)] }).catch((err) => console.error(err));
  }

  const winnerCandidate = election.candidates.find((c) => c.id === winnerId);
  const winnerDesc = winnerCandidate ? (winnerCandidate.userId ? winnerCandidate.tag : winnerCandidate.label) : 'unresolved';

  await logAudit(client, 'Election Certified', `**${election.number}** — Winner: ${winnerDesc}`);
  await notify(client, `🏆 **${election.number}** has been certified. Winner: **${winnerDesc}**.`, 'GA');

  // Let every candidate know the outcome, without ever revealing anyone's
  // individual vote.
  for (const c of election.candidates.filter((cand) => cand.status === 'Approved' && cand.userId)) {
    const didWin = c.id === winnerId;
    dmUser(client, c.userId, didWin ? `🏆 You won **${election.number}** — ${election.title}!` : `📜 **${election.number}** — ${election.title} has been certified. The winner was ${winnerDesc}.`);
  }

  return election;
}

// Closes voting on an election: tallies ballots, and either certifies a
// winner, opens a runoff, or (for ties, depending on config) resolves via
// random draw or hands off to an admin.
async function closeElectionVoting(client, election) {
  const config = getConfig();
  const tally = tallyElection(election);
  const outcome = determineOutcome(election, tally, config);

  if (outcome.outcome === 'no-votes') {
    return certify(client, election, tally, null, 'No votes were cast.');
  }

  if (outcome.outcome === 'winner') {
    return certify(client, election, tally, outcome.winnerId);
  }

  if (outcome.outcome === 'tie') {
    if (config.elections.tieBreak === 'random') {
      const winnerId = outcome.tieCandidateIds[Math.floor(Math.random() * outcome.tieCandidateIds.length)];
      return certify(client, election, tally, winnerId, 'Tied - resolved by random draw as configured.');
    }
    if (config.elections.tieBreak === 'runoff' && election.type !== 'Runoff Election') {
      election.status = 'Certified';
      election.results = { ...tally.counts, abstain: tally.abstain };
      election.winner = 'tie';
      election.tieCandidateIds = outcome.tieCandidateIds;
      election.tieNote = 'Tied - a runoff election has been opened between the tied candidates.';
      election.archivedAt = Date.now();
      upsertElection(election);
      await refreshElectionMessage(client, election);
      await createRunoff(client, election, outcome.tieCandidateIds);
      return election;
    }
    // 'manual', or a runoff that itself tied - needs an admin to decide.
    election.status = 'Tied - Awaiting Manual Resolution';
    election.tieCandidateIds = outcome.tieCandidateIds;
    upsertElection(election);
    await refreshElectionMessage(client, election);
    await logAudit(client, 'Election Tied', `**${election.number}** tied between: ${outcome.tieCandidateIds.join(', ')}. Awaiting manual resolution.`);
    await notify(client, `⚖️ **${election.number}** ended in a tie and needs an admin to declare a winner with \`/election declare-winner\`.`, 'GA');
    return election;
  }

  // 'no-majority'
  if (config.elections.runoffEnabled && election.type !== 'Runoff Election') {
    const top2 = topTwoCandidateIds(election, tally);
    election.status = 'Certified';
    election.results = { ...tally.counts, abstain: tally.abstain };
    election.winner = null;
    election.tieNote = 'No candidate reached the required majority - a runoff election has been opened between the top two.';
    election.archivedAt = Date.now();
    upsertElection(election);
    await refreshElectionMessage(client, election);
    await createRunoff(client, election, top2);
    return election;
  }

  // Runoffs disabled (or this already IS a runoff) - fall back to
  // whoever got the most votes (plurality), same as real first-past-the-
  // post systems do when a runoff isn't available.
  return certify(client, election, tally, outcome.leaderId, 'No candidate reached the required majority; certified by plurality (runoffs disabled).');
}

// Admin manually resolves a tie.
async function declareWinner(client, election, winnerId) {
  const tally = tallyElection(election);
  return certify(client, election, tally, winnerId, 'Tied - resolved manually by an administrator.');
}

module.exports = {
  REFERENDUM_TYPES,
  isReferendumType,
  createElection,
  checkEligibility,
  registerCandidate,
  nominateCandidate,
  setCandidateKnownAs,
  getElectionEligibleCount,
  isEligibleElectionVoter,
  openCampaign,
  openElectionVoting,
  refreshElectionMessage,
  castBallot,
  tallyElection,
  closeElectionVoting,
  declareWinner,
};
