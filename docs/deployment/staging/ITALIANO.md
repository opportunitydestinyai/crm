# Italiano nello staging

Richiesta utente: tradurre l'interfaccia e pubblicarla sullo staging già isolato.
Nessun redesign, nuova integrazione, numero WhatsApp o dato cliente.

## Implementazione e limiti

La revisione funzionale successiva è documentata in
[ITALIANO-REVISIONE.md](ITALIANO-REVISIONE.md), con elenco delle correzioni e limiti.

- Registro `it`, etichetta Italiano, BCP-47 `it-IT`; selettore, profilo e
  organizzazione utilizzano le superfici esistenti.
- Catalogo `lib/i18n/traducoes/it.json`: tutte le chiavi del dizionario; fallback
  al testo originale per chiavi sconosciute. Parametri, URL e codice preservati.
- Date tramite `date-fns/locale` italiano; preferenza salvata nell'autenticazione
  esistente. Nessuna migration o modifica RLS/permessi.
- Prima traduzione mediante modelli Argos offline pt→en→it; revisione manuale
  dei testi principali. La copertura automatica non prova la qualità editoriale
  di ogni frase. Contenuti utente, email, documenti legali e messaggi già salvati
  non sono tradotti da questo catalogo.

## Build e deploy

Il filtro delle estensioni accetta il tipo `Idioma` dal registro; i contenuti
dei pacchetti esterni mantengono il fallback del manifest originale.

Workflow `.github/workflows/staging-italiano.yml`: estrae il commit upstream
`cbf403e201627b49c0a9899f5a0cb5f12e02d975` (v1.70.0), copia soltanto registro,
date e catalogo, aggiunge il ramo italiano nel traduttore. Non distribuisce
le feature eventualmente successive presenti nel branch di lavoro.
Build su GitHub Actions, senza segreti runtime e senza carico di build sul server.
Immagine come artifact Docker, identificata dal commit del fork.

Download artifact, trasferimento via SCP, `docker load`; backup privato di `.env`
e modifica di `APP_IMAGE=deskcomm-staging-it:<commit>` e `APP_PULL_POLICY=never`.
Stesso progetto e quattro Compose, sostituendo **solo app**:

```sh
cd /opt/deskcomm-staging
docker compose --env-file .env -p deskcomm-staging \
  -f docker-compose.prod.yml -f docker-compose.single-server.yml \
  -f docker-compose.traefik.yml -f docker-compose.staging.yml \
  up -d --no-deps --no-build app
```

Rollback: ripristinare il backup privato `.env` e ripetere lo stesso comando.
L'immagine stabile originale resta disponibile. Nessun updater automatico:
una futura release ufficiale richiede una scelta esplicita sul catalogo italiano.
Artifact CI conservato sette giorni; immagine caricata sul server e archivio locale
sono indipendenti da questa scadenza. Nessuna modifica globale a Traefik/Coolify.

## Sistema Vivo e amministrazione

Input: preferenza utente/organizzazione e registro. Output: `useT` e locale date
su pagine esistenti; percorso: selettore shell, profilo, organizzazione.
Persistenza e comportamento di errore: azione `trocarIdioma` esistente, toast e
reload; non nasce una nuova mutazione di business né un nuovo log.
Anti-morte e continuità AI/umano non applicabili alla presentazione pura.
Ritorno: preferenza modificabile, test del catalogo segnalano chiavi mancanti.
Mappa: `docs/architecture/italiano.architecture.json`.
Gestione funzioni: nessun nuovo interruttore; lingua disponibile attraverso il
registro e le impostazioni esistenti. Novità: fragment `.changes/italiano-staging.md`
e Changelog non rilasciato; nessun tag upstream inventato.

## Verifica

Risultati reali e commit distribuito in `docs/handoffs/REPORT-ilpiratacris-staging.md`.
Prima della pubblicazione: typecheck, lint, test i18n e build della fonte stabile.
I cambiamenti al catalogo, al filtro o al test italiano attivano gli stessi gate CI.
Dopo: health, TLS, lingua persistente, menu e pagine principali; confronto degli
ID dei servizi preesistenti. Nessuna prova di invio WhatsApp o AI.

Il gate multilingue verifica il risultato di `traduzir`, indipendentemente dalla
collocazione del catalogo (colonne originali o JSON italiano separato).

Revisione live: preservati acronimi CRM/CPC/CPM, Trunk SIP e marchio Nuvemshop;
corretti fatturazione, identità visiva e messaggio inbox vuota.
Riviste anche descrizioni delle impostazioni, contatti e profilo osservate nel browser.
Verificati e chiariti anche i comandi di archiviazione, spostamento e importazione del funnel.
