import { SlashCommandBuilder } from 'discord.js';
import { requirePlaying } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';
import { trackLink } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pausa a faixa atual');

export async function execute(interaction) {
  const queue = requirePlaying(interaction);
  if (queue.isPaused) {
    await interaction.reply({ embeds: [okEmbed('Ja esta pausado. Use `/resume` pra voltar.')] });
    return;
  }
  queue.pause();
  await interaction.reply({ embeds: [okEmbed(`⏸️ Pausado: ${trackLink(queue.current)}`)] });
}
