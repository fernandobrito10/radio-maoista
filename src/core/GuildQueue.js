import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
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
  #responder = null;

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
      return this.connection;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // pode ser so um move de canal: espera reconectar antes de desistir
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log.info(`[${this.guild.name}] desconectado do canal de voz, encerrando sessao.`);
        this.destroy();
      }
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
    this.player.stop(true);
    return skipped;
  }

  // --------------------------------------------------------------- playback

  #wirePlayer() {
    this.player.on(AudioPlayerStatus.Playing, () => {
      this.#clearIdleTimer();
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

  async #advance() {
    if (this.destroyed || this.#advancing) return;
    this.#advancing = true;
    let failed = false;
    try {
      const next = this.#nextTrack();
      if (!next) {
        this.current = null;
        this.#scheduleIdleLeave('fila vazia');
        return;
      }
      this.current = next;
      await this.#playTrack(next);
    } catch (err) {
      failed = true;
      log.warn(`[${this.guild.name}] falha ao tocar: ${err.message}`);
      await this.#announce(errorEmbed(`Nao consegui tocar **${this.current?.title ?? 'a faixa'}**: ${err.message}`));
    } finally {
      this.#advancing = false;
    }

    if (!failed || this.destroyed) return;

    // faixa quebrada: descarta ela (nem repete, nem volta pro fim da fila) e tenta a proxima
    if (this.loop === LoopMode.TRACK) this.loop = LoopMode.OFF;
    this.current = null;
    if (this.tracks.length) {
      await this.#advance();
    } else {
      this.#scheduleIdleLeave('fila vazia');
    }
  }

  async #playTrack(track) {
    await ensurePlayable(track);
    this.#killStream();

    const source = await openAudioStream(track.url);
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
      throw new Error('o audio nao comecou a tocar (timeout do yt-dlp/ffmpeg).');
    }

    await this.#announce(nowPlayingEmbed(track, {
      volume: this.volume,
      loop: this.loop,
      queueSize: this.tracks.length,
    }));

    void scrobbler.nowPlaying(track, this.voiceChannel).catch(() => {});
    this.#startScrobbleWatch(track);
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
  }

  get hasPendingResponder() {
    return this.#responder !== null;
  }

  clearResponder() {
    this.#responder = null;
  }

  async #announce(embed) {
    const responder = this.#responder;
    this.#responder = null;
    if (responder) {
      try {
        await responder(embed);
        return;
      } catch (err) {
        log.debug(`Responder falhou, caindo pro canal de texto: ${err.message}`);
      }
    }
    if (!this.textChannel?.isTextBased?.()) return;
    try {
      await this.textChannel.send({ embeds: [embed] });
    } catch (err) {
      log.debug(`Nao consegui anunciar no canal de texto: ${err.message}`);
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

  scheduleLeaveIfAlone() {
    this.#scheduleIdleLeave('canal vazio');
  }

  cancelLeave() {
    if (this.current || this.tracks.length) this.#clearIdleTimer();
  }

  stop() {
    this.clear();
    this.loop = LoopMode.OFF;
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
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
