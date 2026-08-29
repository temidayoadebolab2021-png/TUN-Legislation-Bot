// scheduler.js
// Checks every minute whether any resolution's debate period, amendment
// period(s), or voting period(s) have run out, and automatically advances
// them to the next stage. This works even if the bot restarts, because it
// reads timestamps saved in resolutions.json rather than relying on
// setTimeout.

const { getAllResolutions } = require('./resolutions');
const { openVoting, closeVoting, closeOverrideVote } = require('./voting');
const { openAmendmentVote, closeAmendmentVote, hasOpenAmendments } = require('./amendments');
const { getAllElections } = require('./electionsData');
const { openCampaign, openElectionVoting, closeElectionVoting } = require('./elections');
const { runReminders } = require('./reminders');

function startScheduler(client) {
  setInterval(async () => {
    try {
      const resolutions = getAllResolutions();
      const now = Date.now();

      for (const resolution of resolutions) {
        // Advance any amendments whose debate or voting window has ended,
        // regardless of the resolution's own stage below.
        for (const amendment of resolution.amendments || []) {
          if (amendment.status === 'Debate' && amendment.debate && !amendment.debate.closed && now >= amendment.debate.endsAt) {
            amendment.debate.closed = true;
            await openAmendmentVote(client, resolution, amendment);
          } else if (amendment.status === 'Voting' && amendment.vote && !amendment.vote.closed && now >= amendment.vote.endsAt) {
            await closeAmendmentVote(client, resolution, amendment);
          }
        }

        if (resolution.status === 'Debate' && resolution.debate && !resolution.debate.closed && now >= resolution.debate.endsAt) {
          // Don't open the main vote while an amendment is still being
          // debated or voted on - let the working text finish changing first.
          if (!hasOpenAmendments(resolution)) {
            resolution.debate.closed = true;
            await openVoting(client, resolution);
          }
          continue;
        }

        if (resolution.status === 'Voting' && resolution.tracks) {
          for (const body of ['GA', 'SC']) {
            const track = resolution.tracks[body];
            if (track && !track.closed && now >= track.endsAt) {
              await closeVoting(client, resolution, body);
            }
          }
          continue;
        }

        if (
          resolution.status === 'Veto Override Vote' &&
          resolution.tracks &&
          resolution.tracks.OVERRIDE &&
          !resolution.tracks.OVERRIDE.closed &&
          now >= resolution.tracks.OVERRIDE.endsAt
        ) {
          await closeOverrideVote(client, resolution);
        }
      }

      // Elections progress through Registration -> Campaign -> Voting ->
      // Certified on their own schedule, independent of resolutions.
      const elections = getAllElections();
      for (const election of elections) {
        if (election.status === 'Registration' && now >= election.schedule.registrationClosesAt) {
          await openCampaign(client, election);
        } else if (election.status === 'Campaign' && now >= election.schedule.campaignEndsAt) {
          await openElectionVoting(client, election);
        } else if (election.status === 'Voting' && now >= election.schedule.votingEndsAt) {
          await closeElectionVoting(client, election);
        }
      }

      // DM reminders to anyone who hasn't voted yet on something still
      // open - each reminder function internally checks its own interval,
      // so this is cheap to call every tick.
      await runReminders(client);
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  }, 60 * 1000); // check every 60 seconds
}

module.exports = { startScheduler };
