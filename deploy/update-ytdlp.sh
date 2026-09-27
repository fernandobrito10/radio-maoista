#!/usr/bin/env bash
#
# Atualiza o yt-dlp usado pelo radio-maoista, com verificacao e rollback.
#
# Por que nao so "yt-dlp -U":
#   - detecta sozinho se a instalacao e pip (venv) ou binario standalone;
#   - confere o SHA-256 publicado antes de instalar (ja tivemos download truncado);
#   - testa se a versao nova EXTRAI de verdade, nao so se responde --version;
#   - volta para a versao anterior se o teste falhar;
#   - limpa sobras _MEI* do PyInstaller, que enchem o /tmp e quebram a extracao.
#
# Uso:
#   ./deploy/update-ytdlp.sh              atualiza se houver versao nova
#   ./deploy/update-ytdlp.sh --check      so informa se ha versao nova (nao instala)
#   ./deploy/update-ytdlp.sh --force      reinstala mesmo ja estando atualizado
#   ./deploy/update-ytdlp.sh --no-restart nao reinicia o bot
#   ./deploy/update-ytdlp.sh --quiet      so fala se algo mudar ou falhar (cron)
#
# Saidas: 0 = ok (atualizou ou ja estava em dia) | 1 = falhou | 2 = ha versao nova (--check)

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICO="${SERVICO:-radio-maoista}"
TESTE_BUSCA="${YTDLP_TEST_QUERY:-ytsearch1:test}"

CHECAR=0; FORCAR=0; REINICIAR=1; QUIETO=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECAR=1 ;;
    --force) FORCAR=1 ;;
    --no-restart) REINICIAR=0 ;;
    --quiet|-q) QUIETO=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opcao desconhecida: $arg" >&2; exit 1 ;;
  esac
done

log()  { [ "$QUIETO" -eq 1 ] || echo "$@"; }
aviso(){ echo "$@" >&2; }
erro() { echo "ERRO: $*" >&2; exit 1; }

# ------------------------------------------------- onde esta o yt-dlp do bot
# O bot resolve o binario por YTDLP_PATH no .env; o shell pode ver outro no PATH.
# Atualizar o do PATH e deixar o bot na versao velha ja aconteceu aqui.
BIN=""
if [ -f "$RAIZ/.env" ]; then
  BIN="$(grep -m1 '^YTDLP_PATH=' "$RAIZ/.env" | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
fi
[ -n "$BIN" ] || BIN="yt-dlp"
if [ "$BIN" = "yt-dlp" ] || [ "${BIN#/}" = "$BIN" ]; then
  BIN="$(command -v "$BIN" 2>/dev/null || true)"
fi
[ -n "$BIN" ] && [ -e "$BIN" ] || erro "nao achei o yt-dlp (YTDLP_PATH no .env ou no PATH)."

# ------------------------------------------------- pip (venv) ou standalone?
TIPO="binario"
if head -c2 "$BIN" 2>/dev/null | grep -q '#!'; then
  TIPO="pip"
fi
case "$BIN" in
  /usr/bin/*) [ "$TIPO" = "binario" ] && TIPO="apt" ;;
esac

versao_local() { "$BIN" --version 2>/dev/null | tail -1 || echo "desconhecida"; }

versao_publicada() {
  # o redirect de /releases/latest da a tag sem gastar cota da API do GitHub
  curl -fsSI -o /dev/null -w '%{url_effective}' \
    https://github.com/yt-dlp/yt-dlp/releases/latest 2>/dev/null | sed 's#.*/tag/##'
}

ANTES="$(versao_local)"
NOVA="$(versao_publicada || true)"
log "yt-dlp do bot : $BIN ($TIPO)"
log "versao atual  : $ANTES"
log "ultima publicada: ${NOVA:-nao consegui consultar}"

if [ "$TIPO" = "apt" ]; then
  aviso "Este yt-dlp veio do apt (/usr/bin), que fica MUITO atras e nao atualiza sozinho."
  aviso "Instale pelo pip num venv e aponte YTDLP_PATH pra ele:"
  aviso "  python3 -m venv ~/.venv-ytdlp && ~/.venv-ytdlp/bin/pip install -U yt-dlp"
  exit 1
fi

if [ -n "$NOVA" ] && [ "$ANTES" = "$NOVA" ] && [ "$FORCAR" -eq 0 ]; then
  log "ja esta na ultima versao."
  [ "$CHECAR" -eq 1 ] && exit 0
  PRECISA=0
else
  PRECISA=1
fi

if [ "$CHECAR" -eq 1 ]; then
  [ "$PRECISA" -eq 1 ] && { echo "ha versao nova: $ANTES -> $NOVA"; exit 2; }
  exit 0
