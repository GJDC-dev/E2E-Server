#!/usr/bin/env bash
#
# Installeert (of werkt bij, of verwijdert) de GJDC E2E-Server op een node.
#
#   sudo ./install/install.sh --dashboard https://testing.gjdc.nl --token gjdcreg_...
#   sudo ./install/install.sh --update
#   sudo ./install/install.sh --uninstall [--purge]
#
# Voor Ubuntu 22.04, 24.04 en 26.04 en Debian 12. Draai het vanuit een checkout
# van de repository; het kopieert zichzelf naar /opt/gjdc-e2e-server.

set -euo pipefail

APP_DIR=/opt/gjdc-e2e-server
CONF_DIR=/etc/gjdc-e2e-server
CONF_FILE=$CONF_DIR/agent.env
DATA_DIR_DEFAULT=/var/lib/gjdc-e2e-server
SERVICE=gjdc-e2e-server
SERVICE_FILE=/etc/systemd/system/$SERVICE.service
RUN_USER=gjdc-e2e
BIN_LINK=/usr/local/bin/e2e-server
NODE_MAJOR_MIN=20
NODE_MAJOR_INSTALL=22

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mode=install
dashboard=""
token=""
name=""
labels=""
max_jobs=""
cache_mb=""
browsers="chromium"
skip_deps=0
no_start=0
purge=0
force_register=0

usage() {
  cat <<'HELP'
GJDC E2E-Server installeren

  sudo ./install/install.sh --dashboard URL --token TOKEN [opties]

Opties bij installeren:
  --dashboard URL     adres van het dashboard, bijv. https://testing.gjdc.nl
  --token TOKEN       registratietoken (Nodes → Node toevoegen in het dashboard)
  --name NAAM         naam van deze node (standaard: de hostnaam)
  --labels A,B        labels, bijv. zolder,chromium
  --max-jobs N        runs tegelijk (standaard 1)
  --cache-mb N        maximale cache in MB (standaard 4096)
  --browsers "..."    browsers waarvoor systeembibliotheken nodig zijn
                      (standaard "chromium"; bijv. "chromium firefox webkit")
  --skip-deps         geen Node.js en systeembibliotheken installeren
  --no-start          de dienst niet starten
  --force-register    opnieuw aanmelden, ook als deze node al aangemeld is

Andere taken:
  --update            software bijwerken vanuit deze map en de dienst herstarten
  --uninstall         dienst en software verwijderen (data blijft staan)
  --purge             met --uninstall: ook data en instellingen verwijderen
  -h, --help          deze hulp
HELP
}

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dashboard) dashboard="${2:-}"; shift 2 ;;
    --token) token="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --labels) labels="${2:-}"; shift 2 ;;
    --max-jobs) max_jobs="${2:-}"; shift 2 ;;
    --cache-mb) cache_mb="${2:-}"; shift 2 ;;
    --browsers) browsers="${2:-}"; shift 2 ;;
    --skip-deps) skip_deps=1; shift ;;
    --no-start) no_start=1; shift ;;
    --force-register) force_register=1; shift ;;
    --update) mode=update; shift ;;
    --uninstall) mode=uninstall; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Onbekende optie: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Draai dit script als root (sudo)."
command -v systemctl >/dev/null || die "systemd is nodig (systemctl niet gevonden)."

# ── Hulpjes ────────────────────────────────────────────────────────────────

node_major() {
  if command -v node >/dev/null; then
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# Het volledige pad van node: systemd gebruikt geen PATH van een login-shell.
node_bin() {
  readlink -f "$(command -v node)"
}

ensure_node() {
  local major
  major=$(node_major)
  if (( major >= NODE_MAJOR_MIN )); then
    ok "Node.js $(node -v) is aanwezig ($(node_bin))."
    check_node_access
    return
  fi
  (( skip_deps )) && die "Node.js $NODE_MAJOR_MIN of nieuwer is nodig (gevonden: $(node -v 2>/dev/null || echo geen)). Installeer het, of laat --skip-deps weg."
  command -v apt-get >/dev/null || die "Node.js $NODE_MAJOR_MIN+ ontbreekt en dit is geen apt-systeem. Installeer Node.js zelf en draai dit script met --skip-deps."
  say "Node.js $NODE_MAJOR_INSTALL installeren (NodeSource)…"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_INSTALL}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  (( $(node_major) >= NODE_MAJOR_MIN )) || die "Node.js installeren is mislukt."
  ok "Node.js $(node -v) geïnstalleerd."
}

