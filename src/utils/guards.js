import { PermissionsBitField } from 'discord.js';
import { manager } from '../core/PlayerManager.js';

/** Erro "de usuario": vira mensagem ephemeral bonitinha em vez de stack trace. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export function requireVoiceChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new UserError('Entra num canal de voz primeiro. 🎧');

  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.Connect)) {
    throw new UserError(`Nao tenho permissao pra **conectar** em ${channel}.`);
  }
  if (!perms.has(PermissionsBitField.Flags.Speak)) {
    throw new UserError(`Nao tenho permissao pra **falar** em ${channel}.`);
  }
  if (channel.userLimit > 0 && channel.members.size >= channel.userLimit && !perms.has(PermissionsBitField.Flags.MoveMembers)) {
    throw new UserError(`${channel} esta cheio.`);
  }
  return channel;
}

/** Fila ativa no servidor + usuario no mesmo canal de voz do bot. */
export function requireActiveQueue(interaction, { sameChannel = true } = {}) {
  const queue = manager.get(interaction.guildId);
  if (!queue || queue.destroyed) throw new UserError('Nao tem nada tocando agora.');

  if (sameChannel) {
    const userChannel = interaction.member?.voice?.channel;
    if (!userChannel || userChannel.id !== queue.voiceChannel?.id) {
      throw new UserError(`Voce precisa estar em ${queue.voiceChannel ?? 'no canal do bot'} pra usar esse comando.`);
    }
  }
  return queue;
}

export function requirePlaying(interaction, opts) {
  const queue = requireActiveQueue(interaction, opts);
  if (!queue.current) throw new UserError('Nao tem nenhuma faixa tocando.');
  return queue;
}
