# HANDOFF — staging iniziale ilpiratacris / Coolify

## Contesto

Repository di lavoro: `ilpiratacris/WhatsApp-DeskcommCRM`  
Upstream: `melgarafael/DeskcommCRM`  
Branch dedicato: `test/initial-evaluation`

Questo branch serve esclusivamente a valutare DeskcommCRM in un ambiente staging isolato prima di qualsiasi personalizzazione importante.

## Obiettivo della prima fase

Portare online una istanza staging raggiungibile via HTTPS e verificare il percorso minimo:

1. applicazione avviata;
2. health check coerente;
3. pagina di login raggiungibile;
4. autenticazione funzionante;
5. onboarding base completabile;
6. nessun impatto sulle applicazioni già presenti nel server Coolify.

Non collegare ancora numeri WhatsApp personali o di clienti reali e non caricare dati cliente.

## Regole operative

- Leggere `CLAUDE.md`, `AGENTS.md`, `.agents/skills/deskcomm-instalar/SKILL.md` e `docs/runbooks/deploy.md` prima di modificare deploy o codice.
- Non modificare `main` direttamente.
- Non spegnere o sostituire il Traefik di Coolify.
- Su host con Coolify usare sempre:
  `docker-compose.prod.yml` + `docker-compose.traefik.yml`.
- Per la prima valutazione usare immagini upstream `:stable`; non compilare l'app sulla VPS se non necessario per diagnosi.
- Non usare `:latest` per il test di base.
- Nessun segreto, token, password o connection string deve finire nel repository.
- Creare un progetto Supabase dedicato allo staging.
- Applicare `supabase/baseline.sql` su un database nuovo; non usare `supabase db push` come bootstrap iniziale.
- Per il primo test WhatsApp, quando arriverà, usare un numero sacrificabile/test.
- Prima di ogni modifica server-side verificare che risorse e networking del VPS siano sufficienti e che il progetto sia isolato dagli altri workload.

## Sequenza di lavoro

### Fase A — audit pre-deploy

Raccogliere e registrare senza modificare nulla:

```bash
uname -a
nproc
free -m
df -h /
docker --version
docker compose version
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker network ls
```

Identificare:

- rete Docker usata dal Traefik di Coolify;
- RAM libera e swap;
- spazio disco;
- eventuali limiti di risorse;
- dominio/subdominio staging disponibile.

Non fermare container esistenti.

### Fase B — Supabase staging

Creare o usare un progetto Supabase esclusivamente per Deskcomm staging.

Verificare che siano disponibili:

- Project URL;
- anon key;
- service_role key;
- connection string Session Pooler;
- estensioni richieste dal progetto, incluso pgvector.

Bootstrap schema con `supabase/baseline.sql`.

Creare/verificare il bucket privato `whatsapp-media`.

### Fase C — deploy Coolify

Il deployment deve convivere con il Traefik esistente. Il riferimento di configurazione è `docker-compose.traefik.yml`.

Variabili rilevanti da risolvere correttamente:

- `DOMAIN`;
- `TRAEFIK_NETWORK`;
- `TRAEFIK_ENTRYPOINT`;
- `TRAEFIK_ENTRYPOINT_HTTP`;
- `TRAEFIK_CERTRESOLVER`;
- variabili Supabase;
- secret interni generati dall'installer;
- provider AI opzionale nella prima fase.

Preferire il percorso ufficiale di installazione del repository e lasciare l'AI non configurata se rallenta il bootstrap iniziale.

### Fase D — prove minime

Dopo il deploy verificare almeno:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml ps
```

e dall'esterno:

- HTTPS valido;
- root del dominio che risponde con redirect al login (atteso tipicamente HTTP 307);
- login funzionante;
- onboarding base;
- nessun 404 generico di Traefik.

Se l'app è healthy ma il dominio risponde 404, verificare immediatamente labels e rete Traefik prima di cambiare codice.

### Fase E — test funzionale progressivo

Solo dopo il baseline verde:

1. WAHA + numero WhatsApp di test;
2. inbound e outbound manuale;
3. contatto/lead creato correttamente;
4. provider AI con budget basso;
5. knowledge base/RAG;
6. agente AI e handoff umano;
7. follow-up/automazioni;
8. MCP.

## Scenario E2E finale da provare

Un contatto test scrive su WhatsApp:

> Buongiorno, vorrei informazioni sul vostro servizio.

La prova deve verificare, passo per passo e con evidenza, se Deskcomm:

1. riceve il messaggio;
2. riconosce/crea il contatto;
3. rende visibile la conversazione nell'inbox;
4. interroga la knowledge base;
5. genera una risposta pertinente;
6. crea/aggiorna il lead;
7. modifica correttamente lo stato nel funnel;
8. programma un eventuale follow-up;
9. consente a un umano di prendere il controllo.

Non considerare riuscito il test AI se è verde solo la risposta del modello: misurare anche direttamente le azioni/tool sottostanti, secondo la dottrina del repository.

## Deliverable richiesto a Codex

Al termine della prima fase lasciare in questo branch un breve report con:

- ambiente effettivamente usato;
- versione Deskcomm;
- configurazione di deploy scelta;
- servizi avviati;
- esiti di health/login/onboarding;
- problemi incontrati e soluzione;
- elementi non ancora testati;
- prossimo passo raccomandato.

Non iniziare redesign UI o refactor architetturali prima che il baseline staging sia dimostrato funzionante.
