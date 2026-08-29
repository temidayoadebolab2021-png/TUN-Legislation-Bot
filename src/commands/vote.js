// /vote command
// Voting normally opens automatically when debate ends (see scheduler.js)
// and closes automatically when its timer runs out. This command lets an
// admin start or close a vote manually if needed. If a resolution requires
// approval from both bodies, you can target just one track with `track`.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../lib/config');
const { isAdmin } = require('../lib/permissions');
const { findResolution } = require('../lib/resolutions');
const { openVoting, closeVoting } = require('../lib/voting');
const { hasOpenAmendments } = require('../lib/amendments');

module.exports = {
  category: 'Legislation',
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Voting controls (admin only)')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Manually open voting for a resolution')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Manually close voting and certify the result')
        .addStringOption((o) => o.setName('number').setDescription('Resolution number').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('track')
            .setDescription('Which track to close (only relevant if this resolution needs both bodies)')
            .setRequired(false)
            .addChoices({ name: 'General Assembly', value: 'GA' }, { name: 'Security Council', value: 'SC' })
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const config = getConfig();
    if (!isAdmin(interaction.member, config)) {
      return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const number = interaction.options.getString('number');
    const resolution = findResolution(number);
    if (!resolution) {
      return interaction.reply({ content: `❌ No resolution found with number **${number}**.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    if (sub === 'start') {
      if (resolution.status !== 'Debate') {
        return interaction.editReply({ content: `❌ This resolution must be in Debate to start voting (status: ${resolution.status}).` });
      }
      if (hasOpenAmendments(resolution)) {
        return interaction.editReply({ content: `❌ **${resolution.number}** still has amendments in Debate or Voting. Resolve those first with \`/amendment\` before opening the main vote.` });
      }
      await openVoting(interaction.client, resolution);
      return interaction.editReply({ content: `✅ Voting opened for **${resolution.number}**.` });
    }

    if (sub === 'close') {
      if (resolution.status !== 'Voting') {
        return interaction.editReply({ content: `❌ This resolution is not currently being voted on (status: ${resolution.status}).` });
      }
      const track = interaction.options.getString('track');
      const updated = await closeVoting(interaction.client, resolution, track || null);
      return interaction.editReply({ content: `✅ Voting closed for **${updated.number}**. Status: **${updated.status}**.` });
    }
  },
};
