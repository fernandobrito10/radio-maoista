# radio-maoista 📻

Bot de música para Discord: toca do **YouTube**, aceita link do **Spotify** (faixa, álbum, playlist e artista — resolvendo o equivalente no YouTube pra tocar) e faz **scrobble no Last.fm** pra quem linkar a conta.

- **Node.js** + **discord.js v14** + **@discordjs/voice**
- **yt-dlp** para o áudio, **ffmpeg** (via `ffmpeg-static`) para transcodificar
- **Spotify Web API** (Client Credentials) só para metadados
- Fila por servidor, loop, shuffle, volume

---

## 1. Pré-requisitos

| O quê | Como instalar |
| --- | --- |
| Node.js 20.10+ | https://nodejs.org (você já tem v22) |
| yt-dlp | `winget install yt-dlp.yt-dlp` — ou `scoop install yt-dlp`, ou baixar o `.exe` e apontar `YTDLP_PATH` |
| ffmpeg | já vem via `ffmpeg-static` (npm), não precisa instalar nada |

Depois de instalar o yt-dlp, confirme com `yt-dlp --version` num terminal novo.
Vale manter atualizado (`yt-dlp -U`): quando o YouTube muda algo, a correção vem por aí.

## 2. Credenciais

### Discord (obrigatório)
1. https://discord.com/developers/applications → **New Application**
2. **Bot** → *Reset Token* → copia pra `DISCORD_TOKEN`
3. **General Information** → *Application ID* → `DISCORD_CLIENT_ID`
4. Não precisa de nenhum *Privileged Intent* (o bot usa só `Guilds` + `GuildVoiceStates`)
5. Convida o bot com as permissões: `Ver canal`, `Enviar mensagens`, `Inserir links`, `Conectar`, `Falar` — o link exato é impresso no log quando o bot sobe

### Spotify (opcional, só pra links do Spotify)
https://developer.spotify.com/dashboard → **Create app** → copia *Client ID* e *Client Secret*.
Não precisa de redirect URI: o bot usa Client Credentials, que só lê metadados públicos.

### Last.fm (opcional, só pro scrobble)
https://www.last.fm/api/account/create → copia *API key* e *Shared secret*.
Callback URL pode ficar em branco: o fluxo é o de desktop (token + autorização no navegador).

## 3. Instalação

```bash
npm install
cp .env.example .env    # no PowerShell: Copy-Item .env.example .env
# preenche o .env
npm run doctor          # confere token, yt-dlp, ffmpeg, Spotify e Last.fm
npm run deploy          # registra os slash commands
npm start
```

Durante o desenvolvimento, deixe `DISCORD_GUILD_ID` preenchido: os comandos aparecem
instantaneamente no seu servidor. Vazio = registro global (leva alguns minutos).
`npm run dev` reinicia o bot a cada alteração de arquivo.

## 4. Comandos

| Comando | O que faz |
| --- | --- |
| `/play <busca> [agora]` | Nome da música (com sugestões enquanto digita), link do YouTube (vídeo ou playlist) ou link do Spotify (faixa/álbum/playlist/artista). `agora: true` coloca no topo da fila |
| `/pause` · `/resume` | Pausa e retoma |
| `/skip [quantidade]` | Pula a atual (ou N faixas de uma vez) |
| `/stop` | Limpa a fila e sai do canal |
| `/queue [pagina]` | Fila paginada, com duração total e quem pediu cada faixa |
| `/nowplaying` | Faixa atual com barra de progresso |
| `/volume [nivel]` | Sem argumento mostra o volume; com argumento ajusta (0–100) |
| `/loop [modo]` | `off` / `faixa` / `fila`. Sem argumento, cicla entre os três |
| `/shuffle` | Embaralha a fila (não mexe na faixa que está tocando) |
| `/lastfm link` | Conecta sua conta do Last.fm (botão de autorizar + confirmar) |
| `/lastfm status` | Mostra a conta conectada e se o scrobble está ligado |
| `/lastfm scrobble ativo:<bool>` | Liga/desliga o scrobble sem desconectar a conta |
| `/lastfm unlink` | Remove sua conta do bot |

## 5. Como funciona

### Spotify → YouTube
O Spotify não libera streaming de áudio por API, então o bot usa a API só como **catálogo**:
lê artista/título/álbum/duração e enfileira a faixa **sem resolver o YouTube ainda**.
A busca no YouTube acontece na hora de tocar (`ensurePlayable`), com cache em memória.
Ou seja: uma playlist de 300 faixas entra na fila em segundos, sem 300 buscas de uma vez.

Os metadados exibidos e scrobblados continuam sendo os do Spotify (limpos),
mesmo que o vídeo do YouTube se chame "ARTISTA - MÚSICA (Official Video) [HD]".

### Áudio
`yt-dlp -o -` escreve o áudio no stdout; esse stream vai pro `createAudioResource`
com `inlineVolume`, e o ffmpeg do `ffmpeg-static` converte pra Opus.
Nada é gravado em disco. Ao pular/parar, o processo do yt-dlp é morto na hora.

