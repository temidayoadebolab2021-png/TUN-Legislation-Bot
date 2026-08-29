// defaultConfig.js
// The full "shape" of config.json with sensible defaults. Used two ways:
//   1. To create a brand-new config.json from scratch (e.g. on a fresh
//      Railway volume that starts completely empty).
//   2. To fill in any settings a saved config.json is missing - so when a
//      future update adds a new setting, existing configs pick it up
//      automatically instead of needing to be hand-edited.
//
// getDefaultConfig() returns a brand-new copy every time it's called, so
// nothing accidentally shares/mutates the same nested objects.
function getDefaultConfig() {
  return {
    roles: {
      admin: [],
      gaVoter: [],
      sponsorEligible: [],
      gaReviewer: [],
    },
    channels: {
      review: '',
      debate: '',
      voting: '',
      archive: '',
      audit: '',
      notifications: '',
    },
    voteWeights: {},
    quorumPercent: 50,
    majorityPercent: 50,
    supermajorityPercent: 66.7,
    debateDurationMinutes: 1440,
    votingDurationMinutes: 1440,
    sponsorsRequired: 2,
    allowVoteChanges: true,
    publicVoting: true,
    liveResultsDuringVote: true,
    dmNotifications: true,
    maxActiveResolutionsPerMember: 1,
    announcements: {
      mentionsEnabled: false,
      ga: { mentionType: 'none', roleId: '' },
      sc: { mentionType: 'none', roleId: '' },
    },
    reminders: {
      enabled: true,
      intervalHours: 24,
    },
    amendments: {
      enabled: true,
      debateDurationMinutes: 360,
      votingDurationMinutes: 360,
      quorumPercent: 50,
      majorityPercent: 50,
    },
    resolutionNumbering: {
      prefix: 'UNGA',
      format: '{prefix}/{year}/{seq}',
      resetYearly: true,
    },
    elections: {
      numbering: {
        prefix: 'ELEC',
        format: '{prefix}/{year}/{seq}',
        resetYearly: true,
      },
      channels: {
        announcements: '',
        voting: '',
        archive: '',
      },
      voterRole: [],
      defaultRegistrationDays: 3,
      defaultCampaignDays: 3,
      defaultVotingDays: 2,
      allowVoteChanges: true,
      liveResults: false,
      decisionMode: 'majority',
      majorityThresholdPercent: 50,
      quorumPercent: 0,
      runoffEnabled: true,
      runoffVotingDays: 2,
      tieBreak: 'runoff',
      eligibility: {
        requiredRole: [],
        minMembershipDays: 0,
        requireAdminApproval: false,
        sanctionRole: [],
      },
    },
    securityCouncil: {
      roles: {
        member: [],
        permanentMember: [],
        reviewer: [],
      },
      channels: {
        review: '',
        debate: '',
        voting: '',
        archive: '',
        audit: '',
        notifications: '',
      },
      quorumPercent: 50,
      majorityPercent: 50,
      supermajorityPercent: 66.7,
      debateDurationMinutes: 1440,
      votingDurationMinutes: 1440,
      veto: {
        enabled: true,
        immediatelyTerminates: true,
        allowOverride: false,
        overrideThresholdPercent: 66.7,
        overrideVotingDurationMinutes: 1440,
      },
    },
  };
}

module.exports = { getDefaultConfig };
