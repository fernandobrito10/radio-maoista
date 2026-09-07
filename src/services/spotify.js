import { config, features } from '../config.js';
import { log } from '../utils/logger.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
/** Sem timeout o undici espera ate 300s e a interacao do Discord morre antes. */
const TIMEOUT_MS = 8_000;
/** O embed devolve pagina de erro sem um UA de navegador. */
const EMBED_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

  /**
   * Playlist e o unico caso que a API oficial nao entrega mais.
   *
   * Medido com estas credenciais: `/playlists/{id}/tracks` responde 403 para
   * QUALQUER playlist (inclusive publicas conhecidas), e `/playlists/{id}` volta
   * 200 com o campo `tracks` vazio. E a restricao que o Spotify aplicou a apps
   * criados depois de nov/2024 — nao ha parametro que contorne. Playlists
   * editoriais dao 404 ate no metadados.
   *
   * Por isso: tenta a API (se um dia voltar, e o caminho melhor) e cai no player
   * embed publico, que ainda expõe a tracklist. E endpoint nao documentado: pode
   * mudar sem aviso, e por isso fica isolado aqui.
   */
  async getPlaylist(id, limit) {
    try {
      const viaApi = await this.#playlistViaApi(id, limit);
      if (viaApi.tracks.length) return viaApi;
      log.warn(`Spotify devolveu a playlist ${id} sem faixas (restricao de app novo); usando o embed publico.`);
    } catch (err) {
      log.warn(`Spotify API recusou a playlist ${id} (${err.message}); usando o embed publico.`);
    }
    return this.#playlistViaEmbed(id, limit);
  }

  async #playlistViaApi(id, limit) {
    const pl = await this.#get(`/playlists/${id}`, { market: config.spotify.market, fields: 'name,external_urls' });
    const items = await this.#paginate(`/playlists/${id}/tracks`, { market: config.spotify.market, limit: 100 }, limit);
    const tracks = items
      .map((i) => i?.track)
      .filter((t) => t && t.type === 'track')
      .map((t) => normalizeTrack(t));
    return { name: pl.name, url: pl.external_urls?.spotify ?? null, kind: 'playlist', tracks };
  }

  async #playlistViaEmbed(id, limit) {
    const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
      headers: { 'User-Agent': EMBED_USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SpotifyError(`Nao consegui abrir essa playlist (o Spotify respondeu ${res.status}).`);
    }

    const { name, trackList } = parseEmbedPayload(await res.text());
    if (!trackList?.length) {
      throw new SpotifyError('Essa playlist nao e publica (privada, colaborativa so pra convidados ou apagada), '
        + 'entao nao consigo ler as faixas. Deixe-a publica ou mande o link do album.');
    }

    const tracks = trackList
      .slice(0, limit)
      .filter((t) => t?.title)
      .map((t) => normalizeEmbedTrack(t));

    return {
      name: name || 'Playlist do Spotify',
      url: `https://open.spotify.com/playlist/${id}`,
      kind: 'playlist',
      tracks,
    };
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

/** O embed entrega os dados num <script id="__NEXT_DATA__"> com JSON dentro. */
function parseEmbedPayload(html) {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return { name: null, trackList: null };

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { name: null, trackList: null };
  }

  // a forma do JSON muda de tempo em tempo; procurar a chave e mais estavel
  // do que fixar o caminho completo
  const encontrar = (node, chave, profundidade = 0) => {
    if (!node || profundidade > 10) return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const achado = encontrar(item, chave, profundidade + 1);
        if (achado !== undefined) return achado;
      }
      return undefined;
    }
    if (typeof node === 'object') {
      if (node[chave] !== undefined) return node[chave];
      for (const valor of Object.values(node)) {
        const achado = encontrar(valor, chave, profundidade + 1);
        if (achado !== undefined) return achado;
      }
    }
    return undefined;
  };

  return { name: encontrar(data, 'name') ?? null, trackList: encontrar(data, 'trackList') ?? null };
}

/** No embed o artista vem em `subtitle`, nao num array de artists. */
function normalizeEmbedTrack(t) {
  const artist = String(t.subtitle ?? '').trim() || 'Desconhecido';
  const primaryArtist = artist.split(/\s*,\s*/)[0] || artist;
  const trackId = String(t.uri ?? '').split(':').pop() || null;

  return {
    title: t.title ?? 'Desconhecido',
    author: artist,
    url: null,
    durationMs: Number(t.duration) || 0,
    thumbnail: null,
    isLive: false,
    source: 'spotify',
    spotify: {
      id: trackId,
      artist,
      primaryArtist,
      title: t.title ?? '',
      album: null,
      url: trackId ? `https://open.spotify.com/track/${trackId}` : null,
    },
    query: `${primaryArtist} ${t.title ?? ''}`.trim(),
  };
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
