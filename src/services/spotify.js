import { config, features } from '../config.js';
import { log } from '../utils/logger.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
/** Sem timeout o undici espera ate 300s e a interacao do Discord morre antes. */
const TIMEOUT_MS = 8_000;

const URL_RE = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+))|(?:spotify:(track|album|playlist|artist):([A-Za-z0-9]+))/i;

export class SpotifyError extends Error {}

/** Reconhece qualquer link/URI do Spotify e devolve { type, id }. */
export function parseSpotifyUrl(input) {
  const match = URL_RE.exec(String(input ?? ''));
  if (!match) return null;
  const type = (match[1] ?? match[3]).toLowerCase();
  const id = match[2] ?? match[4];
  return { type, id };
}

class SpotifyClient {
  #token = null;
  #expiresAt = 0;
  #pending = null;

  get enabled() {
    return features.spotify;
  }

  async #getToken() {
    if (this.#token && Date.now() < this.#expiresAt - 30_000) return this.#token;
    if (this.#pending) return this.#pending;

    this.#pending = (async () => {
      const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new SpotifyError(`Falha ao autenticar no Spotify (${res.status}). Confira SPOTIFY_CLIENT_ID/SECRET.`);
      }
      const json = await res.json();
      this.#token = json.access_token;
      this.#expiresAt = Date.now() + json.expires_in * 1000;
      return this.#token;
    })().finally(() => { this.#pending = null; });

    return this.#pending;
  }

  async #get(pathOrUrl, params = {}) {
    const token = await this.#getToken();
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(API + pathOrUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 429) {
        const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
        log.warn(`Spotify rate limit, aguardando ${wait}ms`);
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      if (res.status === 404) {
        throw new SpotifyError('Nao encontrei esse item no Spotify (privado, regional ou inexistente).');
      }
      if (!res.ok) {
        throw new SpotifyError(`Spotify respondeu ${res.status} em ${url.pathname}.`);
      }
      return res.json();
    }
    throw new SpotifyError('Spotify recusou as requisicoes (rate limit).');
  }

  /** Percorre paginacao do Spotify acumulando items. */
  async #paginate(firstPath, params, limitTotal) {
    const items = [];
    let page = await this.#get(firstPath, params);
    while (page) {
      items.push(...(page.items ?? []));
      if (!page.next || items.length >= limitTotal) break;
      page = await this.#get(page.next);
    }
    return items.slice(0, limitTotal);
  }

  async getTrack(id) {
    const t = await this.#get(`/tracks/${id}`, { market: config.spotify.market });
    return normalizeTrack(t);
  }

  async getAlbum(id, limit) {
    const album = await this.#get(`/albums/${id}`, { market: config.spotify.market });
    const items = await this.#paginate(`/albums/${id}/tracks`, { market: config.spotify.market, limit: 50 }, limit);
    const tracks = items
      .filter(Boolean)
      .map((t) => normalizeTrack({ ...t, album: { name: album.name, images: album.images } }));
    return { name: album.name, url: album.external_urls?.spotify ?? null, kind: 'album', tracks };
  }

  async getPlaylist(id, limit) {
    const pl = await this.#get(`/playlists/${id}`, { market: config.spotify.market, fields: 'name,external_urls' });
    const items = await this.#paginate(`/playlists/${id}/tracks`, { market: config.spotify.market, limit: 100 }, limit);
    const tracks = items
      .map((i) => i?.track)
      .filter((t) => t && t.type === 'track')
      .map((t) => normalizeTrack(t));
    return { name: pl.name, url: pl.external_urls?.spotify ?? null, kind: 'playlist', tracks };
  }

  async getArtistTopTracks(id, limit) {
    const artist = await this.#get(`/artists/${id}`);
    const { tracks } = await this.#get(`/artists/${id}/top-tracks`, { market: config.spotify.market });
    return {
      name: `Top tracks — ${artist.name}`,
      url: artist.external_urls?.spotify ?? null,
      kind: 'artist',
      tracks: (tracks ?? []).slice(0, limit).map((t) => normalizeTrack(t)),
    };
  }
}

/** Track do Spotify no formato interno; url do YouTube fica nula (resolve na hora de tocar). */
function normalizeTrack(t) {
  const artists = (t.artists ?? []).map((a) => a.name).filter(Boolean);
  const artist = artists.join(', ') || 'Desconhecido';
  return {
    title: t.name ?? 'Desconhecido',
    author: artist,
    url: null,
    durationMs: Number(t.duration_ms) || 0,
    thumbnail: t.album?.images?.[0]?.url ?? null,
    isLive: false,
    source: 'spotify',
    spotify: {
      id: t.id ?? null,
      artist,
      primaryArtist: artists[0] ?? artist,
      title: t.name ?? '',
      album: t.album?.name ?? null,
      url: t.external_urls?.spotify ?? null,
    },
    query: `${artists[0] ?? ''} ${t.name ?? ''}`.trim(),
  };
}

export const spotify = new SpotifyClient();
