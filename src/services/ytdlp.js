import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best';

const BASE_ARGS = ['--ignore-config', '--no-warnings', '--no-color', '--no-progress'];

function cookieArgs() {
  const args = [];
  if (config.ytdlp.cookiesFromBrowser) args.push('--cookies-from-browser', config.ytdlp.cookiesFromBrowser);
  else if (config.ytdlp.cookiesFile) args.push('--cookies', config.ytdlp.cookiesFile);
  return args;
}

export class YtDlpError extends Error {
  constructor(message, { stderr = '', code = null } = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.stderr = stderr;
    this.code = code;
  }
}

/** Roda o yt-dlp e devolve o stdout completo (pra chamadas de metadados). */
function run(args, { timeoutMs = 60_000 } = {}) {
  const finalArgs = [...BASE_ARGS, ...cookieArgs(), ...config.ytdlp.extraArgs, ...args];
  log.debug('yt-dlp', finalArgs.join(' '));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(config.ytdlp.path, finalArgs, { windowsHide: true });
    } catch (err) {
      reject(new YtDlpError(`Nao consegui executar "${config.ytdlp.path}": ${err.message}`));
      return;
    }

    const out = [];
    const err = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new YtDlpError('yt-dlp demorou demais para responder (timeout).'));
    }, timeoutMs);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = e.code === 'ENOENT'
        ? `yt-dlp nao encontrado em "${config.ytdlp.path}". Instale ou ajuste YTDLP_PATH no .env.`
        : e.message;
      reject(new YtDlpError(hint));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(new YtDlpError(`yt-dlp saiu com codigo ${code}.`, { stderr, code }));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

function parseJsonLines(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toMs(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
    return info.thumbnails[info.thumbnails.length - 1]?.url ?? null;
  }
  if (info.id) return `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
  return null;
}

function videoUrl(info) {
  if (info.webpage_url) return info.webpage_url;
  if (info.url && /^https?:/.test(info.url)) return info.url;
  if (info.id) return `https://www.youtube.com/watch?v=${info.id}`;
  return null;
}

/** Normaliza um objeto do yt-dlp para o formato interno de track. */
export function toTrack(info, extra = {}) {
  return {
    title: info.track ?? info.title ?? 'Desconhecido',
    author: (info.artist ?? info.uploader ?? info.channel ?? '').replace(/ - Topic$/, '') || 'Desconhecido',
    url: videoUrl(info),
    durationMs: toMs(info.duration),
    thumbnail: pickThumbnail(info),
    isLive: Boolean(info.is_live),
    source: 'youtube',
    spotify: null,
    query: null,
    ...extra,
  };
}

export async function checkAvailable() {
  const stdout = await run(['--version'], { timeoutMs: 15_000 });
  return stdout.trim();
}

/** Busca no YouTube e devolve N resultados (rapido, sem resolver formatos). */
export async function search(query, limit = 1) {
  const stdout = await run([
    '--flat-playlist',
    '--dump-json',
    '--playlist-end', String(limit),
    `ytsearch${limit}:${query}`,
  ], { timeoutMs: 30_000 });

  return parseJsonLines(stdout)
    .filter((e) => e.id)
    .slice(0, limit)
    .map((e) => toTrack(e));
}

/** Metadados de um video unico. */
export async function getVideo(url) {
  const stdout = await run(['--no-playlist', '--dump-single-json', url]);
  const info = JSON.parse(stdout);
  return toTrack(info);
}

/** Itens de uma playlist do YouTube (modo flat, so metadados basicos). */
export async function getPlaylist(url, limit = config.player.maxQueueSize) {
  const stdout = await run([
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-end', String(limit),
    url,
  ], { timeoutMs: 120_000 });

  const info = JSON.parse(stdout);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return {
    title: info.title ?? 'Playlist',
    url: info.webpage_url ?? url,
    tracks: entries.filter((e) => e?.id && e?.duration !== 0).map((e) => toTrack(e)),
  };
}

/**
 * Tenta abrir o audio com um client especifico do YouTube.
 * So resolve quando os primeiros bytes chegam de verdade — assim um 403 na midia
 * (que o yt-dlp so descobre depois de extrair) vira rejeicao, nao um stream vazio.
 */
function openWithClient(url, client, { firstByteTimeoutMs = 20_000 } = {}) {
  const args = [
    ...BASE_ARGS,
    ...cookieArgs(),
    '--extractor-args', `youtube:player_client=${client}`,
    ...config.ytdlp.extraArgs,
    '--no-playlist',
    '--no-part',
    '-f', AUDIO_FORMAT,
    '-o', '-',
    url,
  ];

  log.debug(`yt-dlp stream (player_client=${client})`, url);

  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlp.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = new PassThrough({ highWaterMark: 1 << 20 });
    const stderrChunks = [];
    let gotBytes = false;
    let settled = false;

    const kill = () => {
      child.killedByUs = true;
      if (!child.killed) child.kill('SIGKILL');
      out.destroy();
    };

    const stderrTail = () => Buffer.concat(stderrChunks).toString('utf8').slice(-600).trim();

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new YtDlpError(message, { stderr: stderrTail() }));
    };

    const timer = setTimeout(() => fail(`o yt-dlp nao entregou audio em ${firstByteTimeoutMs / 1000}s`), firstByteTimeoutMs);

    child.stdout.pipe(out);

    // "readable" avisa que tem dado no buffer sem consumir — quem le e o player.
    // Atencao: ele tambem dispara no EOF, e um yt-dlp que morreu de 403 fecha o
    // stream vazio. So conta como sucesso se houver byte de verdade no buffer.
    const onReadable = () => {
      if (out.readableLength <= 0) return;
      out.off('readable', onReadable);
      gotBytes = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ process: child, stream: out, kill, client });
    };
    out.on('readable', onReadable);

    child.stderr.on('data', (c) => {
      if (stderrChunks.length < 40) stderrChunks.push(c);
    });

    child.on('error', (err) => fail(err.code === 'ENOENT'
      ? `yt-dlp nao encontrado em "${config.ytdlp.path}"`
      : err.message));

    child.on('close', (code) => {
      if (gotBytes || child.killedByUs) return;
      const tail = stderrTail();
      const reason = /HTTP Error 403/i.test(tail) ? 'HTTP 403 na midia'
        : /Requested format is not available/i.test(tail) ? 'nenhum formato de audio disponivel'
          : /DRM/i.test(tail) ? 'video protegido por DRM'
            : `yt-dlp saiu com codigo ${code}`;
      fail(reason);
    });
  });
}

/**
 * Abre o audio tentando os clients de YOUTUBE_PLAYER_CLIENTS em ordem.
 * Devolve { process, stream, kill } — quem chama e responsavel por chamar kill().
 */
export async function openAudioStream(url) {
  const clients = config.ytdlp.playerClients.length ? config.ytdlp.playerClients : ['android'];
  const failures = [];

  for (const client of clients) {
    try {
      return await openWithClient(url, client);
    } catch (err) {
      failures.push(`${client}: ${err.message}`);
      log.warn(`player_client=${client} falhou (${err.message})${err.stderr ? ` | ${err.stderr.split('\n').pop()}` : ''}`);
    }
  }

  throw new YtDlpError(`nenhum client do YouTube conseguiu o audio — ${failures.join('; ')}`);
}
