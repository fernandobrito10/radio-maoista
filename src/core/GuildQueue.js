import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { config } from '../config.js';
import { openAudioStream } from '../services/ytdlp.js';
import { scrobbleThresholdMs, scrobbler } from '../services/scrobbler.js';
import { ensurePlayable } from './resolver.js';
import { errorEmbed, nowPlayingEmbed } from '../utils/embeds.js';
import { log } from '../utils/logger.js';

export const LoopMode = { OFF: 'off', TRACK: 'track', QUEUE: 'queue' };

/** Depois de N falhas seguidas para tudo: com 1000 faixas quebradas seriam 1000 mensagens. */
const MAX_FAILURE_STREAK = 5;

/** Carregamento abortado por skip/stop/destroy - nao e erro, nao merece aviso. */
class PlaybackCancelled extends Error {
  constructor() {
    super('carregamento cancelado');
    this.name = 'PlaybackCancelled';
  }
}

/** Traduz o estado onde a conexao de voz travou na causa mais provavel. */
function connectionTimeoutHint(status) {
  if (status === VoiceConnectionStatus.Signalling) {
    return 'O Discord nao respondeu com o servidor de voz. Normalmente e a permissao de Conectar no canal '
      + 'ou o intent GuildVoiceStates desligado.';
  }
  if (status === VoiceConnectionStatus.Connecting) {
    return 'O handshake de voz nao fechou. Quase sempre e UDP de saida bloqueado — firewall do Windows '
      + 'barrando o node.exe, VPN ou rede corporativa.';
  }
  return 'Nao consegui entrar no canal de voz (timeout).';
}

export class GuildQueue {
  #idleTimer = null;
  #scrobbleTimer = null;
  #advancing = false;
  #advanceRequested = false;
  #responder = null;
  /** Mensagem do ultimo "tocando agora", pra apagar quando a proxima faixa entrar. */
  #lastNowPlaying = null;
  /** Muda a cada faixa; carregamento com geracao velha e descartado. */
  #generation = 0;
  #failureStreak = 0;
  /** Canal sem humanos: o relogio de saida nao pode ser zerado por troca de faixa. */
  #alone = false;

  constructor({ guild, voiceChannel, textChannel, onDestroy }) {
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.onDestroy = onDestroy;

    this.tracks = [];
    this.history = [];
    this.current = null;
    this.volume = config.player.defaultVolume;
    this.loop = LoopMode.OFF;
    this.destroyed = false;

    this.connection = null;
    this.resource = null;
    this.ytProcess = null;
    this.playbackStartedAt = 0;
    this.scrobbled = false;

    this.player = createAudioPlayer({
      behaviors: { noSubscriberBehavior: NoSubscriberBehavior.Pause, maxMissedFrames: 50 },
    });
    this.#wirePlayer();
  }

  // ---------------------------------------------------------------- conexao

  async connect(voiceChannel = this.voiceChannel) {
    this.voiceChannel = voiceChannel;

    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (this.connection.joinConfig.channelId !== voiceChannel.id) {
        this.connection.rejoin({ channelId: voiceChannel.id, selfDeaf: true, selfMute: false });
      }
      // A conexao pode estar em Signalling/Connecting depois de um blip. Devolver
      // sem esperar fazia o bot "tocar" com os frames indo pro vazio.
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        this.destroy();
        throw new Error('a conexao de voz nao voltou a ficar pronta a tempo.');
      }
      return this.connection;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
      const closeCode = newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
        ? newState.closeCode
        : null;

      // 4014 = kickado/movido ou canal apagado. Pode voltar sozinho num move.
      if (closeCode === 4014) {
        try {
          await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        } catch {
          log.info(`[${this.guild.name}] removido do canal de voz, encerrando sessao.`);
          this.destroy();
        }
        return;
      }

      // 4006 (sessao de voz invalidada) e o modo de falha classico de bot 24/7.
      // Antes caia no catch generico e destruia a fila inteira de madrugada.
      if (connection.rejoinAttempts < 5) {
        const espera = (connection.rejoinAttempts + 1) * 3_000;
        log.warn(`[${this.guild.name}] voz caiu (codigo ${closeCode ?? 'sem codigo'}), `
          + `tentativa ${connection.rejoinAttempts + 1}/5 em ${espera}ms`);
        await new Promise((resolve) => setTimeout(resolve, espera));
        if (this.destroyed || connection.state.status === VoiceConnectionStatus.Destroyed) return;
        connection.rejoin();
        return;
      }