fi

# --------------------------------------------------------------- faxina do tmp
# Sobras do PyInstaller de processos mortos a sinal. Um /tmp cheio faz a proxima
# execucao falhar com "decompression resulted in return code -1" (exit 255).
limpar_tmp() {
  local n=0
  for d in /tmp/_MEI* "${TMPDIR:-/tmp}"/radio-maoista-ytdlp/* ; do
    [ -e "$d" ] || continue
    # so o que nao foi tocado na ultima hora: nunca apaga extracao em uso
    if [ -z "$(find "$d" -maxdepth 0 -mmin -60 2>/dev/null)" ]; then
      rm -rf "$d" 2>/dev/null && n=$((n+1))
    fi
  done
  [ "$n" -gt 0 ] && log "limpei $n sobra(s) de extracao em /tmp"
  return 0
}
limpar_tmp

# --------------------------------------------------- teste funcional de verdade
# --version so prova que o binario abre. O que quebrou na pratica foi a EXTRACAO
# (o YouTube mudou o formato da pagina e a versao velha devolvia zero itens).
testar() {
  local alvo="$1"
  "$alvo" --ignore-config --no-warnings --flat-playlist --print "%(id)s" \
    --playlist-end 1 "$TESTE_BUSCA" 2>/dev/null | grep -qE '^[A-Za-z0-9_-]{5,}$'
}

# ------------------------------------------------------------------ atualizar
if [ "$PRECISA" -eq 0 ]; then
  log "nada a instalar."
else
  if [ "$TIPO" = "pip" ]; then
    PIP="$(dirname "$BIN")/pip"
    [ -x "$PIP" ] || erro "nao achei o pip do venv em $PIP"
    log "atualizando via pip..."
    "$PIP" install -q -U yt-dlp || erro "pip falhou."
  else
    case "$(uname -m)" in
      x86_64)  ASSET="yt-dlp_linux" ;;
      aarch64) ASSET="yt-dlp_linux_aarch64" ;;
      *) erro "sem binario standalone para $(uname -m); use a instalacao por pip." ;;
    esac

    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    log "baixando $ASSET..."
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ASSET" -o "$TMP/yt-dlp" \
      || erro "download falhou."

    log "conferindo o SHA-256 publicado..."
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" -o "$TMP/SUMS" \
      || erro "nao consegui baixar os checksums."
    ESPERADO="$(awk -v f="$ASSET" '$2 == f { print $1 }' "$TMP/SUMS")"
    [ -n "$ESPERADO" ] || erro "checksum de $ASSET nao encontrado na release."
    echo "$ESPERADO  $TMP/yt-dlp" | sha256sum -c - >/dev/null 2>&1 \
      || erro "checksum NAO confere - download corrompido, nada foi instalado."
    chmod +x "$TMP/yt-dlp"

    log "testando a versao nova antes de instalar..."
    testar "$TMP/yt-dlp" || erro "a versao nova nao conseguiu extrair nada - nada foi instalado."

    SUDO=""
    [ -w "$BIN" ] || SUDO="sudo"
    $SUDO cp -f "$BIN" "$BIN.anterior" 2>/dev/null || true
    $SUDO cp -f "$TMP/yt-dlp" "$BIN" || erro "nao consegui escrever em $BIN"
    log "instalado (backup da versao anterior em $BIN.anterior)"
  fi
fi

DEPOIS="$(versao_local)"

# ------------------------------------------------------- validacao pos-install
if ! testar "$BIN"; then
  aviso "A versao instalada ($DEPOIS) NAO conseguiu extrair."
  if [ "$TIPO" = "binario" ] && [ -e "$BIN.anterior" ]; then
    aviso "voltando para a versao anterior..."
    SUDO=""; [ -w "$BIN" ] || SUDO="sudo"
    $SUDO cp -f "$BIN.anterior" "$BIN"
    aviso "rollback feito: $(versao_local)"
  fi
  exit 1
fi

if [ "$ANTES" = "$DEPOIS" ]; then
  log "versao inalterada ($DEPOIS), extracao funcionando."
  exit 0
fi

echo "yt-dlp atualizado: $ANTES -> $DEPOIS (extracao testada)"

# ------------------------------------------------------------------ reiniciar
if [ "$REINICIAR" -eq 1 ]; then
  if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${SERVICO}.service"; then
    sudo systemctl restart "$SERVICO" && echo "servico $SERVICO reiniciado."
  elif pgrep -f 'src/index.js' >/dev/null 2>&1; then
    aviso "o bot esta rodando solto (sem systemd): reinicie na mao pra usar a versao nova."
  fi
fi
