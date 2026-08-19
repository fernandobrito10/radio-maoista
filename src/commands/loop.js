import { SlashCommandBuilder } from 'discord.js';
import { LoopMode } from '../core/GuildQueue.js';
import { requireActiveQueue } from '../utils/guards.js';
import { okEmbed } from '../utils/embeds.js';

const LABELS = {
  [LoopMode.OFF]: '➡️ Loop **desligado**',
  [LoopMode.TRACK]: '🔂 Repetindo **a faixa atual**',
  [LoopMode.QUEUE]: '🔁 Repetindo **a fila inteira**',
};

export const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Alterna o modo de repeticao')
  .addStringOption((o) => o
    .setName('modo')
    .setDescription('off = desliga, faixa = repete a musica, fila = repete tudo')
    .addChoices(
      { name: 'off (desligado)', value: LoopMode.OFF },
      { name: 'faixa (repete a musica atual)', value: LoopMode.TRACK },
      { name: 'fila (repete a fila inteira)', value: LoopMode.QUEUE },
    ));

const CYCLE = [LoopMode.OFF, LoopMode.TRACK, LoopMode.QUEUE];

export async function execute(interaction) {
  const queue = requireActiveQueue(interaction);
  const requested = interaction.options.getString('modo');
  // sem argumento: cicla off -> faixa -> fila -> off
  const mode = requested ?? CYCLE[(CYCLE.indexOf(queue.loop) + 1) % CYCLE.length];

  queue.setLoop(mode);
  await interaction.reply({ embeds: [okEmbed(LABELS[mode])] });
}
