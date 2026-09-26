import { SlashCommandBuilder } from 'discord.js';
import { manager } from '../core/PlayerManager.js';
import { resolveQuery } from '../core/resolver.js';
import { suggestTracks } from '../core/suggest.js';
import { requireVoiceChannel } from '../utils/guards.js';
import { addedPlaylistEmbed, addedTrackEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Toca uma musica: nome, ou link do YouTube, Spotify ou SoundCloud')
  .addStringOption((o) => o
    .setName('busca')
    .setDescription('Nome da musica, ou link do YouTube, Spotify ou SoundCloud')
    .setRequired(true)
    .setMaxLength(500)
    .setAutocomplete(true))
  .addStringOption((o) => o
    .setName('fonte')
    .setDescription('Onde procurar quando voce digita um nome (links sempre usam o site do proprio link)')
    .addChoices(
      { name: 'YouTube (padrao)', value: 'youtube' },
      { name: 'SoundCloud', value: 'soundcloud' },
    ))
  .addBooleanOption((o) => o
    .setName('agora')
    .setDescription('Coloca no topo da fila em vez do fim'));

export async function execute(interaction) {
  const voiceChannel = requireVoiceChannel(interaction);
  await interaction.deferReply();

  const query = interaction.options.getString('busca', true);
  const playNext = interaction.options.getBoolean('agora') ?? false;
  const source = interaction.options.getString('fonte') ?? 'youtube';

  // Entrar no canal de voz e resolver a busca sao independentes: em serie somavam
  // o handshake de voz com os ~2,5s do yt-dlp. Em paralelo, paga-se so o maior.
  const conexao = manager.ensure({
    guild: interaction.guild,
    voiceChannel,
    textChannel: interaction.channel,
  });
  // sem isto, uma busca que falha antes da conexao deixa a rejeicao sem dono
  conexao.catch(() => {});

  const result = await resolveQuery(query, { requestedBy: interaction.user.id, source });
  const queue = await conexao;

  const startingNow = !queue.current && !queue.isPlaying && !queue.isPaused;
  const isSingle = result.tracks.length === 1;

  const added = queue.add(result.tracks, { next: playNext });
  if (added === 0) {
    await interaction.editReply({ embeds: [errorEmbed('A fila esta cheia, nao cabe mais nada.')] });
    return;
  }
  queue.cancelLeave();

  // faixa unica que ja vai tocar: o embed de "tocando agora" vira a propria resposta
  let responder = null;
  if (isSingle && startingNow) {
    // devolve a Message pra fila poder apagar esse "tocando agora" na proxima faixa
    responder = queue.useResponder((embed) => interaction.editReply({ embeds: [embed] }));
  }

  if (!isSingle) {
    const totalMs = result.tracks.slice(0, added).reduce((sum, t) => sum + (t.durationMs || 0), 0);
    const skipped = result.tracks.length - added;
    const embed = addedPlaylistEmbed({
      name: result.playlistName ?? 'Playlist',
      url: result.playlistUrl,
      count: added,
      totalMs,
      kind: result.kind,
    });
    if (skipped > 0) embed.setFooter({ text: `${skipped} faixa(s) ficaram de fora: fila cheia.` });
    await interaction.editReply({ embeds: [embed] });
  } else if (!startingNow) {
    const track = result.tracks[0];
    const position = playNext ? 1 : queue.tracks.indexOf(track) + 1;
    await interaction.editReply({ embeds: [addedTrackEmbed(track, { position })] });
  }

  await queue.start();

  // Garante uma resposta se nada foi anunciado — mas so se o responder pendente
  // ainda for o NOSSO. Dois /play simultaneos consumiam a resposta um do outro e
  // deixavam a primeira interacao pendurada em "pensando...".
  if (responder && queue.isResponder(responder)) {
    queue.clearResponder();
    await interaction.editReply({ embeds: [addedTrackEmbed(result.tracks[0], { position: 0 })] });
  }
}

// Sugestoes enquanto a pessoa digita. O valor escolhido ja e a URL do YouTube,
// entao o execute() acima nao precisa buscar de novo.
export function autocomplete(interaction) {
  return suggestTracks(interaction);
}
