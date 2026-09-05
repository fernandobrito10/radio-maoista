import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {
  ChannelType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  OAuth2Scopes,
  PermissionsBitField,
  Status,
} from 'discord.js';
import { assertDiscordConfig, config, features, logGateway } from './config.js';
import { manager } from './core/PlayerManager.js';
import { loadCommands } from './loadCommands.js';
import { checkAvailable } from './services/ytdlp.js';
import { errorEmbed } from './utils/embeds.js';
import { UserError } from './utils/guards.js';
import { log } from './utils/logger.js';

// prism-media/@discordjs/voice acham o ffmpeg por essa env var
if (ffmpegPath && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ffmpegPath;

try {
  assertDiscordConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.commands = new Collection();

for (const command of await loadCommands()) {
  client.commands.set(command.name, command);
}
log.info(`Comandos carregados: ${[...client.commands.keys()].map((c) => `/${c}`).join(', ')}`);

// ---------------------------------------------------------------- interacoes

// Erros que significam "a interacao morreu", nao bug nosso: nao vale stack trace.
const DEAD_INTERACTION = new Set([
  10062, // Unknown interaction (token de 3s expirou)
  40060, // Interaction has already been acknowledged
  10008, // Unknown message (resposta ja apagada)
]);

const INTERACTION_TOKEN_MS = 3_000;

client.on(Events.InteractionCreate, async (interaction) => {
  // Autocomplete tem token curto e chega uma vez por tecla: responde e sai.
  if (interaction.isAutocomplete()) {
    const handler = client.commands.get(interaction.commandName)?.autocomplete;
    if (!handler) return;
    try {
      await handler(interaction);
    } catch (err) {
      if (!DEAD_INTERACTION.has(err.code)) {
        log.debug(`autocomplete /${interaction.commandName}: ${err.message}`);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  // O Discord invalida o token 3s depois de criar a interacao. Se ela chegou
  // atrasada (gateway reconectando, rede caindo, processo travado), qualquer
  // resposta falha com 10062 — melhor registrar o atraso do que tentar e explodir.
  const ageMs = Date.now() - interaction.createdTimestamp;
  if (ageMs >= INTERACTION_TOKEN_MS) {
    log.warn(`/${interaction.commandName} descartado: a interacao chegou ${ageMs}ms depois de criada `
      + `(o token vale ${INTERACTION_TOKEN_MS}ms). Gateway reconectando, rede instavel ou processo travado.`);
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Esse bot so funciona dentro de um servidor.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    if (DEAD_INTERACTION.has(err.code)) {
      const age = Date.now() - interaction.createdTimestamp;
      log.warn(`/${interaction.commandName}: a interacao expirou antes da resposta `
        + `(${err.code} ${err.rawError?.message ?? ''}, idade ${age}ms). Nao ha o que responder.`);
      return;
    }

    const isUserError = err instanceof UserError;
    if (isUserError) log.debug(`/${interaction.commandName}: ${err.message}`);
    else log.error(`Erro em /${interaction.commandName}:`, err);

    const embed = errorEmbed(isUserError
      ? err.message
      : `Deu ruim executando \`/${interaction.commandName}\`: ${err.message ?? 'erro desconhecido'}`);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [embed], components: [] });
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      log.debug(`Nao consegui responder a interacao: ${replyErr.message}`);
    }
  }
});

// ------------------------------------------------------------- estado de voz

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild?.id ?? newState.guild?.id;
  const queue = manager.get(guildId);
  if (!queue || queue.destroyed) return;

  // bot foi arrastado/expulso do canal
  if (oldState.id === client.user.id) {
    if (!newState.channelId) {
      queue.destroy();
      return;
    }
    if (newState.channel?.type === ChannelType.GuildVoice || newState.channel?.type === ChannelType.GuildStageVoice) {
      queue.voiceChannel = newState.channel;
    }
  }

  const channel = queue.voiceChannel;
  if (!channel) return;

  const humans = channel.members.filter((m) => !m.user.bot).size;
  queue.setAlone(humans === 0);
});

// ------------------------------------------------------------ saude do gateway
// Sem isso, uma reconexao passa invisivel e reaparece como "Unknown interaction":
// no resume o Discord reenvia os eventos perdidos, e interacoes de antes da queda
// chegam com o token de 3s ja vencido. O contador de eventos reenviados denuncia.

client.on(Events.ShardDisconnect, (event, id) => {
  log.warn(`shard ${id} desconectou (codigo ${event?.code ?? '?'}); tentando reconectar`);
});

client.on(Events.ShardReconnecting, (id) => {
  log.warn(`shard ${id} reconectando ao gateway`);
});

client.on(Events.ShardResume, (id, replayedEvents) => {
  log.warn(`shard ${id} retomou a sessao com ${replayedEvents} evento(s) reenviados`
    + `${replayedEvents > 0 ? ' — interacoes nesse lote podem chegar expiradas' : ''}`);
});

client.on(Events.ShardError, (err, id) => {
  log.warn(`shard ${id} erro de websocket: ${err.message}`);
});

