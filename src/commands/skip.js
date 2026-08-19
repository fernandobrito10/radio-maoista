import { SlashCommandBuilder } from 'discord.js';
import { LoopMode } from '../core/GuildQueue.js';
import { requirePlaying } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';
import { trackLink } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Pula para a proxima faixa')
  .addIntegerOption((o) => o
    .setName('quantidade')
    .setDescription('Quantas faixas pular (a atual conta como 1)')
    .setMinValue(1)
    .setMaxValue(100));

export async function execute(interaction) {
  const queue = requirePlaying(interaction);
  const amount = interaction.options.getInteger('quantidade') ?? 1;

  // loop de faixa faria o skip repetir a mesma musica
  if (queue.loop === LoopMode.TRACK) queue.setLoop(LoopMode.OFF);

  const skipped = queue.current;
  if (amount > 1) queue.tracks.splice(0, Math.min(amount - 1, queue.tracks.length));

  const upNext = queue.tracks[0] ?? null;
  queue.skip();

  const tail = upNext ? `\nProxima: ${trackLink(upNext)}` : '\nA fila acabou.';
  await interaction.reply({ embeds: [okEmbed(`⏭️ Pulei ${trackLink(skipped)}${amount > 1 ? ` (+${amount - 1})` : ''}.${tail}`)] });
}
