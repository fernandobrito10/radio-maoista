import ffmpegPath from 'ffmpeg-static';
import { config, features, looksLikeBotToken } from './config.js';
import { checkAvailable } from './services/ytdlp.js';
import { lastfm } from './services/lastfm.js';
import { spotify } from './services/spotify.js';

const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => console.log(`  FAIL ${msg}`);
const skip = (msg) => console.log(`  --   ${msg}`);

console.log('\nradio-maoista :: diagnostico\n');

console.log('Discord');
if (!config.discord.token) {
  bad('DISCORD_TOKEN faltando');
} else if (!looksLikeBotToken(config.discord.token)) {
  bad(`DISCORD_TOKEN com formato errado (${config.discord.token.length} chars, sem as 3 partes separadas por ponto)`);
  console.log('       Client Secret (32 chars) e Public Key (64 hex) nao servem. Use: Portal > aba Bot > Reset Token.');
} else {
  ok('DISCORD_TOKEN com formato de bot token');
}
config.discord.clientId ? ok('DISCORD_CLIENT_ID definido') : bad('DISCORD_CLIENT_ID faltando');
config.discord.guildId ? ok(`DISCORD_GUILD_ID = ${config.discord.guildId} (comandos por servidor)`) : skip('DISCORD_GUILD_ID vazio (comandos globais)');

console.log('\nAudio');
if (ffmpegPath) ok(`ffmpeg em ${ffmpegPath}`);
else bad('ffmpeg-static nao resolveu um caminho');

try {
  const version = await checkAvailable();
  ok(`yt-dlp ${version} (${config.ytdlp.path})`);
} catch (err) {
  bad(`yt-dlp: ${err.message}`);
}

const { search, openAudioStream } = await import('./services/ytdlp.js');

let probeUrl = null;
try {
  const results = await search('test tone 440hz', 1);
  if (results.length) {
    probeUrl = results[0].url;
    ok(`busca no YouTube funcionando (${results[0].title})`);
  } else {
    bad('busca no YouTube nao retornou nada');
  }
} catch (err) {
  bad(`busca no YouTube: ${err.message}`);
}

// buscar funciona mesmo quando o download da midia da 403 — testa o stream de verdade
if (probeUrl) {
  try {
    const source = await openAudioStream(probeUrl);
    source.kill();
    ok(`stream de audio abriu (player_client=${source.client})`);
  } catch (err) {
    bad(`stream de audio: ${err.message}`);
    console.log('       Tente atualizar o yt-dlp (yt-dlp -U) ou trocar YTDLP_PLAYER_CLIENTS no .env.');
  }
}

console.log('\nSpotify');
if (!features.spotify) {
  skip('desativado (sem SPOTIFY_CLIENT_ID/SECRET)');
} else {
  try {
    await spotify.getTrack('11dFghVXANMlKmJXsNCbNl');
    ok('credenciais validas');
  } catch (err) {
    bad(`Spotify: ${err.message}`);
  }
}

console.log('\nLast.fm');
if (!features.lastfm) {
  skip('desativado (sem LASTFM_API_KEY/SECRET)');
} else {
  // auth.getToken passa mesmo com secret errado; track.scrobble nao. Melhor pegar aqui.
  if (config.lastfm.apiKey === config.lastfm.apiSecret) {
    bad('LASTFM_API_KEY e LASTFM_API_SECRET tem o mesmo valor — sao campos diferentes');
    console.log('       Pegue os dois em https://www.last.fm/api/accounts (API key e Shared secret).');
  }
  try {
    const token = await lastfm.getToken();
    ok(`API respondendo (token de teste ${token.slice(0, 8)}...)`);
  } catch (err) {
    bad(`Last.fm: ${err.message}`);
  }
}

console.log('');