      log.info(`[${this.guild.name}] nao consegui reconectar a voz em 5 tentativas, encerrando.`);
      this.destroy();
    });

    connection.on('error', (err) => log.warn(`[${this.guild.name}] erro na conexao de voz: ${err.message}`));

    connection.on('stateChange', (oldState, newState) => {
      log.debug(`[voz ${this.guild.name}] ${oldState.status} -> ${newState.status}`);
    });

    connection.subscribe(this.player);
    this.connection = connection;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      // em qual etapa travou diz qual e a causa
      const stalledAt = connection.state.status;
      this.destroy();
      throw new Error(`${connectionTimeoutHint(stalledAt)} (a conexao travou em "${stalledAt}")`);
    }
    return connection;
  }

  // ------------------------------------------------------------------- fila

  get size() {
    return this.tracks.length;
  }

  get isPlaying() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  get isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused
      || this.player.state.status === AudioPlayerStatus.AutoPaused;
  }

  get positionMs() {
    return this.resource?.playbackDuration ?? 0;
  }

  add(tracks, { next = false } = {}) {
    const room = Math.max(0, config.player.maxQueueSize - this.tracks.length);
    const accepted = tracks.slice(0, room);
    if (next) this.tracks.unshift(...accepted);
    else this.tracks.push(...accepted);
    return accepted.length;
  }

  remove(index) {
    if (index < 1 || index > this.tracks.length) return null;
    return this.tracks.splice(index - 1, 1)[0] ?? null;
  }

  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    return this.tracks.length;
  }

  clear() {
    const removed = this.tracks.length;
    this.tracks = [];
    return removed;
  }

  setLoop(mode) {
    this.loop = mode;
    return this.loop;
  }

  setVolume(percent) {
    this.volume = Math.min(100, Math.max(0, Math.round(percent)));
    this.resource?.volume?.setVolume(this.volume / 100);
    return this.volume;
  }

  pause() {
    if (!this.isPlaying) return false;
    return this.player.pause(true);
  }

  resume() {
    if (!this.isPaused) return false;
    return this.player.unpause();
  }

  skip() {
    const skipped = this.current;
    // Invalida o carregamento em voo. Sem isto, um /skip nos ~3s entre "faixa
    // escolhida" e "audio tocando" nao fazia nada: player.stop() num player Idle
    // devolve false, e a faixa supostamente pulada comecava a tocar logo depois.
    this.#generation += 1;
    this.#killStream();
    if (!this.player.stop(true)) {
      // nada tocando ainda: o evento Idle nao vem, entao avanca na mao
      this.current = null;
      void this.#advance();
    }
    return skipped;
  }

  // --------------------------------------------------------------- playback

  #wirePlayer() {
    this.player.on(AudioPlayerStatus.Playing, () => {
      // Se o canal esta vazio o relogio continua correndo: senao cada faixa nova
      // zerava a contagem e o bot tocava a madrugada inteira pra ninguem.
      if (!this.#alone) this.#clearIdleTimer();
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.#finishCurrent();
      void this.#advance();
    });

    this.player.on('error', (err) => {
      log.error(`[${this.guild.name}] erro no player (${this.current?.title ?? '?'}): ${err.message}`);
      void this.#announce(errorEmbed(`Erro tocando **${this.current?.title ?? 'faixa'}**, pulando.`));
      this.#finishCurrent();
      void this.#advance();
    });
  }

  async start() {
    if (this.current || this.isPlaying || this.isPaused) return;
    await this.#advance();
  }

  #nextTrack() {
    if (this.loop === LoopMode.TRACK && this.current) return this.current;
    if (this.loop === LoopMode.QUEUE && this.current) this.tracks.push(this.current);
    return this.tracks.shift() ?? null;
  }

  /**
   * Laco (nao recursao) de avanco da fila. Reentrancia vira pedido, nao chamada
   * aninhada - antes, uma fila inteira de faixas quebradas empilhava um frame
   * async e uma mensagem no canal por faixa.
   */
  async #advance() {
    if (this.destroyed) return;
    if (this.#advancing) {
      this.#advanceRequested = true;
      return;
    }

    this.#advancing = true;
    try {
      do {
        this.#advanceRequested = false;

        const next = this.#nextTrack();
        if (!next) {
          this.current = null;
          this.#scheduleIdleLeave('fila vazia');
          return;
        }

        this.current = next;
        try {
          await this.#playTrack(next);
          this.#failureStreak = 0;
          return;
        } catch (err) {
          // quem cancelou (skip/stop/destroy) decide o proximo passo
          if (err instanceof PlaybackCancelled) return;

          this.#failureStreak += 1;
          log.warn(`[${this.guild.name}] falha ao tocar (${this.#failureStreak}): ${err.message}`);
          if (this.loop === LoopMode.TRACK) this.loop = LoopMode.OFF;
          this.current = null;

          if (this.#failureStreak >= MAX_FAILURE_STREAK) {
            const descartadas = this.clear();
            this.#failureStreak = 0;
            await this.#announce(errorEmbed(
              `${MAX_FAILURE_STREAK} faixas seguidas falharam - ultimo erro: ${err.message}`
              + `\nParei por aqui e descartei ${descartadas} faixa(s) da fila. `
              + 'Costuma ser yt-dlp desatualizado ou bloqueio do YouTube.',
            ));
            this.#scheduleIdleLeave('falhas seguidas');
            return;
          }

          await this.#announce(errorEmbed(`Nao consegui tocar **${next.title}**: ${err.message}`));
          if (!this.tracks.length) {
            this.#scheduleIdleLeave('fila vazia');
            return;
          }
          this.#advanceRequested = true;
        }
      } while (this.#advanceRequested && !this.destroyed);
    } finally {
      this.#advancing = false;
    }
  }

  async #playTrack(track) {
    // Cada await abaixo e uma janela em que /skip, /stop ou destroy() podem chegar.
    // Sem esta checagem o bot seguia carregando faixa ja cancelada, deixava o
    // yt-dlp baixando ate 25s depois do /stop e ainda anunciava erro fantasma.
    const generation = ++this.#generation;
    const stillValid = () => !this.destroyed && generation === this.#generation;

    await ensurePlayable(track);
    if (!stillValid()) throw new PlaybackCancelled();

    this.#killStream();

    const source = await openAudioStream(track.url);
    if (!stillValid()) {
      source.kill();
      throw new PlaybackCancelled();
    }
    this.ytProcess = source;

    const resource = createAudioResource(source.stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
      metadata: track,
    });
    resource.volume?.setVolume(this.volume / 100);

    this.resource = resource;
    this.playbackStartedAt = Date.now();
    this.scrobbled = false;

    this.player.play(resource);

    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 25_000);
    } catch {
      source.kill();
      if (!stillValid()) throw new PlaybackCancelled();
      throw new Error('o audio nao comecou a tocar (timeout do yt-dlp/ffmpeg).');
    }

    if (!stillValid()) {
      source.kill();
      throw new PlaybackCancelled();
    }

    await this.#announce(nowPlayingEmbed(track, {
      volume: this.volume,
      loop: this.loop,
      queueSize: this.tracks.length,
    }), { nowPlaying: true });

    void scrobbler.nowPlaying(track, this.voiceChannel).catch(() => {});
    this.#startScrobbleWatch(track);
    this.#prefetchNext();
  }

  /**
   * Resolve a URL da proxima faixa enquanto a atual toca. Sem isso, faixas vindas
   * do Spotify pagam uma busca no YouTube (~2s) na troca de musica.
   */
  #prefetchNext() {
    const next = this.tracks[0];
    if (!next || next.url) return;
    void ensurePlayable(next)
      .then(() => log.debug(`[${this.guild.name}] prefetch pronto: ${next.title}`))
      .catch((err) => log.debug(`[${this.guild.name}] prefetch falhou (${next.title}): ${err.message}`));
  }

  #startScrobbleWatch(track) {
    this.#stopScrobbleWatch();
    if (!scrobbler.enabled) return;

    const threshold = scrobbleThresholdMs(track.durationMs);
    if (!Number.isFinite(threshold)) return;

    this.#scrobbleTimer = setInterval(() => {
      if (this.scrobbled || this.current !== track) {
        this.#stopScrobbleWatch();
        return;
      }
      if (this.positionMs >= threshold) {
        this.scrobbled = true;
        this.#stopScrobbleWatch();
        void scrobbler.scrobble(track, this.voiceChannel, this.playbackStartedAt).catch(() => {});
      }
    }, 5_000);
  }

  #stopScrobbleWatch() {
    if (this.#scrobbleTimer) clearInterval(this.#scrobbleTimer);
    this.#scrobbleTimer = null;
  }

  #finishCurrent() {
    this.#stopScrobbleWatch();
    this.#killStream();
    if (this.current) {
      this.history.unshift(this.current);
      if (this.history.length > 25) this.history.length = 25;
    }
    this.resource = null;
  }

  #killStream() {
    if (this.ytProcess) {
      try {
        this.ytProcess.kill();
      } catch {
        // processo ja morreu
      }
      this.ytProcess = null;
    }
  }

  // ------------------------------------------------------------- utilidades

  /**
   * Faz o proximo anuncio ir na resposta de uma interacao (evita mensagem duplicada
   * quando o /play ja comeca a tocar). Consumido uma unica vez.
   */
  useResponder(fn) {
    this.#responder = fn;
    return fn;
  }

  get hasPendingResponder() {
    return this.#responder !== null;
  }

  /** O responder pendente e este? Evita um /play consumir a resposta de outro. */
  isResponder(fn) {
    return this.#responder === fn && fn != null;
  }

  clearResponder() {
    this.#responder = null;
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.nowPlaying] marca o anuncio como "tocando agora", que
   *   substitui o anterior em vez de empilhar. Erros ficam no canal de proposito.
   */
  async #announce(embed, { nowPlaying = false } = {}) {
    const responder = this.#responder;
    this.#responder = null;

    if (responder) {
      try {
        const message = await responder(embed);
        if (nowPlaying) await this.#replaceNowPlaying(message);
        return;
      } catch (err) {
        log.debug(`Responder falhou, caindo pro canal de texto: ${err.message}`);
      }
    }

    if (!this.textChannel?.isTextBased?.()) return;
    try {
      const message = await this.textChannel.send({ embeds: [embed] });
      if (nowPlaying) await this.#replaceNowPlaying(message);
    } catch (err) {
      log.debug(`Nao consegui anunciar no canal de texto: ${err.message}`);
    }
  }

  /**
   * Mantem um unico "tocando agora" no canal: o novo entra e o anterior sai.
   * Numa playlist longa, um embed por faixa virava uma parede de mensagens.
   *
   * Apaga DEPOIS de postar o novo, pra nao existir um instante sem nada no canal.
   * Falha e so debug: a mensagem pode ter sido apagada na mao, ter mais de 14 dias,
   * ou o bot ter perdido acesso ao canal — nada disso justifica atrapalhar a musica.
   */
  async #replaceNowPlaying(message) {
    const anterior = this.#lastNowPlaying;
    this.#lastNowPlaying = message ?? null;

    if (!anterior || anterior.id === message?.id) return;
    try {
      await anterior.delete();
    } catch (err) {
      log.debug(`nao consegui apagar o "tocando agora" anterior: ${err.message}`);
    }
  }

  #clearIdleTimer() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #scheduleIdleLeave(reason) {
    this.#clearIdleTimer();
    if (config.player.idleTimeoutMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      log.info(`[${this.guild.name}] saindo do canal (${reason}).`);
      void this.#announce(errorEmbed('Fila vazia, saindo do canal de voz.').setColor(0x666666));
      this.destroy();
    }, config.player.idleTimeoutMs);
  }

  /**
   * Chamado a cada evento de voz do servidor. So reage a MUDANCA de estado -
   * antes, qualquer pessoa entrando em qualquer canal reiniciava a contagem e o
   * bot nunca saia de um canal vazio num servidor movimentado.
   */
  setAlone(alone) {
    if (alone === this.#alone) return;
    this.#alone = alone;
    if (alone) this.#scheduleIdleLeave('canal vazio');
    else this.#clearIdleTimer();
  }

  cancelLeave() {
    if (this.#alone) return;
    this.#clearIdleTimer();
  }

  stop() {
    this.clear();
    this.loop = LoopMode.OFF;
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.#generation += 1;
    this.#clearIdleTimer();
    this.#stopScrobbleWatch();
    this.tracks = [];
    this.current = null;
    try {
      this.player.stop(true);
    } catch {
      // player ja parado
    }
    this.#killStream();
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        this.connection.destroy();
      } catch {
        // conexao ja destruida
      }
    }
    this.connection = null;
    this.onDestroy?.(this);
  }
}
