import { SlashCommandBuilder } from 'discord.js';
import { requirePlaying } from '../utils/guards.js';
import { nowPlayingEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Mostra a faixa que esta tocando agora');

export async function execute(interaction) {
  const queue = requirePlaying(interaction, { sameChannel: false });
  const embed = nowPlayingEmbed(queue.current, {
    positionMs: queue.positionMs,
    volume: queue.volume,
    loop: queue.loop,
    queueSize: queue.size,
  });
  if (queue.isPaused) embed.setAuthor({ name: 'Pausado' });
  await interaction.reply({ embeds: [embed] });
}
