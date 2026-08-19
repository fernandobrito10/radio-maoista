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
} from 'discord.js';
import { assertDiscordConfig, config, features } from './config.js';
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

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
  if (humans === 0) queue.scheduleLeaveIfAlone();
  else queue.cancelLeave();
});

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
process.on('unhandledRejection', (reason) => log.error('Promise rejeitada sem catch:', reason));
process.on('uncaughtException', (err) => log.error('Excecao nao tratada:', err));

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
