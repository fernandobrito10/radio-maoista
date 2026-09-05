# syntax=docker/dockerfile:1

# ============================================================ 1. dependencias
# @discordjs/opus resolve o binario com node-pre-gyp --fallback-to-build: se nao
# houver prebuild pra arquitetura do Pi, ele COMPILA. O toolchain fica so aqui,
# fora da imagem final. O ffmpeg-static baixa no postinstall o binario da
# arquitetura alvo (publica linux arm64 e arm, alem de x64).
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ======================================================= 2. binarios externos
# yt-dlp: build standalone (PyInstaller), dispensa Python na imagem final. Existe
# pra arm64 e x86_64; NAO existe mais pra armv7 — nesse caso a imagem final cai
# no pip (veja o estagio 3).
# deno: o yt-dlp usa pra resolver os "JS challenges" do YouTube. Tambem nao tem
# build armv7, e ai o yt-dlp usa um interpretador proprio, mais fragil.
FROM debian:bookworm-slim AS tools

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p /out; \
    touch /out/.keep; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) ytdlp='yt-dlp_linux_aarch64'; deno='deno-aarch64-unknown-linux-gnu' ;; \
      amd64) ytdlp='yt-dlp_linux';         deno='deno-x86_64-unknown-linux-gnu' ;; \
      *)     ytdlp='';                     deno='' ;; \
    esac; \
    if [ -n "$ytdlp" ]; then \
      curl -fsSL -o /out/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlp}"; \
      curl -fsSL -o /tmp/SUMS "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"; \
      esperado="$(awk -v f="$ytdlp" '$2 == f { print $1 }' /tmp/SUMS)"; \
      [ -n "$esperado" ] || { echo "checksum de $ytdlp nao encontrado" >&2; exit 1; }; \
      echo "$esperado  /out/yt-dlp" | sha256sum -c -; \
      chmod +x /out/yt-dlp; \
    else \
      echo "sem build standalone de yt-dlp para $arch: a imagem final instala via pip"; \
    fi; \
    if [ -n "$deno" ]; then \
      curl -fsSL -o /tmp/deno.zip "https://github.com/denoland/deno/releases/latest/download/${deno}.zip"; \
      curl -fsSL -o /tmp/deno.sha "https://github.com/denoland/deno/releases/latest/download/${deno}.zip.sha256sum"; \
      echo "$(awk '{ print $1 }' /tmp/deno.sha)  /tmp/deno.zip" | sha256sum -c -; \
      unzip -q /tmp/deno.zip -d /out; \
      chmod +x /out/deno; \
      rm /tmp/deno.zip; \
    else \
      echo "sem build de deno para $arch: yt-dlp usara o interpretador de JS interno"; \
    fi; \
    ls -l /out

# ============================================================== 3. runtime
FROM node:22-bookworm-slim

# O ffmpeg vem do ffmpeg-static (dentro de node_modules) e o src/index.js aponta
# FFMPEG_PATH pra ele automaticamente. Pra usar o do sistema, descomente as duas
# linhas abaixo (custa ~150 MB de imagem):
# RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
#  && rm -rf /var/lib/apt/lists/*
# ENV FFMPEG_PATH=/usr/bin/ffmpeg

ENV NODE_ENV=production \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    LIVENESS_FILE=/tmp/alive \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=tools /out/ /usr/local/bin/

# Arquitetura sem binario standalone (armv7 e afins): instala o yt-dlp via pip,
# que aterrissa no mesmo /usr/local/bin/yt-dlp.
RUN set -eux; \
    if [ ! -x /usr/local/bin/yt-dlp ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends python3 python3-pip; \
      pip3 install --break-system-packages --no-cache-dir yt-dlp; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    yt-dlp --version

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# data/ guarda as session keys do Last.fm; o yt-dlp -U reescreve o proprio
# binario no boot, entao ele precisa pertencer ao usuario que roda o bot.
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app/data \
 && chown node:node /usr/local/bin/yt-dlp

USER node

# "Processo vivo" nao e o mesmo que "bot funcionando": com o gateway morto por
# token/intent invalido o Node continua de pe. O arquivo de liveness so e tocado
# enquanto o shard esta Ready, entao o healthcheck enxerga o zumbi.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const{statSync}=require('node:fs');const m=statSync(process.env.LIVENESS_FILE).mtimeMs;process.exit(Date.now()-m<180000?0:1)"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]
