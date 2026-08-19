const NOISE_IN_BRACKETS = /\b(official|oficial|video|videoclipe|clipe|audio|áudio|lyric|lyrics|letra|legendado|hd|hq|4k|full|mv|m\/v|visualizer|remaster(ed)?|explicit|color coded|sub español|live session)\b/i;

const TRAILING_NOISE = /\s*[-–—|]\s*(official\s*(music\s*)?video|official\s*audio|video\s*oficial|audio\s*oficial|lyric\s*video|visualizer)\s*$/i;

const DASHES = /\s+[-–—]\s+|\s+[-–—]|[-–—]\s+/;

/** Remove "(Official Video)", "[HD]", "| Lyrics" etc. do titulo do YouTube. */
export function cleanYoutubeTitle(title) {
  let out = String(title ?? '');
  out = out.replace(/[([{]([^)\]}]*)[)\]}]/g, (full, inner) => (NOISE_IN_BRACKETS.test(inner) ? ' ' : full));
  out = out.replace(TRAILING_NOISE, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function cleanAuthor(author) {
  return String(author ?? '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim();
}

/**
 * Deduz { artist, track, album } para o scrobble.
 * Spotify da metadados limpos; no YouTube a gente tenta "Artista - Musica".
 */
export function toScrobbleMeta(track) {
  if (track.spotify) {
    return {
      artist: track.spotify.primaryArtist || track.spotify.artist,
      track: track.spotify.title,
      album: track.spotify.album,
      confident: true,
    };
  }

  const cleaned = cleanYoutubeTitle(track.title);
  const parts = cleaned.split(DASHES).map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const artist = parts[0];
    const name = parts.slice(1).join(' - ').trim();
    if (artist.length <= 60 && name.length > 0) {
      return { artist, track: name, album: null, confident: true };
    }
  }

  const author = cleanAuthor(track.author);
  if (author && author.toLowerCase() !== 'desconhecido') {
    return { artist: author, track: cleaned || track.title, album: null, confident: false };
  }
  return { artist: null, track: cleaned || track.title, album: null, confident: false };
}