client.on(Events.ShardReady, (id) => {
  // ping so existe depois do primeiro heartbeat com ACK; no ready ainda e -1
  const ping = client.ws.ping;
  log.info(`shard ${id} pronto${ping >= 0 ? ` (ping ${ping}ms)` : ''}`);
});

client.on(Events.Warn, (message) => log.warn(`discord.js: ${message}`));
client.on(Events.Error, (err) => log.error('discord.js:', err));

// LOG_GATEWAY=1: mostra so as linhas que explicam uma reconexao. Se os heartbeats
// saem e nenhum ACK volta, o problema esta no caminho do websocket, nao no bot.
if (logGateway) {
  const RELEVANT = /heartbeat|hello|resum|identif|session|invalid|clos|zombie|reconnect|ready/i;
  client.on(Events.Debug, (message) => {
    if (RELEVANT.test(message)) log.info(`gateway: ${String(message).replace(/\s+/g, ' ').trim()}`);
  });
}

// Se o event loop travar mais que o intervalo de heartbeat (~41s), o Discord
// derruba a conexao. Este watchdog separa "nosso processo travou" de "a rede caiu".
const LAG_TICK_MS = 5_000;
let lastTick = Date.now();
const lagWatchdog = setInterval(() => {
  const drift = Date.now() - lastTick - LAG_TICK_MS;
  lastTick = Date.now();
  if (drift > 1_000) log.warn(`event loop travou ${drift}ms (acima de ~41s o gateway derruba a conexao)`);
}, LAG_TICK_MS);
lagWatchdog.unref();

// ----------------------------------------------------- liveness / anti-zumbi
// Close codes fatais (4004 token, 4013/4014 intents) fazem o shard desistir de
// reconectar — e o processo continua vivo por causa dos timers. Pro Docker o
// container esta "Up"; pra quem usa, o bot sumiu. Aqui o arquivo de liveness so
// e tocado com o shard Ready, e depois de 5min sem gateway o processo sai.
const LIVENESS_FILE = process.env.LIVENESS_FILE
  || path.join(os.tmpdir(), 'radio-maoista-alive');
const LIVENESS_TICK_MS = 30_000;
const MAX_OFFLINE_MS = 5 * 60_000;
let offlineSince = null;

const livenessWatchdog = setInterval(() => {
  if (client.ws.status === Status.Ready) {
    offlineSince = null;
    writeFile(LIVENESS_FILE, String(Date.now())).catch((err) => {
      log.debug(`nao consegui escrever o arquivo de liveness: ${err.message}`);
    });
    return;
  }

  offlineSince ??= Date.now();
  const offlineMs = Date.now() - offlineSince;
  if (offlineMs >= MAX_OFFLINE_MS) {
    log.error(`gateway fora do ar ha ${Math.round(offlineMs / 1000)}s (status ${client.ws.status}); `
      + 'encerrando pro supervisor reiniciar.');
    manager.destroyAll();
    process.exit(1);
  }
}, LIVENESS_TICK_MS);
livenessWatchdog.unref();

// ------------------------------------------------------------------- startup

client.once(Events.ClientReady, async (ready) => {
  log.info(`Conectado como ${ready.user.tag} em ${ready.guilds.cache.size} servidor(es).`);
  log.info(`Integracoes: Spotify ${features.spotify ? 'ON' : 'OFF'} | Last.fm ${features.lastfm ? 'ON' : 'OFF'}`);

  try {
    const version = await checkAvailable();
    log.info(`yt-dlp ${version} encontrado.`);
  } catch (err) {
    log.error(`yt-dlp indisponivel: ${err.message}`);
    log.error('Sem yt-dlp o bot nao toca nada. Instale e/ou ajuste YTDLP_PATH no .env.');
  }

  const invite = ready.user.client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
    ],
  });
  log.info(`Link de convite: ${invite}`);

  ready.user.setPresence({ activities: [{ name: '/play' }], status: 'online' });
});

// --------------------------------------------------------------- encerramento

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Recebi ${signal}, encerrando...`);
  manager.destroyAll();
  client.destroy().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Um processo que sobrevive a uma excecao nao tratada fica com estado meio
// destruido: online pro Docker, mudo pra quem usa. Com restart: unless-stopped,
// morrer e reiniciar limpo e o comportamento correto.
process.on('uncaughtException', (err) => {
  log.error('Excecao nao tratada, encerrando pro supervisor reiniciar:', err);
  try {
    manager.destroyAll();
  } catch {
    // ja estamos caindo
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Promise rejeitada sem catch, encerrando pro supervisor reiniciar:', reason);
  try {
    manager.destroyAll();
  } catch {
    // ja estamos caindo
  }
  process.exit(1);
});

try {
  await client.login(config.discord.token);
} catch (err) {
  if (err.code === 'TokenInvalid') {
    log.error('O Discord recusou o token. Gere um novo em: Developer Portal > sua aplicacao > aba Bot > Reset Token.');
  } else {
    log.error('Nao consegui conectar no Discord:', err);
  }
  process.exit(1);
}