# Node in een thuismap (nvm) kan de dienstgebruiker niet starten.
check_node_access() {
  local bin
  bin=$(node_bin)
  case "$bin" in
    /root/*|/home/*) die "Node.js staat in $bin; de gebruiker $RUN_USER kan daar niet bij. Installeer Node.js systeembreed (bijv. via NodeSource), of laat dit script dat doen." ;;
  esac
}

ensure_user() {
  if id "$RUN_USER" >/dev/null 2>&1; then
    return
  fi
  say "Systeemgebruiker $RUN_USER aanmaken…"
  useradd --system --home-dir "$DATA_DIR_DEFAULT" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
}

copy_app() {
  say "Software naar $APP_DIR kopiëren…"
  local tmp="$APP_DIR.new"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # Alleen wat de agent nodig heeft; geen .git, geen tests.
  tar -C "$SRC_DIR" --exclude=.git --exclude=node_modules --exclude=test \
      -cf - bin src reporter install examples package.json README.md 2>/dev/null | tar -C "$tmp" -xf -
  chmod 755 "$tmp/bin/e2e-server.mjs"
  chown -R root:root "$tmp"
  rm -rf "$APP_DIR.old"
  [[ -d $APP_DIR ]] && mv "$APP_DIR" "$APP_DIR.old"
  mv "$tmp" "$APP_DIR"
  rm -rf "$APP_DIR.old"
  ln -sfn "$APP_DIR/bin/e2e-server.mjs" "$BIN_LINK"
  ok "Software staat in $APP_DIR (versie $(node -p "require('$APP_DIR/package.json').version"))."
}

# Zet KEY=waarde in agent.env: vervangt een bestaande regel, of voegt hem toe.
set_conf() {
  local key=$1 value=$2
  [[ -z $value ]] && return
  if grep -qE "^#?\s*$key=" "$CONF_FILE"; then
    local escaped
    escaped=$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')
    sed -i -E "s|^#?\s*$key=.*|$key=$escaped|" "$CONF_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$CONF_FILE"
  fi
}

conf_value() {
  grep -E "^$1=" "$CONF_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

write_config() {
  mkdir -p "$CONF_DIR"
  if [[ ! -f $CONF_FILE ]]; then
    say "Instellingen aanmaken in $CONF_FILE…"
    cp "$SRC_DIR/install/agent.env.example" "$CONF_FILE"
  fi
  set_conf DASHBOARD_URL "${dashboard%/}"
  set_conf NODE_NAME "$name"
  set_conf NODE_LABELS "$labels"
  set_conf MAX_JOBS "$max_jobs"
  set_conf CACHE_MAX_MB "$cache_mb"
  chown root:"$RUN_USER" "$CONF_DIR" "$CONF_FILE"
  chmod 750 "$CONF_DIR"
  chmod 640 "$CONF_FILE"

  local url
  url=$(conf_value DASHBOARD_URL)
  [[ -n $url ]] || die "Geef het adres van het dashboard op: --dashboard https://testing.gjdc.nl"
}

data_dir() {
  local d
  d=$(conf_value DATA_DIR)
  echo "${d:-$DATA_DIR_DEFAULT}"
}

prepare_data() {
  local d
  d=$(data_dir)
  mkdir -p "$d"
  chown "$RUN_USER":"$RUN_USER" "$d"
  chmod 750 "$d"
  if [[ $d != "$DATA_DIR_DEFAULT" ]]; then
    warn "DATA_DIR is $d: zet dat pad ook bij ReadWritePaths in $SERVICE_FILE, anders mag de dienst er niet schrijven."
  fi
}

install_browser_deps() {
  (( skip_deps )) && return
  command -v apt-get >/dev/null || { warn "Geen apt: installeer de systeembibliotheken voor de browsers zelf (npx playwright install-deps)."; return; }
  say "Systeembibliotheken voor $browsers installeren (kan een paar minuten duren)…"
  # install-deps hoort bij Playwright zelf; de nieuwste versie kent de
  # pakketnamen van de nieuwste Ubuntu/Debian.
  # shellcheck disable=SC2086
  if HOME=/root npx --yes playwright@latest install-deps $browsers >/tmp/gjdc-e2e-deps.log 2>&1; then
    ok "Systeembibliotheken voor de browsers staan klaar."
  else
    warn "install-deps is niet helemaal gelukt (zie /tmp/gjdc-e2e-deps.log). De agent werkt, maar een browser start misschien niet; 'e2e-server doctor' laat zien wat er mist."
  fi
}

install_service() {
  say "Dienst $SERVICE installeren…"
  local d
  d=$(data_dir)
  sed -e "s|/var/lib/gjdc-e2e-server|$d|g" -e "s|@NODE@|$(node_bin)|g" "$SRC_DIR/install/$SERVICE.service" > "$SERVICE_FILE"
  chmod 644 "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
}

as_agent() {
  local d
  d=$(data_dir)
  # Schone omgeving, zoals systemd hem ook geeft.
  ( cd "$d" && runuser -u "$RUN_USER" -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      HOME="$d" LANG=C.UTF-8 E2E_SERVER_CONFIG="$CONF_FILE" "$(node_bin)" "$APP_DIR/bin/e2e-server.mjs" "$@" )
}

register_node() {
  local d
  d=$(data_dir)
  if [[ -f $d/state.json ]] && grep -q '"token"' "$d/state.json" && (( ! force_register )); then
    ok "Deze node is al aangemeld; aanmelden overgeslagen (opnieuw: --force-register --token …)."
    return
  fi
  if [[ -z $token ]]; then
    warn "Geen --token opgegeven: de node is nog niet aangemeld. Doe dat later met:"
    warn "  sudo -u $RUN_USER e2e-server register --token gjdcreg_… && sudo systemctl restart $SERVICE"
    return
  fi
  say "Aanmelden bij $(conf_value DASHBOARD_URL)…"
  local extra=()
  (( force_register )) && extra+=(--force)
  as_agent register --token "$token" "${extra[@]}" || die "Aanmelden mislukt (zie hierboven). Klopt het token, en is het dashboard bereikbaar?"
  ok "Aangemeld."
}

start_service() {
  if (( no_start )); then
    say "Niet gestart (--no-start). Starten met: sudo systemctl start $SERVICE"
    return
  fi
  systemctl restart "$SERVICE"
  sleep 2
  if systemctl is-active --quiet "$SERVICE"; then
    ok "Dienst $SERVICE draait. Meekijken: journalctl -u $SERVICE -f"
  else
    warn "De dienst draait niet. Kijk wat er mis is met: journalctl -u $SERVICE -e"
    exit 1
  fi
}

# ── Taken ──────────────────────────────────────────────────────────────────

case "$mode" in
  install)
    say "GJDC E2E-Server installeren"
    ensure_node
    ensure_user
    copy_app
    write_config
    prepare_data
    install_browser_deps
    install_service
    register_node
    start_service
    as_agent doctor || warn "doctor vond iets om naar te kijken (zie hierboven)."
    ok "Klaar. De node staat binnen een paar seconden in het dashboard."
    ;;

  update)
    [[ -d $APP_DIR ]] || die "Nog niet geïnstalleerd. Gebruik --dashboard en --token."
    say "GJDC E2E-Server bijwerken"
    ensure_node
    copy_app
    install_service
    systemctl restart "$SERVICE"
    ok "Bijgewerkt en herstart. Een lopende run is teruggezet in de wachtrij."
    ;;

  uninstall)
    say "GJDC E2E-Server verwijderen"
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE" "$BIN_LINK"
    systemctl daemon-reload
    rm -rf "$APP_DIR"
    if (( purge )); then
      rm -rf "$(data_dir)" "$CONF_DIR"
      userdel "$RUN_USER" >/dev/null 2>&1 || true
      ok "Alles verwijderd, ook de data en de instellingen."
    else
      ok "Dienst en software verwijderd. Data staat nog in $(data_dir), instellingen in $CONF_DIR (weg met --purge)."
    fi
    warn "Verwijder de node ook in het dashboard (Nodes → node → Meer → Verwijderen)."
    ;;
esac
