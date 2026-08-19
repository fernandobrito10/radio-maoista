import { features } from '../config.js';
import { toScrobbleMeta } from '../utils/trackMeta.js';
import { lastfm, logLastfmError } from './lastfm.js';
import { userStore } from './userStore.js';
import { log } from '../utils/logger.js';

const MIN_SCROBBLE_MS = 30_000;   // Last.fm ignora faixas com menos de 30s
const MAX_THRESHOLD_MS = 240_000; // ou 4 minutos, o que vier primeiro

/** Quem esta no canal de voz, com Last.fm linkado e scrobble ligado. */
async function listenersOf(voiceChannel) {
  if (!features.lastfm || !voiceChannel) return [];
  const members = [...voiceChannel.members.values()].filter((m) => !m.user.bot);
  const entries = await Promise.all(members.map(async (m) => {
    const link = await userStore.getLastfm(m.id);
    return link?.sessionKey && link.scrobbling ? { member: m, link } : null;
  }));
  return entries.filter(Boolean);
}

/** Momento em que a faixa deve ser scrobblada (metade da duracao, no maximo 4min). */
export function scrobbleThresholdMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < MIN_SCROBBLE_MS) return Infinity;
  return Math.min(Math.floor(durationMs / 2), MAX_THRESHOLD_MS);
}

export const scrobbler = {
  get enabled() {
    return features.lastfm;
  },

  /** track.updateNowPlaying para todo mundo no canal. */
  async nowPlaying(track, voiceChannel) {
    if (!features.lastfm) return;
    const meta = toScrobbleMeta(track);
    if (!meta.artist) return;

    const listeners = await listenersOf(voiceChannel);
    await Promise.all(listeners.map(async ({ member, link }) => {
      try {
        await lastfm.updateNowPlaying({
          sessionKey: link.sessionKey,
          artist: meta.artist,
          track: meta.track,
          album: meta.album,
          durationMs: track.durationMs,
        });
      } catch (err) {
        logLastfmError(`nowPlaying ${member.user.tag}`, err);
      }
    }));
  },

  /** track.scrobble; devolve quantos scrobbles foram aceitos. */
  async scrobble(track, voiceChannel, startedAtMs) {
    if (!features.lastfm) return 0;
    const meta = toScrobbleMeta(track);
    if (!meta.artist) return 0;

    const listeners = await listenersOf(voiceChannel);
    if (!listeners.length) return 0;

    const timestamp = Math.floor((startedAtMs ?? Date.now()) / 1000);
    const results = await Promise.all(listeners.map(async ({ member, link }) => {
      try {
        await lastfm.scrobble({
          sessionKey: link.sessionKey,
          artist: meta.artist,
          track: meta.track,
          album: meta.album,
          durationMs: track.durationMs,
          timestamp,
        });
        return 1;
      } catch (err) {
        logLastfmError(`scrobble ${member.user.tag}`, err);
        return 0;
      }
    }));

    const total = results.reduce((a, b) => a + b, 0);
    if (total) log.debug(`Scrobble: ${meta.artist} - ${meta.track} (${total} usuario(s))`);
    return total;
  },
};
