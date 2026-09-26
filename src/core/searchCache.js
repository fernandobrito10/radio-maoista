import { search } from '../services/ytdlp.js';
import { log } from '../utils/logger.js';

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;

/** chave -> { at, tracks } */
const results = new Map();
/** chave -> Promise<tracks> em andamento */
const inflight = new Map();

const keyOf = (query, limit, source) => `${source}|${limit}|${query.trim().toLowerCase()}`;

/**
 * Busca no YouTube com cache e deduplicacao de chamadas simultaneas.
 *
 * Cada busca custa ~2,5s (1,1s so de startup do yt-dlp). Duas coisas evitam pagar
 * isso de novo: o cache por query e o mapa de chamadas em andamento — se o
 * autocomplete ja disparou a busca e a pessoa aperta enter no meio dela, o /play
 * espera a MESMA promise em vez de subir um segundo yt-dlp.
 */
export async function cachedSearch(query, limit = 1, source = 'youtube') {
  const key = keyOf(query, limit, source);

  const hit = results.get(key);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) {
      log.debug(`busca em cache: "${query}"`);
      return hit.tracks;
    }
    results.delete(key);
  }

  const running = inflight.get(key);
  if (running) {
    log.debug(`busca ja em andamento, aproveitando: "${query}"`);
    return running;
  }

  const promise = search(query, limit, { source })
    .then((tracks) => {
      if (results.size >= MAX_ENTRIES) results.delete(results.keys().next().value);
      results.set(key, { at: Date.now(), tracks });
      return tracks;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/** Esquenta o cache em background (autocomplete). Nunca lanca. */
export function primeSearch(query, limit = 1, source = 'youtube') {
  const key = keyOf(query, limit, source);
  if (results.has(key) || inflight.has(key)) return;
  void cachedSearch(query, limit, source).catch((err) => {
    log.debug(`prefetch da busca "${query}" (${source}) falhou: ${err.message}`);
  });
}