**Sobre o `player_client`:** o YouTube devolve `HTTP 403` na mídia para vários dos
clients que o yt-dlp usa por padrão (hoje o `android_vr`) porque falta um *PO token*.
Por isso o bot força `player_client=android`, que entrega áudio de forma confiável —
inclusive em vídeos com DRM. O preço é que esse client só expõe o formato **18**
(MP4 360p muxado, AAC ~96kbps): baixa vídeo junto, mas o ffmpeg descarta o vídeo na
transcodificação, então o custo é só banda (~200kbps em vez de ~130).

`YTDLP_PLAYER_CLIENTS` aceita uma lista em ordem de tentativa (padrão `android,default`).
O bot só considera um client bem-sucedido **quando os primeiros bytes de áudio chegam** —
um 403, que o yt-dlp só descobre depois de extrair a página, faz cair automaticamente
para o próximo da lista. Quando o YouTube quebrar o `android`, é uma linha no `.env`.

Quer áudio Opus de verdade (audio-only, ~130kbps)? Preencha `YTDLP_COOKIES_FROM_BROWSER`
e ponha `default` na frente da lista: com sessão autenticada os formatos audio-only
voltam a funcionar.

### Autocomplete e latencia
Buscar video no yt-dlp durante a digitacao e impossivel: a busca leva ~2,5s (sendo
**1,1s so de startup do processo**) e o token de uma interacao do Discord vale 3s.
Medido nesta maquina, `ytsearch1` e `ytsearch8` custam o mesmo — o gargalo e o
startup, nao a quantidade de resultados.

Por isso o `/play` usa duas camadas:
1. **Sugestao** — endpoint de sugestao do YouTube (~350ms, ~700 bytes por consulta).
   Devolve texto, nao video. A primeira opcao da lista e sempre o que voce digitou.
   O `AUTOCOMPLETE_DEBOUNCE` garante uma consulta por *pausa* na digitacao, nao por tecla.
2. **Prefetch** — junto da sugestao, o yt-dlp busca a query em background e guarda no
   cache. Quando voce da enter, o `/play` acha pronto: medido em **1ms** contra ~2300ms
   sem cache. Se voce apertar enter no meio do prefetch, o `/play` espera a *mesma*
   busca em vez de subir um segundo yt-dlp.

A fila tambem faz prefetch da proxima faixa enquanto a atual toca, o que tira a busca
do caminho critico na troca de musica (importa em playlist do Spotify, onde cada faixa
precisa ser resolvida no YouTube).

### Banda
Duas medicoes explicam o consumo: o unico formato que baixa sem cookies e o **18**
(202kbps, video 360p junto), contra 143kbps do opus audio-only — que hoje da 403 em
*todos* os clients sem sessao autenticada.

O que mais pesava, porem, era a **falta de teto de taxa**: sem `--limit-rate` o yt-dlp
baixa na velocidade maxima do link, e cada musica comecava saturando a conexao.
`YTDLP_LIMIT_RATE=128K` (1 Mbps) da 5x de folga sobre os 202kbps necessarios e acaba
com os picos. Para cair de vez pra 143kbps sem video, preencha `YTDLP_COOKIES_FROM_BROWSER`.

### Scrobble (Last.fm)
- Cada usuário conecta sua própria conta; a *session key* fica em `data/users.json`
- Quando uma faixa começa, o bot manda `track.updateNowPlaying` para **todos os usuários
  linkados que estão no canal de voz** naquele momento
- O `track.scrobble` sai quando a faixa passa de **metade da duração ou 4 minutos**
  (o que vier primeiro), seguindo as regras do Last.fm — faixas com menos de 30s nunca scrobblam
- O tempo contado é o de áudio realmente tocado (`resource.playbackDuration`), então
  pausa não conta e pular no meio não gera scrobble
- Para faixas vindas do Spotify, artista/título/álbum são exatos. Para vídeos do YouTube,
  o bot limpa o título (`(Official Video)`, `[HD]`, `| Lyrics`…) e separa em `Artista - Música`;
  se não conseguir, usa o nome do canal como artista

## 6. Estrutura

```
src/
  index.js               cliente, eventos, tratamento de erro, shutdown
  deploy-commands.js     registra os slash commands
  doctor.js              diagnóstico das integrações
  config.js              .env tipado + flags de feature
  commands/              um arquivo por comando (data + execute)
  core/
    GuildQueue.js        fila, conexão de voz, playback, loop, scrobble timer
    PlayerManager.js     uma GuildQueue por servidor
    resolver.js          texto/link -> tracks; Spotify -> YouTube (lazy)
  services/
    ytdlp.js             wrapper do yt-dlp (busca, metadados, stream)
    spotify.js           Client Credentials + faixa/álbum/playlist/artista
    lastfm.js            assinatura MD5, auth, nowPlaying, scrobble
    scrobbler.js         quem está ouvindo + regras de scrobble
    userStore.js         data/users.json (escrita atômica)
  utils/                 embeds, formatação, guards, parser de título, log
```

