#!/bin/sh
set -eu

# O YouTube quebra extratores com frequencia; a correcao vem por update do yt-dlp.
# Como o container costuma ficar meses de pe, atualiza a cada boot.
if [ "${YTDLP_AUTO_UPDATE:-1}" = "1" ]; then
  echo "[entrypoint] atualizando yt-dlp (YTDLP_AUTO_UPDATE=0 desliga)"
  if ! yt-dlp -U; then
    echo "[entrypoint] update falhou (offline?); seguindo com a versao da imagem"
  fi
fi

if [ "${DEPLOY_COMMANDS_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] registrando slash commands"
  if ! node src/deploy-commands.js; then
    echo "[entrypoint] deploy falhou; subindo o bot de qualquer forma"
  fi
fi

exec "$@"
