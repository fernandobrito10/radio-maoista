import { SlashCommandBuilder } from 'discord.js';
import { requireActiveQueue } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Mostra ou ajusta o volume (0-100)')
  .addIntegerOption((o) => o
    .setName('nivel')
    .setDescription('Volume de 0 a 100')
    .setMinValue(0)
    .setMaxValue(100));

export async function execute(interaction) {
  const queue = requireActiveQueue(interaction);
  const level = interaction.options.getInteger('nivel');

  if (level === null) {
    await interaction.reply({ embeds: [okEmbed(`🔊 Volume atual: **${queue.volume}%**`)] });
    return;
  }

  const applied = queue.setVolume(level);
  const icon = applied === 0 ? '🔇' : applied < 40 ? '🔉' : '🔊';
  await interaction.reply({ embeds: [okEmbed(`${icon} Volume em **${applied}%**`)] });
}
