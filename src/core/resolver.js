import { config, features } from '../config.js';
import { parseSpotifyUrl, spotify, SpotifyError } from '../services/spotify.js';
import * as ytdlp from '../services/ytdlp.js';
import { log } from '../utils/logger.js';

const YT_HOST = /^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

export class ResolveError extends Error {}

function asUrl(input) {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

function classify(input) {
  const spotifyRef = parseSpotifyUrl(input);
  if (spotifyRef) return { kind: 'spotify', ...spotifyRef };

  const url = asUrl(input);
  if (!url) return { kind: 'search' };

  if (YT_HOST.test(url.hostname)) {
    const isPlaylistPage = url.pathname === '/playlist' || (url.searchParams.has('list') && !url.searchParams.has('v') && url.pathname !== '/watch');
    return { kind: isPlaylistPage ? 'yt-playlist' : 'yt-video' };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'url' };
  return { kind: 'search' };
}

/**
 * Transforma o texto do /play em uma lista de tracks.
 * Faixas do Spotify entram "nao resolvidas" — o YouTube e buscado na hora de tocar.
 */
export async function resolveQuery(input, { requestedBy }) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ResolveError('Manda o nome ou o link da musica.');

  const target = classify(raw);
  const limit = config.player.maxQueueSize;
  const stamp = (tracks) => tracks.map((t) => ({ ...t, requestedBy, addedAt: Date.now() }));

  switch (target.kind) {
    case 'spotify': {
      if (!features.spotify) {
        throw new ResolveError('Links do Spotify precisam de `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` no `.env`.');
      }
      try {
        if (target.type === 'track') {
          const track = await spotify.getTrack(target.id);
          return { kind: 'track', tracks: stamp([track]) };
        }
        const collection = target.type === 'album'
          ? await spotify.getAlbum(target.id, limit)
          : target.type === 'playlist'
            ? await spotify.getPlaylist(target.id, limit)
            : await spotify.getArtistTopTracks(target.id, limit);

        if (!collection.tracks.length) throw new ResolveError('Esse item do Spotify nao tem faixas tocaveis.');
        return {
          kind: collection.kind,
          playlistName: collection.name,
          playlistUrl: collection.url,
          tracks: stamp(collection.tracks),
        };
      } catch (err) {
        if (err instanceof SpotifyError) throw new ResolveError(err.message);
        throw err;
      }
    }

    case 'yt-playlist': {
      const playlist = await ytdlp.getPlaylist(raw, limit);
      if (!playlist.tracks.length) throw new ResolveError('Nao achei nenhum video nessa playlist.');
      return {
        kind: 'playlist',
        playlistName: playlist.title,
        playlistUrl: playlist.url,
        tracks: stamp(playlist.tracks),
      };
    }

    case 'yt-video':
    case 'url': {
      const track = await ytdlp.getVideo(raw);
      return { kind: 'track', tracks: stamp([track]) };
    }

    default: {
      const results = await ytdlp.search(raw, 1);
      if (!results.length) throw new ResolveError(`Nao achei nada no YouTube pra **${raw}**.`);
      return { kind: 'search', tracks: stamp(results) };
    }
  }
}

const ytCache = new Map(); // query -> { url, title, author, durationMs, thumbnail }

/**
 * Garante que a track tem um URL tocavel.
 * Faixa do Spotify -> busca o equivalente no YouTube (com cache em memoria).
 */
export async function ensurePlayable(track) {
  if (track.url) return track;

  const query = track.query ?? `${track.author} ${track.title}`.trim();
  const key = query.toLowerCase();

  if (ytCache.has(key)) {
    return Object.assign(track, ytCache.get(key));
  }

  log.debug(`Resolvendo no YouTube: ${query}`);
  let results = await ytdlp.search(`${query} audio`, 1);
  if (!results.length) results = await ytdlp.search(query, 1);
  if (!results.length) throw new ResolveError(`Nao achei "${query}" no YouTube.`);

  const found = results[0];
  const patch = {
    url: found.url,
    // mantem titulo/artista do Spotify, mas usa duracao do YouTube se nao tinha
    durationMs: track.durationMs || found.durationMs,
    thumbnail: track.thumbnail ?? found.thumbnail,
    youtubeTitle: found.title,
  };
  if (ytCache.size > 500) ytCache.clear();
  ytCache.set(key, patch);
  return Object.assign(track, patch);
}
