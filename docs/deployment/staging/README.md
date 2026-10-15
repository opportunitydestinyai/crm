# Staging sul server Coolify

[Taccuino — pilota archivio note WhatsApp](TACCUINO-PILOT.md): recuperabilità,
archivio privato, ricerca e collegamenti futuri alla memoria.

Configurazione specifica di `deskcomm-staging.cristianocosta.it`.
[Report con prove e limiti](../../handoffs/REPORT-ilpiratacris-staging.md).
Stack gestito via SSH/Compose, non come risorsa applicativa nel pannello.

## File e versioni

Checkout server `/opt/deskcomm-staging`, upstream `v1.70.0`, commit
`cbf403e201627b49c0a9899f5a0cb5f12e02d975`, immagini CRM `1.70.0`.
Copiare l'overlay CRM di questa cartella nella root come `docker-compose.staging.yml`.

Supabase in `.runtime/supabase`, setup `self-hosted/v0.8.1`:
Compose ufficiale + `docker-compose.deskcomm.yml` dal kit
`supabase-single-server.override.yml` + overlay Supabase di questa cartella
copiato come `docker-compose.staging.yml`.

Env Supabase: progetto `deskcomm-staging-supabase`,
`COMPOSE_FILE=docker-compose.yml:docker-compose.deskcomm.yml:docker-compose.staging.yml`,
`SINGLE_SERVER_NETWORK=deskcomm-staging_supabase`, `API_GW_HTTP_PORT=18080`.
L'override del kit resetta nomi globali e porte; non avviare il Compose
ufficiale da solo, che può collidere con Coolify sulla porta 8000.

Env CRM: progetto `deskcomm-staging`, `SINGLE_SERVER=1`, stessa rete dedicata,
`REVERSE_PROXY=traefik`, `TRAEFIK_NETWORK=coolify`, entrypoint HTTPS `https`,
HTTP `http`, resolver `letsencrypt`, dominio staging. Segreti generati sul server,
`.env` e credenziali 600, `.runtime` 700. Non versionare log o risposte Auth.

## Gestione circoscritta

Accedere via alias SSH locale `cosmo-builder`, poi sul server:

```bash
cd /opt/deskcomm-staging/.runtime/supabase
# Legge progetto e lista dei tre file dal suo .env:
docker compose config --quiet
docker compose ps
# Solo se serve avviare/applicare:
docker compose up -d --no-build

cd /opt/deskcomm-staging
export COMPOSE_PROJECT_NAME=deskcomm-staging
docker compose -f docker-compose.prod.yml -f docker-compose.single-server.yml \
  -f docker-compose.traefik.yml -f docker-compose.staging.yml config --quiet
docker compose -f docker-compose.prod.yml -f docker-compose.single-server.yml \
  -f docker-compose.traefik.yml -f docker-compose.staging.yml ps
# Solo se serve applicare:
docker compose -f docker-compose.prod.yml -f docker-compose.single-server.yml \
  -f docker-compose.traefik.yml -f docker-compose.staging.yml up -d --no-build
```

Non omettere il quarto file: `_common.sh` ridefinisce `dc()` durante bootstrap.
Controllare limiti reali Memory/NanoCpus via inspect, health e snapshot servizi
esistenti. `config --quiet` evita di stampare segreti nel modello espanso.

Bootstrap già eseguito con kit ufficiale release. Copia operativa privata
`hostgator-setup-kit/.staging-install.sh`: pull fallito interrompe, avvio senza
build, saltate chiamate finali `setup_update_agent_cron` e
`setup_event_log_drain_cron`. Scheduler già esegue drain. Non rieseguire installer
standard indiscriminatamente: può modificare cron, tentare build e perdere overlay.

Config/SQL montati devono essere leggibili dall'utente container (directory 755,
file 644, script 755), mantenendo privati genitore `.runtime` ed env. Dati di una
inizializzazione parziale preservati in `.runtime/supabase-partial-init-20261003`;
non sono un backup collaudato.

Per arrestare solo staging: stessi file/progetto con `docker compose stop`.
Supabase nella propria directory con il proprio env. Non usare `down -v`, cleanup
globale Docker, stop globale o riavvio del proxy. Non toccare reti/volumi altrui.

Health autenticato richiede secret privato server; non inserirlo in report/log
pubblici. Webhook globale esterno deve restare 403. Una sessione WAHA di prova
è stata creata per verificare il QR, senza associarla a un numero reale.
Il titolare ha autorizzato il proprio successivo collegamento controllato:
seguire [WHATSAPP-READINESS.md](WHATSAPP-READINESS.md), cambiare la password
provvisoria e attivare la verifica in due passaggi prima della scansione.
Onboarding completato dopo conferma
utente per termini/privacy: `Deskcomm Staging`, fuso `Europe/Rome`, funnel
`Clienti — test` con sette fasi in italiano; inbox e quadro vuoti verificati.
L'interfaccia italiana è descritta in [ITALIANO.md](ITALIANO.md). Backup giornalieri,
ripristino completo isolato del database e copia cifrata iniziale fuori server
verificati nel report WhatsApp. Replica periodica fuori server, SMTP e capacità
sotto carico restano da configurare/verificare. Ultimo disco libero circa 16 GiB: valutare crescita
prima di abilitare media/carichi. Nessun agente di aggiornamento automatico.

Gruppi personali selezionati e accesso alle note:
[WHATSAPP-NOTES.md](WHATSAPP-NOTES.md), con attivazione verificata, lettore SSH
circoscritto e limiti espliciti sullo storico e sul collegamento ChatGPT.
