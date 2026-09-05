import 'dotenv/config';

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
  },
  spotify: {
    clientId: str('SPOTIFY_CLIENT_ID'),
    clientSecret: str('SPOTIFY_CLIENT_SECRET'),
    market: str('SPOTIFY_MARKET', 'BR'),
  },
  lastfm: {
    apiKey: str('LASTFM_API_KEY'),
    apiSecret: str('LASTFM_API_SECRET'),
  },
  ytdlp: {
    path: str('YTDLP_PATH', 'yt-dlp'),
    cookiesFromBrowser: str('YTDLP_COOKIES_FROM_BROWSER'),
    cookiesFile: str('YTDLP_COOKIES_FILE'),
    extraArgs: str('YTDLP_EXTRA_ARGS').split(' ').filter(Boolean),
    // Teto de banda por faixa. O audio precisa de ~25 KB/s; sem teto o yt-dlp
    // baixa na velocidade maxima do link e satura a conexao a cada musica.
    limitRate: str('YTDLP_LIMIT_RATE', '128K'),
    // Teto de processos yt-dlp simultaneos para busca/metadados (streams nao contam)
    maxConcurrent: int('YTDLP_MAX_CONCURRENT', 2),
    // Clients do YouTube tentados em ordem ate um entregar audio de verdade.
    // O padrao do yt-dlp (android_vr) anda devolvendo 403 na midia; "android" funciona.
    playerClients: str('YTDLP_PLAYER_CLIENTS', 'android,default')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  },
  autocomplete: {
    // Cada tecla digitada gera uma interacao; o debounce evita uma busca por tecla.
    // debounce + busca precisa caber nos 3s de validade do token da interacao.
    debounceMs: int('AUTOCOMPLETE_DEBOUNCE', 300),
    results: Math.min(24, int('AUTOCOMPLETE_RESULTS', 8)),
    searchTimeoutMs: int('AUTOCOMPLETE_TIMEOUT', 1500),
    // Esquenta a busca do yt-dlp em background enquanto a pessoa escolhe.
    // Desligue (0) se a CPU do Pi sofrer: o /play volta a buscar na hora.
    prefetch: str('AUTOCOMPLETE_PREFETCH', '1') !== '0',
  },
  player: {
    defaultVolume: Math.min(100, Math.max(0, int('DEFAULT_VOLUME', 70))),
    idleTimeoutMs: int('IDLE_TIMEOUT', 180) * 1000,
    maxQueueSize: int('MAX_QUEUE_SIZE', 1000),
  },
};

/** LOG_GATEWAY=1 mostra heartbeat/resume/close do websocket (diagnostico de reconexao). */
export const logGateway = str('LOG_GATEWAY', '0') === '1';

export const features = {
  get spotify() {
    return Boolean(config.spotify.clientId && config.spotify.clientSecret);
  },
  get lastfm() {
    return Boolean(config.lastfm.apiKey && config.lastfm.apiSecret);
  },
};

/**
 * Bot token do Discord tem 3 partes separadas por ponto (id.timestamp.hmac), ~70 chars.
 * Client Secret (32 chars, sem ponto) e Public Key (64 hex) sao confundidos com ele o tempo todo.
 */
export function looksLikeBotToken(token) {
  return /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(String(token ?? ''));
}

export function assertDiscordConfig() {
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) {
    throw new Error(`Variaveis de ambiente faltando: ${missing.join(', ')}. Copie .env.example para .env e preencha.`);
  }

  if (!looksLikeBotToken(config.discord.token)) {
    throw new Error(
      `DISCORD_TOKEN nao tem o formato de um bot token (recebi ${config.discord.token.length} caracteres, `
      + 'esperado ~70 em 3 partes separadas por ponto).\n'
      + '  Provavel troca de campo: Client Secret tem 32 chars e Public Key tem 64 hex — nenhum dos dois serve.\n'
      + '  Pegue o certo em: Developer Portal > sua aplicacao > aba Bot > Reset Token (o Discord mostra uma unica vez).',
    );
  }
}
