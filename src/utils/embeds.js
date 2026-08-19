import { EmbedBuilder } from 'discord.js';
import { escapeMd, formatDuration, plural, progressBar, trackLink, truncate } from './format.js';

export const COLOR = 0xe03131;
export const COLOR_ERROR = 0x8b0000;

const SOURCE_TAG = { spotify: 'Spotify → YouTube', youtube: 'YouTube' };

export function errorEmbed(message) {
  return new EmbedBuilder().setColor(COLOR_ERROR).setDescription(`❌ ${message}`);
}

export function okEmbed(message) {
  return new EmbedBuilder().setColor(COLOR).setDescription(message);
}

export function nowPlayingEmbed(track, { positionMs = null, volume = null, loop = 'off', queueSize = 0 } = {}) {
  const lines = [`por **${escapeMd(truncate(track.author, 60))}**`];
  if (track.requestedBy) lines.push(`pedido por <@${track.requestedBy}>`);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: 'Tocando agora' })
    .setTitle(truncate(track.title, 100))
    .setDescription(lines.join(' • '));

  if (track.url) embed.setURL(track.url);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  if (positionMs === null) {
    embed.addFields({ name: 'Duracao', value: formatDuration(track.durationMs), inline: true });
  } else {
    embed.addFields({
      name: 'Progresso',
      value: `${progressBar(positionMs, track.durationMs)}\n\`${formatDuration(positionMs)} / ${formatDuration(track.durationMs)}\``,
      inline: false,
    });
  }

  if (volume !== null) embed.addFields({ name: 'Volume', value: `${volume}%`, inline: true });
  if (loop !== 'off') embed.addFields({ name: 'Loop', value: loop === 'track' ? 'faixa' : 'fila', inline: true });
  if (queueSize > 0) embed.addFields({ name: 'Na fila', value: `${queueSize} ${plural(queueSize, 'faixa', 'faixas')}`, inline: true });

  embed.setFooter({ text: SOURCE_TAG[track.source] ?? track.source });
  if (track.spotify?.url) {
    embed.addFields({ name: 'Spotify', value: `[abrir no Spotify](${track.spotify.url})`, inline: true });
  }
  return embed;
}

export function addedTrackEmbed(track, { position }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: 'Adicionado a fila' })
    .setDescription(`${trackLink(track)}\npor **${escapeMd(truncate(track.author, 60))}** • \`${formatDuration(track.durationMs)}\``)
    .setFooter({ text: position > 0 ? `Posicao #${position} na fila` : 'Tocando em seguida' });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function addedPlaylistEmbed({ name, url, count, totalMs, kind }) {
  const label = kind === 'album' ? 'Album' : kind === 'artist' ? 'Artista' : 'Playlist';
  const title = url ? `[${escapeMd(truncate(name, 80))}](${url})` : escapeMd(truncate(name, 80));
  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${label} adicionado a fila` })
    .setDescription(`${title}\n**${count}** ${plural(count, 'faixa', 'faixas')} • \`${formatDuration(totalMs)}\``);
}

export function queueEmbed({ current, tracks, page, pageSize, volume, loop, positionMs }) {
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const slice = tracks.slice((safePage - 1) * pageSize, safePage * pageSize);
  const totalMs = tracks.reduce((sum, t) => sum + (t.durationMs || 0), 0);

  const lines = slice.map((t, i) => {
    const index = (safePage - 1) * pageSize + i + 1;
    return `\`${String(index).padStart(2, ' ')}.\` ${trackLink(t)} \`${formatDuration(t.durationMs)}\` — <@${t.requestedBy}>`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('📻 Fila')
    .setFooter({
      text: `Pagina ${safePage}/${totalPages} • ${tracks.length} na fila • ${formatDuration(totalMs)} restantes • volume ${volume}% • loop ${loop}`,
    });

  if (current) {
    embed.addFields({
      name: 'Tocando agora',
      value: `${trackLink(current)} \`${formatDuration(positionMs)} / ${formatDuration(current.durationMs)}\` — <@${current.requestedBy}>`,
    });
  }
  embed.setDescription(lines.length ? lines.join('\n') : '_Fila vazia. Use `/play` pra adicionar._');
  return embed;
}
