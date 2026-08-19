import { SlashCommandBuilder } from 'discord.js';
import { manager } from '../core/PlayerManager.js';
import { UserError } from '../utils/guards.js';
import { queueEmbed } from '../utils/embeds.js';

const PAGE_SIZE = 10;

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Mostra a fila de musicas')
  .addIntegerOption((o) => o
    .setName('pagina')
    .setDescription('Pagina da fila')
    .setMinValue(1));

export async function execute(interaction) {
  const queue = manager.get(interaction.guildId);
  if (!queue || (!queue.current && queue.size === 0)) {
    throw new UserError('A fila esta vazia. Use `/play` pra comecar.');
  }

  const page = interaction.options.getInteger('pagina') ?? 1;
  await interaction.reply({
    embeds: [queueEmbed({
      current: queue.current,
      tracks: queue.tracks,
      page,
      pageSize: PAGE_SIZE,
      volume: queue.volume,
      loop: queue.loop,
      positionMs: queue.positionMs,
    })],
  });
}
