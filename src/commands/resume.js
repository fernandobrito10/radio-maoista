import { SlashCommandBuilder } from 'discord.js';
import { requirePlaying } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';
import { trackLink } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Retoma a faixa pausada');

export async function execute(interaction) {
  const queue = requirePlaying(interaction);
  if (!queue.isPaused) {
    await interaction.reply({ embeds: [okEmbed('Nao esta pausado.')] });
    return;
  }
  queue.resume();
  await interaction.reply({ embeds: [okEmbed(`▶️ Voltando: ${trackLink(queue.current)}`)] });
}
