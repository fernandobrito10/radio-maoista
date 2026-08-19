import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { lastfm } from '../services/lastfm.js';
import { userStore } from '../services/userStore.js';
import { UserError } from '../utils/guards.js';
import { COLOR, errorEmbed, okEmbed } from '../utils/embeds.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('lastfm')
  .setDescription('Conecta sua conta do Last.fm e controla os scrobbles')
  .addSubcommand((s) => s
    .setName('link')
    .setDescription('Conecta sua conta do Last.fm ao bot'))
  .addSubcommand((s) => s
    .setName('unlink')
    .setDescription('Desconecta sua conta do Last.fm'))
  .addSubcommand((s) => s
    .setName('status')
    .setDescription('Mostra se sua conta esta conectada e se o scrobble esta ligado'))
  .addSubcommand((s) => s
    .setName('scrobble')
    .setDescription('Liga ou desliga o scrobble das musicas que tocarem')
    .addBooleanOption((o) => o
      .setName('ativo')
      .setDescription('true = scrobbla, false = para de scrobblar')
      .setRequired(true)));

function assertEnabled() {
  if (!lastfm.enabled) {
    throw new UserError('O Last.fm nao esta configurado nesse bot (falta `LASTFM_API_KEY` e `LASTFM_API_SECRET`).');
  }
}

export async function execute(interaction) {
  assertEnabled();
  const sub = interaction.options.getSubcommand();

  if (sub === 'link') return handleLink(interaction);
  if (sub === 'unlink') return handleUnlink(interaction);
  if (sub === 'status') return handleStatus(interaction);
  return handleScrobbleToggle(interaction);
}

async function handleLink(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const token = await lastfm.getToken();
  const authUrl = lastfm.authUrl(token);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Autorizar no Last.fm').setURL(authUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel('Ja autorizei').setCustomId('lastfm:confirm'),
  );

  const embed = okEmbed(
    [
      '**Conectando seu Last.fm em 2 passos:**',
      '1. Clique em **Autorizar no Last.fm** e confirme o acesso (precisa estar logado).',
      '2. Volte aqui e clique em **Ja autorizei**.',
      '',
      '_O link vale por alguns minutos e so voce ve essa mensagem._',
    ].join('\n'),
  ).setColor(COLOR).setTitle('🎵 Last.fm');

  const message = await interaction.editReply({ embeds: [embed], components: [row] });

  let click;
  try {
    click = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId === 'lastfm:confirm',
      time: 5 * 60 * 1000,
    });
  } catch {
    await interaction.editReply({
      embeds: [errorEmbed('Tempo esgotado. Roda `/lastfm link` de novo quando quiser.')],
      components: [],
    });
    return;
  }

  await click.deferUpdate();

  try {
    const session = await lastfm.getSession(token);
    if (!session.sessionKey) throw new Error('sem session key');

    await userStore.setLastfm(interaction.user.id, {
      name: session.name,
      sessionKey: session.sessionKey,
      scrobbling: true,
    });

    log.info(`Last.fm conectado: ${interaction.user.tag} -> ${session.name}`);
    await interaction.editReply({
      embeds: [okEmbed(
        `✅ Conectado como **[${session.name}](https://www.last.fm/user/${encodeURIComponent(session.name)})**.\n`
        + 'Scrobble **ligado**: tudo que tocar enquanto voce estiver no canal de voz vai pro seu perfil.\n'
        + 'Pra desligar depois: `/lastfm scrobble ativo:false`.',
      )],
      components: [],
    });
  } catch (err) {
    log.warn(`Falha no link do Last.fm (${interaction.user.tag}): ${err.message}`);
    await interaction.editReply({
      embeds: [errorEmbed(
        'Nao consegui confirmar a autorizacao. Abre o link, clica em **Yes, allow access** e tenta o botao de novo '
        + '(ou roda `/lastfm link` outra vez).',
      )],
      components: [],
    });
  }
}

async function handleUnlink(interaction) {
  const removed = await userStore.unlinkLastfm(interaction.user.id);
  await interaction.reply({
    embeds: [removed
      ? okEmbed('🔌 Desconectei sua conta do Last.fm. Nada mais sera scrobblado.')
      : errorEmbed('Voce nao tem nenhuma conta do Last.fm conectada.')],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction) {
  const link = await userStore.getLastfm(interaction.user.id);
  if (!link) {
    await interaction.reply({
      embeds: [errorEmbed('Sem conta conectada. Use `/lastfm link`.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = [
    `**Conta:** [${link.name}](https://www.last.fm/user/${encodeURIComponent(link.name)})`,
    `**Scrobble:** ${link.scrobbling ? '✅ ligado' : '⛔ desligado'}`,
  ];

  try {
    const info = await lastfm.userInfo(link.name);
    if (info?.playcount) lines.push(`**Scrobbles totais:** ${Number(info.playcount).toLocaleString('pt-BR')}`);
  } catch {
    // status do perfil e opcional
  }

  await interaction.reply({ embeds: [okEmbed(lines.join('\n'))], flags: MessageFlags.Ephemeral });
}

async function handleScrobbleToggle(interaction) {
  const active = interaction.options.getBoolean('ativo', true);
  const changed = await userStore.setScrobbling(interaction.user.id, active);
  await interaction.reply({
    embeds: [changed
      ? okEmbed(active
        ? '✅ Scrobble **ligado**. Vou registrar as musicas que tocarem enquanto voce estiver no canal.'
        : '⛔ Scrobble **desligado**. Sua conta continua conectada.')
      : errorEmbed('Voce precisa conectar sua conta primeiro com `/lastfm link`.')],
    flags: MessageFlags.Ephemeral,
  });
}
