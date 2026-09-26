import { config } from '../config.js';
import { primeSearch } from './searchCache.js';
import { truncate } from '../utils/format.js';
import { log } from '../utils/logger.js';

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';
const MIN_CHARS = 2;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;
const CHOICE_NAME_MAX = 100;
const CHOICE_VALUE_MAX = 100;

/**
 * Um debounce por usuario: cada tecla cancela a busca da tecla anterior.
 * Guarda o resolve junto do timer — cancelar precisa encerrar a promise da chamada
 * antiga, senao cada tecla digitada deixa um frame async pendurado pra sempre.
 */
const timers = new Map();
/** query normalizada -> { at, choices } */
const cache = new Map();

function looksLikeLink(text) {
  return /^https?:\/\//i.test(text) || /^spotify:/i.test(text);
}

/**
 * O endpoint responde JSONP em ISO-8859-1. Decodificar como UTF-8 (o que
 * res.text() faz sempre) transforma "legiao" em "legi�o", entao o charset
 * do header manda aqui.
 */
function decodeBody(buffer, contentType) {
  const charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  return /utf-?8/.test(charset ?? '') ? buffer.toString('utf8') : buffer.toString('latin1');
}

async function fetchSuggestions(query, timeoutMs) {
  const url = new URL(SUGGEST_URL);
  url.searchParams.set('client', 'youtube');
  url.searchParams.set('ds', 'yt');
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('q', query);

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
  const open = body.indexOf('(');
  const close = body.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('resposta em formato inesperado');

  const data = JSON.parse(body.slice(open + 1, close));
  return (Array.isArray(data[1]) ? data[1] : [])
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    .filter((text) => typeof text === 'string' && text.trim());
}

function cacheKey(query) {
  return query.toLowerCase();
}

function readCache(query) {
  const hit = cache.get(cacheKey(query));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(query));
    return null;
  }
  return hit.choices;
}

function writeCache(query, choices) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey(query), { at: Date.now(), choices });
}

/** A primeira opcao e sempre o que a pessoa digitou; depois vem as sugestoes. */
function buildChoices(typed, suggestions) {
  const seen = new Set([typed.toLowerCase()]);
  const choices = [{ name: truncate(`🔎 ${typed}`, CHOICE_NAME_MAX), value: typed.slice(0, CHOICE_VALUE_MAX) }];

  for (const text of suggestions) {
    if (choices.length >= config.autocomplete.results + 1) break;
    if (text.length > CHOICE_VALUE_MAX) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: truncate(text, CHOICE_NAME_MAX), value: text });
  }
  return choices.slice(0, 25);
}

function cancelPending(userId) {
  const pending = timers.get(userId);
  if (!pending) return;
  clearTimeout(pending.timer);
  timers.delete(userId);
  pending.resolve();
}

/**
 * Responde a interacao de autocomplete. Um 10062 aqui e esperado: significa que o
 * usuario continuou digitando e essa interacao especifica morreu.
 */
async function respond(interaction, choices) {
  if (interaction.responded) return;
  try {
    await interaction.respond(choices);
  } catch (err) {
    if (err.code !== 10062) log.debug(`autocomplete respond falhou: ${err.message}`);
  }
}

/**
 * Sugestoes do /play enquanto a pessoa digita.
 *
 * Buscar video no yt-dlp aqui e impossivel: sao ~2,5s (1,1s so de startup do
 * processo) e o token da interacao vale 3s. Entao o autocomplete usa o endpoint de
 * sugestao do YouTube (~350ms, ~700 bytes) e, em paralelo, manda o yt-dlp buscar a
 * query em background — quando a pessoa aperta enter, o /play acha no cache.
 *
 * O Discord manda uma interacao por tecla; o debounce garante uma sugestao (e um
 * prefetch) por pausa na digitacao, nao por tecla.
 */
export async function suggestTracks(interaction) {
  const typed = String(interaction.options.getFocused() ?? '').trim();
  const userId = interaction.user.id;
  // a fonte ja esta preenchida enquanto a pessoa digita: o prefetch vai pro site certo
  const source = interaction.options.getString('fonte') ?? 'youtube';

  cancelPending(userId);

  // link colado: nada a sugerir, o resolver cuida disso
  if (looksLikeLink(typed)) {
    await respond(interaction, typed.length <= CHOICE_VALUE_MAX
      ? [{ name: truncate(`🔗 ${typed}`, CHOICE_NAME_MAX), value: typed }]
      : []);
    return;
  }

  if (typed.length < MIN_CHARS) {
    await respond(interaction, []);
    return;
  }

  const cached = readCache(typed);
  if (cached) {
    await respond(interaction, cached);
    if (config.autocomplete.prefetch) primeSearch(typed, 1, source);
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(async () => {
      timers.delete(userId);
      const startedAt = Date.now();
      try {
        const suggestions = await fetchSuggestions(typed, config.autocomplete.searchTimeoutMs);
        const choices = buildChoices(typed, suggestions);
        writeCache(typed, choices);
        log.debug(`autocomplete "${typed}": ${choices.length} opcao(oes) em ${Date.now() - startedAt}ms`);
        await respond(interaction, choices);
      } catch (err) {
        log.debug(`autocomplete "${typed}" falhou em ${Date.now() - startedAt}ms: ${err.message}`);
        // sem sugestao ainda da pra tocar o que foi digitado
        await respond(interaction, buildChoices(typed, []));
      }

      // esquenta a busca de verdade enquanto a pessoa decide
      if (config.autocomplete.prefetch) primeSearch(typed, 1, source);
      resolve();
    }, config.autocomplete.debounceMs);

    timers.set(userId, { timer, resolve });
  });
}
