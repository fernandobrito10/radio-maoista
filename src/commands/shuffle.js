import { SlashCommandBuilder } from 'discord.js';
import { requireActiveQueue } from '../utils/guards.js';
import { errorEmbed, okEmbed } from '../utils/embeds.js';
import { plural } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Embaralha a fila');

export async function execute(interaction) {
  const queue = requireActiveQueue(interaction);
  if (queue.size < 2) {
    await interaction.reply({ embeds: [errorEmbed('Precisa de pelo menos 2 faixas na fila pra embaralhar.')] });
    return;
  }
  const total = queue.shuffle();
  await interaction.reply({ embeds: [okEmbed(`🔀 Embaralhei ${total} ${plural(total, 'faixa', 'faixas')}.`)] });
}
