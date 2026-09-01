// /election command
// Manages the full Election module: calling an election, candidate
// registration/nomination/approval, opening/closing voting, and
// tie/runoff resolution. See src/lib/elections.js for the actual lifecycle
// logic - this file is just the Discord-facing interface to it.

const { SlashCommandBuilder } = require('discord.js');
const { getConfig } = require('../lib/config');
const { isAdmin } = require('../lib/permissions');
const { findElection, getAllElections, upsertElection } = require('../lib/electionsData');
const { electionEmbed } = require('../lib/electionEmbeds');
const { logAudit, dmUser } = require('../lib/audit');
const {
  REFERENDUM_TYPES,
  isReferendumType,
  createElection,
  registerCandidate,
  nominateCandidate,
  openElectionVoting,
  closeElectionVoting,
  declareWinner,
} = require('../lib/elections');

const ELECTION_TYPE_CHOICES = [
  { name: 'General Election', value: 'General Election' },
  { name: 'Leadership Election', value: 'Leadership Election' },
  { name: 'By-election', value: 'By-election' },
  { name: 'Referendum', value: 'Referendum' },
  { name: 'Recall Vote', value: 'Recall Vote' },
  { name: 'Confidence Vote', value: 'Confidence Vote' },
];

module.exports = {
  category: 'Elections',
  data: new SlashCommandBuilder()
    .setName('election')
    .setDescription('Call and manage elections, referendums, and recall votes')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Call a new election (admin only)')
        .addStringOption((o) => o.setName('title').setDescription('e.g. Secretary-General Election').setRequired(true))
        .addStringOption((o) => o.setName('type').setDescription('Type of election').setRequired(true).addChoices(...ELECTION_TYPE_CHOICES))
        .addStringOption((o) => o.setName('description').setDescription('What is this election about?').setRequired(false))
        .addStringOption((o) =>
          o
            .setName('options')
            .setDescription('Referendum only: comma-separated custom choices (e.g. "Soundtrack A,Soundtrack B"). Default: Yes/No.')
            .setRequired(false)
        )
        .addIntegerOption((o) => o.setName('registration_days').setDescription('How many days to accept candidates (ignored for Referendum/Recall/Confidence)').setRequired(false))
        .addIntegerOption((o) => o.setName('campaign_days').setDescription('How many days for campaigning before voting opens').setRequired(false))
        .addIntegerOption((o) => o.setName('voting_days').setDescription('How many days voting stays open').setRequired(false))
        .addRoleOption((o) => o.setName('required_role').setDescription('Role candidates must have to run (optional)').setRequired(false))
        .addIntegerOption((o) => o.setName('min_membership_days').setDescription('Minimum days in the server required to run (optional)').setRequired(false))
        .addBooleanOption((o) => o.setName('require_admin_approval').setDescription('Must an admin approve each candidate? Default: server setting').setRequired(false))
        .addRoleOption((o) => o.setName('sanction_role').setDescription('Role that disqualifies a member from running (optional)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('View an election')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List recent elections')
    )
    .addSubcommand((sub) =>
      sub
        .setName('open-voting')
        .setDescription('Manually open voting for an election (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Manually close voting and certify the result (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel an election at any stage (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('declare-winner')
        .setDescription('Manually resolve a tied election (admin only)')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('candidate_id').setDescription('Which tied candidate wins').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('attach')
        .setDescription('Attach an image or document to an election')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
        .addAttachmentOption((o) => o.setName('file').setDescription('The image or document to attach').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Optional caption/description for this attachment').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-attachment')
        .setDescription('Remove an attachment from an election')
        .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('index').setDescription('Attachment number as shown in /election view (1, 2, 3...)').setRequired(true))
    )
    .addSubcommandGroup((group) =>
      group
        .setName('candidate')
        .setDescription('Manage candidates in an election')
        .addSubcommand((sub) =>
          sub
            .setName('register')
            .setDescription('Register yourself as a candidate')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('nominate')
            .setDescription('Nominate someone as a candidate (admin only)')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
            .addUserOption((o) => o.setName('user').setDescription('Who to nominate').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('approve')
            .setDescription('Approve a pending candidate (admin only)')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName('candidate_id').setDescription('Candidate ID').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('reject')
            .setDescription('Reject a pending candidate (admin only)')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName('candidate_id').setDescription('Candidate ID').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('withdraw')
            .setDescription('Withdraw a candidate (yourself, or admin for anyone)')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName('candidate_id').setDescription('Candidate ID').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('List all candidates in an election')
            .addStringOption((o) => o.setName('number').setDescription('Election number').setRequired(true).setAutocomplete(true))
        )
    ),

  async execute(interaction) {
    const config = getConfig();
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'candidate') {
      return handleCandidateSubcommand(interaction, config, sub);
    }

    if (sub === 'create') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }

      const title = interaction.options.getString('title');
      const type = interaction.options.getString('type');
      const description = interaction.options.getString('description');
      const registrationDays = interaction.options.getInteger('registration_days') ?? config.elections.defaultRegistrationDays;
      const campaignDays = interaction.options.getInteger('campaign_days') ?? config.elections.defaultCampaignDays;
      const votingDays = interaction.options.getInteger('voting_days') ?? config.elections.defaultVotingDays;
      const requiredRole = interaction.options.getRole('required_role');
      const minMembershipDays = interaction.options.getInteger('min_membership_days') ?? config.elections.eligibility.minMembershipDays;
      const requireAdminApprovalOpt = interaction.options.getBoolean('require_admin_approval');
      const requireAdminApproval = requireAdminApprovalOpt === null ? config.elections.eligibility.requireAdminApproval : requireAdminApprovalOpt;
      const sanctionRole = interaction.options.getRole('sanction_role');
      const options = interaction.options.getString('options');

      const election = createElection(interaction.client, {
        title,
        type,
        description,
        createdBy: interaction.user.id,
        createdByTag: interaction.user.tag,
        registrationDays,
        campaignDays,
        votingDays,
        requiredRole: requiredRole ? requiredRole.id : (config.elections.eligibility.requiredRole[0] || null),
        minMembershipDays,
        requireAdminApproval,
        sanctionRoleId: sanctionRole ? sanctionRole.id : (config.elections.eligibility.sanctionRole[0] || null),
        options,
      });

      // Referendum-style elections skip straight to Voting, with no
      // registration/campaign to wait through - so the voting card needs
      // to be posted immediately, rather than waiting for the scheduler or
      // an admin to open it later.
      if (election.status === 'Voting') {
        await openElectionVoting(interaction.client, election);
      }

      await interaction.reply({ embeds: [electionEmbed(election, config)], ephemeral: false });

      logAudit(interaction.client, 'Election Created', `**${election.number}** — ${election.title} (${election.type}) called by ${interaction.user.tag}`).catch((err) => console.error(err));

      const announceChannelId = config.elections.channels.announcements;
      if (announceChannelId) {
        interaction.client.channels
          .fetch(announceChannelId)
          .then((channel) => channel && channel.send({ content: `📣 A new election has been called: **${election.number}** — ${election.title}`, embeds: [electionEmbed(election, config)] }))
          .catch((err) => console.error('Failed to post election announcement:', err));
      }
      return;
    }

    if (sub === 'view') {
      const election = findElection(interaction.options.getString('number'));
      if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      return interaction.reply({ embeds: [electionEmbed(election, config)] });
    }

    if (sub === 'list') {
      const elections = getAllElections().slice(-15).reverse();
      if (elections.length === 0) return interaction.reply({ content: 'No elections have been called yet.', ephemeral: true });
      const lines = elections.map((e) => `**${e.number}** — ${e.title.slice(0, 80)} — *${e.status}*`);
      return interaction.reply({ content: lines.join('\n').slice(0, 4000) });
    }

    if (sub === 'open-voting') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      const election = findElection(interaction.options.getString('number'));
      if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      if (election.status !== 'Registration' && election.status !== 'Campaign') {
        return interaction.reply({ content: `❌ This election can't have voting opened from its current status (${election.status}).`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      await openElectionVoting(interaction.client, election);
      return interaction.editReply({ content: `✅ Voting opened for **${election.number}**.` });
    }

    if (sub === 'close') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      const election = findElection(interaction.options.getString('number'));
      if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      if (election.status !== 'Voting') {
        return interaction.reply({ content: `❌ This election is not currently being voted on (status: ${election.status}).`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const updated = await closeElectionVoting(interaction.client, election);
      return interaction.editReply({ content: `✅ Voting closed for **${updated.number}**. Status: **${updated.status}**.` });
    }

    if (sub === 'cancel') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      const election = findElection(interaction.options.getString('number'));
      if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      if (election.status === 'Certified' || election.status === 'Cancelled') {
        return interaction.reply({ content: `❌ This election has already ended (status: ${election.status}).`, ephemeral: true });
      }
      election.status = 'Cancelled';
      upsertElection(election);
      logAudit(interaction.client, 'Election Cancelled', `**${election.number}** — ${election.title} cancelled by ${interaction.user.tag}`).catch((err) => console.error(err));
      return interaction.reply({ content: `✅ **${election.number}** has been cancelled.` });
    }

    if (sub === 'declare-winner') {
      if (!isAdmin(interaction.member, config)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }
      const election = findElection(interaction.options.getString('number'));
      if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      if (election.status !== 'Tied - Awaiting Manual Resolution') {
        return interaction.reply({ content: `❌ This election is not awaiting a manual tie-break (status: ${election.status}).`, ephemeral: true });
      }
      const candidateId = interaction.options.getString('candidate_id');
      if (!election.tieCandidateIds || !election.tieCandidateIds.includes(candidateId)) {
        return interaction.reply({ content: `❌ **${candidateId}** was not one of the tied candidates.`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const updated = await declareWinner(interaction.client, election, candidateId);
      return interaction.editReply({ content: `✅ Winner declared for **${updated.number}**.` });
    }

    if (sub === 'attach') {
      const election = findElection(interaction.options.getString('number'));
      if (!election) {
        return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      }
      const canAttach = isAdmin(interaction.member, config) || election.createdBy === interaction.user.id;
      if (!canAttach) {
        return interaction.reply({ content: '❌ Only whoever called this election or an admin can attach files to it.', ephemeral: true });
      }

      const file = interaction.options.getAttachment('file');
      const description = interaction.options.getString('description');

      await interaction.deferReply({ ephemeral: true });

      try {
        // Re-post the file into the channel the command was run in so we
        // get a permanent Discord CDN URL to keep long-term, rather than
        // relying on the interaction's own attachment URL.
        const message = await interaction.channel.send({
          content: `📎 Attachment for **${election.number}**${description ? `: ${description}` : ''} (uploaded by ${interaction.user.tag})`,
          files: [{ attachment: file.url, name: file.name }],
        });
        const posted = message.attachments.first();

        election.attachments = election.attachments || [];
        election.attachments.push({
          url: posted.url,
          filename: posted.name,
          contentType: posted.contentType || null,
          size: posted.size,
          uploadedBy: interaction.user.id,
          uploadedByTag: interaction.user.tag,
          uploadedAt: Date.now(),
          description: description || null,
          messageUrl: message.url,
        });
        upsertElection(election);

        logAudit(interaction.client, 'Election Attachment Added', `**${election.number}** — ${posted.name} attached by ${interaction.user.tag}.`).catch((err) => console.error(err));

        return interaction.editReply({
          content: `✅ Attached **${posted.name}** to **${election.number}** (attachment #${election.attachments.length}).`,
          embeds: [electionEmbed(election, config)],
        });
      } catch (err) {
        console.error('Failed to attach file to election:', err);
        return interaction.editReply({ content: "❌ Couldn't attach that file - make sure the bot can send messages and attachments in this channel." });
      }
    }

    if (sub === 'remove-attachment') {
      const election = findElection(interaction.options.getString('number'));
      if (!election) {
        return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });
      }
      const canRemove = isAdmin(interaction.member, config) || election.createdBy === interaction.user.id;
      if (!canRemove) {
        return interaction.reply({ content: '❌ Only whoever called this election or an admin can remove its attachments.', ephemeral: true });
      }

      const index = interaction.options.getInteger('index');
      const attachments = election.attachments || [];
      if (index < 1 || index > attachments.length) {
        return interaction.reply({ content: `❌ **${election.number}** doesn't have an attachment #${index}. Use \`/election view\` to see the current list.`, ephemeral: true });
      }

      const [removed] = attachments.splice(index - 1, 1);
      election.attachments = attachments;
      upsertElection(election);

      logAudit(interaction.client, 'Election Attachment Removed', `**${election.number}** — ${removed.filename} removed by ${interaction.user.tag}.`).catch((err) => console.error(err));

      return interaction.reply({ content: `🗑️ Removed attachment **${removed.filename}** from **${election.number}**.`, ephemeral: true });
    }
  },
};

async function handleCandidateSubcommand(interaction, config, sub) {
  const number = interaction.options.getString('number');
  const election = findElection(number);
  if (!election) return interaction.reply({ content: '❌ No election found with that number.', ephemeral: true });

  if (sub === 'register') {
    if (isReferendumType(election.type)) {
      return interaction.reply({ content: '❌ This is a Yes/No election - there are no candidates to register.', ephemeral: true });
    }
    if (election.status !== 'Registration') {
      return interaction.reply({ content: `❌ Candidate registration is not open for this election (status: ${election.status}).`, ephemeral: true });
    }
    const result = registerCandidate(election, interaction.member);
    if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });

    await interaction.reply({
      content: `✅ You are registered as a candidate in **${election.number}**.${result.candidate.status === 'Pending' ? ' Your candidacy is pending admin approval.' : ''}`,
      ephemeral: true,
    });
    logAudit(interaction.client, 'Candidate Registered', `${interaction.user.tag} registered for ${election.number}.`).catch((err) => console.error(err));
    return;
  }

  if (sub === 'nominate') {
    if (!isAdmin(interaction.member, config)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }
    if (isReferendumType(election.type)) {
      return interaction.reply({ content: '❌ This is a Yes/No election - there are no candidates to nominate.', ephemeral: true });
    }
    if (election.status !== 'Registration' && election.status !== 'Campaign') {
      return interaction.reply({ content: `❌ This election is no longer accepting candidates (status: ${election.status}).`, ephemeral: true });
    }
    const targetUser = interaction.options.getUser('user');
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) return interaction.reply({ content: '❌ Could not find that member in this server.', ephemeral: true });

    const result = nominateCandidate(election, targetMember, interaction.user.id);
    if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });

    await interaction.reply({ content: `✅ <@${targetUser.id}> has been nominated for **${election.number}** and is approved to run.` });
    logAudit(interaction.client, 'Candidate Nominated', `${interaction.user.tag} nominated ${targetUser.tag} for ${election.number}.`).catch((err) => console.error(err));
    dmUser(interaction.client, targetUser.id, `📋 You have been nominated as a candidate in **${election.number}** — ${election.title}.`);
    return;
  }

  if (sub === 'approve' || sub === 'reject') {
    if (!isAdmin(interaction.member, config)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }
    const candidateId = interaction.options.getString('candidate_id');
    const candidate = election.candidates.find((c) => c.id === candidateId);
    if (!candidate) return interaction.reply({ content: `❌ No candidate **${candidateId}** found.`, ephemeral: true });
    if (candidate.status !== 'Pending') {
      return interaction.reply({ content: `❌ This candidate is not pending approval (status: ${candidate.status}).`, ephemeral: true });
    }

    candidate.status = sub === 'approve' ? 'Approved' : 'Rejected';
    upsertElection(election);

    await interaction.reply({ content: `✅ Candidate **${candidate.tag}** has been ${sub === 'approve' ? 'approved' : 'rejected'}.` });
    logAudit(interaction.client, `Candidate ${sub === 'approve' ? 'Approved' : 'Rejected'}`, `${candidate.tag} in ${election.number} by ${interaction.user.tag}.`).catch((err) => console.error(err));
    if (candidate.userId) {
      dmUser(
        interaction.client,
        candidate.userId,
        sub === 'approve'
          ? `✅ Your candidacy in **${election.number}** — ${election.title} has been approved.`
          : `❌ Your candidacy in **${election.number}** — ${election.title} was not approved.`
      );
    }
    return;
  }

  if (sub === 'withdraw') {
    const candidateId = interaction.options.getString('candidate_id');
    const candidate = election.candidates.find((c) => c.id === candidateId);
    if (!candidate) return interaction.reply({ content: `❌ No candidate **${candidateId}** found.`, ephemeral: true });

    const canWithdraw = isAdmin(interaction.member, config) || candidate.userId === interaction.user.id;
    if (!canWithdraw) {
      return interaction.reply({ content: '❌ Only the candidate themself or an admin can withdraw this candidacy.', ephemeral: true });
    }
    if (election.status === 'Voting' || election.status === 'Certified') {
      return interaction.reply({ content: `❌ Candidates can no longer withdraw once voting has begun (status: ${election.status}).`, ephemeral: true });
    }

    candidate.status = 'Withdrawn';
    upsertElection(election);
    await interaction.reply({ content: `✅ **${candidate.tag || candidate.label}** has withdrawn from **${election.number}**.` });
    logAudit(interaction.client, 'Candidate Withdrawn', `${candidate.tag || candidate.label} withdrew from ${election.number}.`).catch((err) => console.error(err));
    return;
  }

  if (sub === 'list') {
    if (election.candidates.length === 0) {
      return interaction.reply({ content: `**${election.number}** has no candidates yet.`, ephemeral: true });
    }
    const lines = election.candidates.map((c) => `**${c.id}** — ${c.tag || c.label} — **${c.status}**`);
    return interaction.reply({ content: lines.join('\n').slice(0, 4000) });
  }
}