Adicionar um comando novo = criar `src/commands/nome.js` exportando `data`
(um `SlashCommandBuilder`) e `execute(interaction)`, e rodar `npm run deploy`.
Erros lançados como `UserError` viram mensagem amigável e efêmera automaticamente.

## 7. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| `yt-dlp indisponível` no log | não instalado ou fora do PATH → ajuste `YTDLP_PATH` |
| `HTTP Error 403: Forbidden` no yt-dlp | client do YouTube sem PO token → o bot já tenta a lista de `YTDLP_PLAYER_CLIENTS` em ordem; se todos falharem, rode `yt-dlp -U` e tente `YTDLP_PLAYER_CLIENTS=android,default,tv_embedded,mweb` |
| `This video is DRM protected` | vídeo protegido nesse client específico; o `android` costuma passar. Se o log mostra isso em *todos* os clients, o vídeo não é tocável — deixe o bot cair na próxima faixa |
| `Sign in to confirm you're not a bot` | YouTube pedindo cookies → preencha `YTDLP_COOKIES_FROM_BROWSER=chrome` (feche o navegador antes) ou exporte um `cookies.txt` em `YTDLP_COOKIES_FILE` |
| Entra no canal mas sai som nenhum | falta permissão de *Falar*, ou o canal é um *Stage* sem o bot como speaker |
| Playlist do Spotify dá 404 | playlists **editoriais/algorítmicas** (Discover Weekly, Top 50…) são bloqueadas pela API para apps novos; playlists de usuário funcionam |
| `Unknown interaction` (10062) no log | a interação chegou depois dos 3s de validade do token → o bot descarta e registra o atraso em ms. Se vier junto de `shard N retomou a sessão com X evento(s) reenviados`, foi queda de rede/gateway: os eventos atrasados são reenviados no resume |
| Comandos não aparecem | rode `npm run deploy`; global demora, use `DISCORD_GUILD_ID` |
| Scrobble não aparece no perfil | precisa passar de metade da faixa, estar no canal de voz e com `/lastfm status` mostrando *ligado* |
| Faixa começa e morre em ~30s | yt-dlp desatualizado → `yt-dlp -U` |

`LOG_LEVEL=debug` no `.env` mostra cada chamada do yt-dlp e cada resolução Spotify→YouTube.

## 8. Docker / Raspberry Pi

```bash
# no Pi, dentro da pasta do projeto (com o .env já preenchido)
mkdir -p data
docker compose build
docker compose run --rm bot npm run doctor    # confere tudo dentro do container
docker compose run --rm bot npm run deploy    # registra os slash commands (uma vez)
docker compose up -d
docker compose logs -f
```

**Use Pi OS 64 bits.** Em `arm64` a imagem pega o yt-dlp standalone e o deno
(que o yt-dlp usa pra resolver os *JS challenges* do YouTube). Em `armv7` nenhum
dos dois existe: o Dockerfile cai no `pip install yt-dlp` e o yt-dlp fica com o
interpretador de JS interno, que quebra mais fácil. Funciona, mas é o caminho ruim.

**Como a imagem é montada** (multi-stage, pra não carregar toolchain na final):
1. `deps` — instala as dependências com `python3/make/g++` disponíveis, porque o
   `@discordjs/opus` compila quando não há prebuild pra arquitetura
2. `tools` — baixa yt-dlp e deno conforme a arquitetura
3. `runtime` — só node_modules + `src/`, rodando como usuário `node`

**Persistência:** `./data` é bind-mountado em `/app/data` e guarda as *session keys*
do Last.fm. Se der erro de permissão, o dono precisa ser o uid 1000:
`sudo chown -R 1000:1000 data`.

**Atualizações:** o entrypoint roda `yt-dlp -U` a cada boot — é o que conserta as
quebras do YouTube sem rebuild. Desligue com `YTDLP_AUTO_UPDATE=0`. Para atualizar o
bot em si: `git pull && docker compose up -d --build`.

**Rede:** o bot é só saída (nada de `EXPOSE`), mas voz precisa de **UDP de saída**.
A bridge padrão do Docker resolve via NAT; se a voz travar em `connecting`, teste com
`network_mode: host` pra descartar o NAT.

**ffmpeg:** vem do `ffmpeg-static` dentro de `node_modules` (arm64 e arm publicados),
economizando ~150 MB. Se ele falhar na sua arquitetura, descomente as duas linhas de
`ffmpeg` no [Dockerfile](Dockerfile) pra usar o do apt.

O `init: true` do compose existe porque o bot spawna um `yt-dlp` por faixa: garante
que o `SIGTERM` chegue e que não sobre processo zumbi.

## 9. Notas

- `data/users.json` guarda *session keys* do Last.fm — é credencial de usuário, já está no `.gitignore`. Não commite.
- O bot sai do canal depois de `IDLE_TIMEOUT` segundos (padrão 180) com a fila vazia ou o canal vazio.
- Volume é por servidor e aplicado ao vivo, sem reiniciar a faixa.
- Uma fila por servidor; o bot toca em um canal de voz por servidor de cada vez.
