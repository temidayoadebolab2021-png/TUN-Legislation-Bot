// reminders.js
// Periodically (checked every scheduler tick, but only actually sent once
// per configured interval - daily by default) DMs a reminder to any member
// who is eligible to vote on something still open, but hasn't cast a
// ballot yet: a General Assembly or Security Council resolution vote, an
// amendment vote, or an election. Each reminder links straight to the
// voting card message so the person can jump right to it.
//
// Nobody who has already voted is ever reminded - only non-voters, and
// only once per interval (tracked via a `lastReminderAt` timestamp stored
// on the track/amendment-vote/election itself).

const { getConfig } = require('./config');
const { getAllResolutions, upsertResolution } = require('./resolutions');
const { getAllElections, upsertElection } = require('./electionsData');
const { getGuildMembers } = require('./voting');
const { isEligibleElectionVoter } = require('./elections');
const { isEligibleVoter, isSCMember } = require('./permissions');
const { dmUser } = require('./audit');

function messageLink(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function isDue(lastAt, startedAt, intervalHours) {
  const base = lastAt || startedAt || 0;
  return Date.now() - base >= intervalHours * 3600000;
}

async function getGuildId(client) {
  const guild = client.guilds.cache.first();
  return guild ? guild.id : null;
}

async function getEligibleMembers(client, predicate) {
  const members = await getGuildMembers(client);
  if (!members) return [];
  return [...members.values()].filter(predicate);
}

// Reminds non-voters on one resolution track (GA, SC, or a veto OVERRIDE
// track). Returns true if it actually sent reminders (so the caller knows
// to persist the updated lastReminderAt).
async function remindTrack(client, resolution, body, track, config) {
  if (!track || track.closed) return false;
  if (!isDue(track.lastReminderAt, track.startedAt, config.reminders.intervalHours)) return false;

  const predicate = body === 'SC' ? (m) => isSCMember(m, config) : (m) => isEligibleVoter(m, config);
  const eligible = await getEligibleMembers(client, predicate);
  const nonVoters = eligible.filter((m) => !track.ballots[m.id]);

  if (nonVoters.length > 0) {
    const guildId = await getGuildId(client);
    const link = messageLink(guildId, track.channelId, track.messageId);
    const labelText = body === 'OVERRIDE' ? 'the veto override vote on' : `the ${track.label} vote on`;
    const message = `🔔 Reminder: you haven't yet cast your vote in ${labelText} **${resolution.number}** — ${resolution.title}.${
      link ? ` [Jump to the vote](${link})` : ''
    } Voting closes <t:${Math.floor(track.endsAt / 1000)}:R>.`;

    for (const member of nonVoters) {
      dmUser(client, member.id, message);
    }
  }

  track.lastReminderAt = Date.now();
  return true;
}

// Reminds non-voters on one amendment's vote.
async function remindAmendment(client, resolution, amendment, config) {
  if (!amendment.vote || amendment.vote.closed) return false;
  if (!isDue(amendment.vote.lastReminderAt, amendment.vote.startedAt, config.reminders.intervalHours)) return false;

  const predicate = resolution.body === 'SC' ? (m) => isSCMember(m, config) : (m) => isEligibleVoter(m, config);
  const eligible = await getEligibleMembers(client, predicate);
  const nonVoters = eligible.filter((m) => !amendment.vote.ballots[m.id]);

  if (nonVoters.length > 0) {
    const guildId = await getGuildId(client);
    const link = messageLink(guildId, amendment.vote.channelId, amendment.vote.messageId);
    const message = `🔔 Reminder: you haven't voted yet on Amendment **${amendment.id}** to **${resolution.number}**.${
      link ? ` [Jump to the vote](${link})` : ''
    } Voting closes <t:${Math.floor(amendment.vote.endsAt / 1000)}:R>.`;

    for (const member of nonVoters) {
      dmUser(client, member.id, message);
    }
  }

  amendment.vote.lastReminderAt = Date.now();
  return true;
}

// Reminds non-voters on an election still in Voting.
async function remindElection(client, election, config) {
  if (election.status !== 'Voting') return false;
  if (!isDue(election.lastReminderAt, election.schedule && election.schedule.campaignEndsAt, config.reminders.intervalHours)) return false;

  const members = await getGuildMembers(client);
  if (!members) return false;
  const eligible = [...members.values()].filter((m) => isEligibleElectionVoter(m, election));
  const nonVoters = eligible.filter((m) => !election.ballots[m.id]);

  if (nonVoters.length > 0) {
    const guildId = await getGuildId(client);
    const link = messageLink(guildId, election.channelId, election.messageId);
    const message = `🔔 Reminder: you haven't cast your secret ballot yet in **${election.number}** — ${election.title}.${
      link ? ` [Jump to the vote](${link})` : ''
    } Voting closes <t:${Math.floor(election.schedule.votingEndsAt / 1000)}:R>.`;

    for (const member of nonVoters) {
      dmUser(client, member.id, message);
    }
  }

  election.lastReminderAt = Date.now();
  return true;
}

// Called once per scheduler tick. Cheap to call often - each reminder
// function only actually does anything once its own interval has elapsed.
async function runReminders(client) {
  const config = getConfig();
  if (!config.reminders || !config.reminders.enabled) return;

  const resolutions = getAllResolutions();
  for (const resolution of resolutions) {
    let changed = false;

    if (resolution.tracks) {
      for (const body of ['GA', 'SC', 'OVERRIDE']) {
        const track = resolution.tracks[body];
        if (track) {
          const didRemind = await remindTrack(client, resolution, body, track, config);
          changed = changed || didRemind;
        }
      }
    }

    if (resolution.amendments) {
      for (const amendment of resolution.amendments) {
        const didRemind = await remindAmendment(client, resolution, amendment, config);
        changed = changed || didRemind;
      }
    }

    if (changed) upsertResolution(resolution);
  }

  const elections = getAllElections();
  for (const election of elections) {
    const didRemind = await remindElection(client, election, config);
    if (didRemind) upsertElection(election);
  }
}

module.exports = { runReminders };
