import { SlashCommandBuilder } from 'discord.js';
import { requireActiveQueue } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';
import { plural } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Para tudo, limpa a fila e sai do canal de voz');

export async function execute(interaction) {
  const queue = requireActiveQueue(interaction);
  const removed = queue.size;
  queue.stop();
  await interaction.reply({
    embeds: [okEmbed(`⏹️ Parei tudo, limpei ${removed} ${plural(removed, 'faixa', 'faixas')} e sai do canal.`)],
  });
}
