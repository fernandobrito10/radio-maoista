import { createHash } from 'node:crypto';
import { config, features } from '../config.js';
import { log } from '../utils/logger.js';

const API = 'https://ws.audioscrobbler.com/2.0/';

export class LastfmError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = 'LastfmError';
    this.code = code;
  }
}

/** Assinatura do Last.fm: md5(params ordenados concatenados + secret). "format" fica fora. */
function sign(params) {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'api_sig')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return createHash('md5').update(base + config.lastfm.apiSecret, 'utf8').digest('hex');
}

async function call(method, params = {}, { post = false } = {}) {
  if (!features.lastfm) throw new LastfmError('Last.fm nao esta configurado no bot (LASTFM_API_KEY/SECRET).');

  const payload = { method, api_key: config.lastfm.apiKey };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') payload[k] = String(v);
  }
  payload.api_sig = sign(payload);
  payload.format = 'json';

  const body = new URLSearchParams(payload);
  const res = post
    ? await fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    : await fetch(`${API}?${body.toString()}`);

  const json = await res.json().catch(() => null);
  if (!json) throw new LastfmError(`Resposta invalida do Last.fm (HTTP ${res.status}).`);
  if (json.error) throw new LastfmError(json.message ?? `Erro ${json.error} do Last.fm.`, json.error);
  return json;
}

export const lastfm = {
  get enabled() {
    return features.lastfm;
  },

  async getToken() {
    const json = await call('auth.getToken');
    return json.token;
  },

  authUrl(token) {
    return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(config.lastfm.apiKey)}&token=${encodeURIComponent(token)}`;
  },

  /** So funciona depois do usuario autorizar o token no navegador. */
  async getSession(token) {
    const json = await call('auth.getSession', { token });
    return { name: json.session?.name, sessionKey: json.session?.key };
  },

  async updateNowPlaying({ sessionKey, artist, track, album, durationMs }) {
    return call('track.updateNowPlaying', {
      artist,
      track,
      album: album ?? undefined,
      duration: durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
      sk: sessionKey,
    }, { post: true });
  },

  async scrobble({ sessionKey, artist, track, album, durationMs, timestamp }) {
    return call('track.scrobble', {
      'artist[0]': artist,
      'track[0]': track,
      'album[0]': album ?? undefined,
      'duration[0]': durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
      'timestamp[0]': timestamp,
      sk: sessionKey,
    }, { post: true });
  },

  async userInfo(name) {
    const json = await call('user.getInfo', { user: name });
    return json.user;
  },
};

export function logLastfmError(context, err) {
  log.warn(`Last.fm (${context}): ${err.message}`);
}
