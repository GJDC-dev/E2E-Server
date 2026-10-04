# GJDC E2E-Server

De software op de testnodes (mini-pc's) van GJDC. Een node meldt zich aan bij
het testdashboard ([E2E-Dashboard](https://github.com/GJDC-dev/E2E-Dashboard),
`testing.gjdc.nl`), vraagt om werk, draait Playwright-testpakketten en stuurt
voortgang, uitvoer, testresultaten en rapporten terug.

- **Alleen uitgaand verkeer.** De node praat via HTTPS met het dashboard; hij hoeft niet bereikbaar te zijn en er hoeft geen poort open.
- **Geen dubbele downloads.** Testpakketten (ZIP's) worden op sha256 bewaard. Een versie die de node al heeft, haalt hij niet opnieuw op; `node_modules` worden hergebruikt zolang `package.json` en de lockfile gelijk blijven; browsers worden één keer per Playwright-versie geïnstalleerd. Een nieuwe versie haalt een node die niets te doen heeft al vooraf op.
- **Live inzicht.** CPU, geheugen, schijf, netwerk en temperatuur, wat de node doet en wat hij gedaan heeft: allemaal zichtbaar in het dashboard.
- **Geen afhankelijkheden.** Alleen Node.js 20+; de agent gebruikt niets buiten de standaardbibliotheek.

## Installeren

Op Ubuntu 22.04, 24.04 of 26.04, of Debian 12:

```bash
git clone https://github.com/GJDC-dev/E2E-Server.git
cd E2E-Server
sudo ./install/install.sh --dashboard https://testing.gjdc.nl --token gjdcreg_… --name "$(hostname)"
```

Het registratietoken maak je in het dashboard onder **Nodes → Node toevoegen**.
Het script installeert zo nodig Node.js (NodeSource), maakt de gebruiker
`gjdc-e2e` aan, zet de software in `/opt/gjdc-e2e-server`, de instellingen in
`/etc/gjdc-e2e-server/agent.env` en de data in `/var/lib/gjdc-e2e-server`,
installeert de systeembibliotheken voor Chromium, meldt de node aan en start de
systemd-dienst `gjdc-e2e-server`.

```bash
sudo ./install/install.sh --help                 # alle opties (labels, max-jobs, cache, browsers)
git pull && sudo ./install/install.sh --update   # bijwerken
sudo ./install/install.sh --uninstall [--purge]  # verwijderen
```

## Instellingen

Zie [`install/agent.env.example`](install/agent.env.example). De belangrijkste:

| Naam | Standaard | |
| --- | --- | --- |
| `DASHBOARD_URL` | — | Adres van het dashboard (https verplicht, behalve `localhost`). |
| `NODE_NAME`, `NODE_LABELS` | hostnaam, — | Bij het aanmelden; daarna te wijzigen in het dashboard. |
| `MAX_JOBS` | `1` | Runs tegelijk. |
| `CACHE_MAX_MB` | `4096` | Grootte van de cache; het langst ongebruikte gaat eerst weg. |
| `DATA_DIR` | `/var/lib/gjdc-e2e-server` | Cache, runs en aanmelding. |
| `SHUTDOWN_GRACE` | `20` | Seconden die een run krijgt om af te ronden bij stoppen; daarna gaat hij terug in de wachtrij. |

Na een wijziging: `sudo systemctl restart gjdc-e2e-server`.

## Opdrachten

```text
e2e-server run                     de agent (dit draait systemd)
e2e-server register --token …      aanmelden bij het dashboard
e2e-server status                  aanmelding, cache en verbinding
e2e-server doctor                  alles nalopen wat een run nodig heeft
e2e-server cache [list|clear]      de cache bekijken of legen
e2e-server bundle <map> [-o zip]   een testpakket (ZIP) maken
e2e-server check-zip <zip>         een ZIP nakijken zoals het dashboard doet
```

Als dienstgebruiker: `sudo -u gjdc-e2e e2e-server status`. Logs: `journalctl -u gjdc-e2e-server -f`.

## Hoe een run verloopt

1. **Aanbieden.** Bij een heartbeat geeft het dashboard een job mee. De node accepteert hem (of geeft hem terug als hij vol zit).
2. **Testpakket.** Staat de sha256 al in de cache, dan wordt er niets gedownload. Anders downloaden (hervatbaar met HTTP Range) en de sha256 controleren.
3. **Uitpakken** in een eigen runmap, met controle op padnamen (geen `..`, geen absolute paden, niet via een symlink naar buiten).
4. **Afhankelijkheden.** `npm ci` (of `npm install` zonder lockfile), of de `node_modules` uit de cache.
5. **Browsers**, één keer per Playwright-versie. Kent die versie het besturingssysteem van de node nog niet (Ubuntu 26.04 met Playwright ouder dan 1.61), dan gebruikt de node de build voor de nieuwste Ubuntu die de versie wel kent, en meldt dat in de uitvoer.
6. **Tests.** `playwright test` met de opties van de run (shard, grep, projecten, herkansingen…). Een eigen reporter stuurt per test het resultaat live door; de uitvoer gaat elke ~1,5 s naar het dashboard, met geheime waarden weggepoetst.
7. **Rapport.** Het HTML-rapport (screenshots, video's, traces) gaat in stukken naar het dashboard, als dat voor dit pakket gewenst is.
8. **Afronden.** De uitslag wordt gemeld. Lukt dat niet (netwerk weg), dan bewaart de node hem en stuurt hem na zodra het dashboard weer bereikbaar is.

Annuleren in het dashboard stopt de tests binnen een paar seconden (de hele procesgroep, inclusief browsers). Stopt de dienst zelf (herstart, update), dan gaat een lopende run terug in de wachtrij.

## Veiligheid

- Het token van de node staat alleen in `DATA_DIR/state.json` (modus 600); het dashboard bewaart er alleen de sha256 van.
- De dienst draait als `gjdc-e2e` zonder rechten, met systemd-afscherming (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, alleen schrijven in `DATA_DIR`). Testcode (de tests zelf en hun npm-pakketten) draait binnen die grenzen: zet op een node niets wat een test niet mag zien.
- Het dashboard geeft geen vrije opdrachtregel mee, alleen een vaste, gecontroleerde set Playwright-opties.
- Variabelen die de dienst zelf aansturen (`PATH`, `NODE_OPTIONS`, `PLAYWRIGHT_*`, …) kan een pakket niet overschrijven.

## Ontwikkelen

```bash
npm test                                         # unit-tests (node:test)
DASHBOARD_URL=http://localhost:8100 DATA_DIR=/tmp/node1 \
  node bin/e2e-server.mjs register --token gjdcreg_…
DASHBOARD_URL=http://localhost:8100 DATA_DIR=/tmp/node1 node bin/e2e-server.mjs run
```

In [`examples/voorbeeld`](examples/voorbeeld) staat een klein testpakket om mee te beginnen: `node bin/e2e-server.mjs bundle examples/voorbeeld`.
