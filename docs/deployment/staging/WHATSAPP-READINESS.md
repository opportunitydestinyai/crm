# Preparazione WhatsApp — 4 ottobre 2026

Staging dedicato: https://deskcomm-staging.cristianocosta.it.
Base applicativa stabile v1.70.0, senza aggiornamento a latest.
Questa verifica prepara un primo collegamento controllato. Nessun numero reale
collegato e nessun messaggio inviato durante la preparazione.

## Preparazione locale

133 correzioni editoriali del percorso QR/codice, gruppi, accesso IA e protezioni
di invio e Sicurezza in whatsapp-readiness-corrections.json. I limiti riducono il rischio
di blocco: non garantiscono che WhatsApp non blocchi un numero.
Il catalogo completo contiene ancora testi da rivedere; questo report non
certifica la traduzione integrale né le integrazioni esterne non configurate.

## Riscontri preliminari sul server

- Sei servizi CRM e undici Supabase dedicati. Nessuna porta WAHA/Redis/Postgres
  pubblicata; gateway Supabase soltanto su loopback 127.0.0.1:18080.
- `.env` permessi 600, `.runtime` 700. Sessioni WAHA e media in volumi dedicati;
  database e Storage in cartelle persistenti del solo staging.
- Tabelle public senza RLS: zero. Bucket whatsapp-media e internal-media privati.
- QR generato e rigenerato dal browser senza scansione; una sessione non associata.
  Stato SCAN_QR_CODE confermato nell’API WAHA e nel database, identità associata
  assente. Il QR scade: per collegarsi usare Ricollega e quello appena generato.
- Nessun secondo fattore verificato: cambio password provvisoria e attivazione
  MFA restano azioni del titolare prima dell’uso con dati personali.
- Backup database, sessioni e Storage riusciti; wrapper verificato e cron attivo
  ogni giorno alle 03:00 Europe/Berlin (stesso orario italiano). Archivi privati,
  conservazione 14 copie per tipo. Replica automatica fuori server ancora assente.
- Ripristino completo del dump con ON_ERROR_STOP in container senza rete/porte,
  database nuovo template0 e stesse estensioni: riuscito. Conteggi confrontati
  per organizzazioni, utenti, contatti e sessioni. Database live non modificato;
  dettaglio in whatsapp-readiness-restore.json.
- WAHA Core 2026.7.2 non firma i webhook: firma obbligatoria disattivata come da
  contratto stabile. Il webhook globale usa `http://app:3000/api/v1/webhooks/waha`
  sulla rete privata: richiesta sintetica senza sessione registrata restituisce
  200 e `accepted:false`; lo stesso percorso pubblico restituisce 403. Le sessioni
  ereditano questa configurazione globale e non hanno webhook propri. Non abilitare
  la richiesta di firma senza un provider che effettivamente firmi.
- Copia cifrata iniziale fuori server scaricata e confrontata tramite SHA-256;
  decifratura e contenuto verificati sul server. Replica periodica fuori server
  ancora assente; dettaglio in whatsapp-readiness-backup-copy.json.
- Profilo italiano e fuso Europe/Rome salvati e riletti dopo reload.
- Revisione finale pubblicata e controllata nel browser; nessun numero associato.
- Controllo risorse dopo il deploy: circa 16 GiB liberi (84% disco usato),
  4,9 GiB RAM disponibile, nessuno swap. Rimossi soltanto i due archivi temporanei
  di trasferimento di questa verifica; immagini Docker per rollback conservate.

## Pubblicazione e verifica browser

Pubblicazione finale: immagine `1.70.0-it.c7a2341af80370e3054e98162163c8ef926e159a`,
CI [37207912711](https://github.com/ilpiratacris/WhatsApp-DeskcommCRM/actions/runs/37207912711)
riuscita: typecheck, lint senza errori (avvisi preesistenti), 65 test in otto file.
La prova che rimuove temporaneamente la guardia dei contatti fallisce come atteso;
guardia ripristinata prima del build. Immagine derivata dal tag stabile, senza
aggiornare il codice funzionale a una versione upstream successiva.

Health pubblico HTTPS e Docker healthy dopo il deploy, Supabase/Redis/WAHA ok.
Ricreato solo app con i quattro overlay: 43 container invariati, inclusi gli
altri cinque CRM. Dettaglio in whatsapp-readiness-deploy.json.
Artefatto trasferito e confrontato sul server: SHA-256
`e2243fc8a4f5643cf04ae51c9981aa4e91aa98fc32a02ac715d2dff63e609247`.
La revisione precedente 8d3898f è stata verificata prima di questo ultimo lotto;
le prove di Profilo e Sicurezza provengono da quella revisione, senza modifiche
successive a quelle funzioni.

Prove browser nel contesto autenticato:

| Percorso | Riscontro |
| --- | --- |
| Connessioni | Distinto «connessione configurata» da «Disconnesso»; QR rigenerato senza scansione. |
| Accesso IA | Modalità test, elenco vuoto: nessuna risposta automatica autorizzata. |
| Protezioni per l’invio | Modulo caricato; invio graduale attivo, limite iniziale 20/giorno più restrittivo di 250/giorno; fuso predefinito Europe/Rome. Nessuna modifica ai limiti. |
| Gruppi | Spiegato che l’IA non risponde nei gruppi; elenco indisponibile finché WhatsApp non è associato. Nessun gruppo attivato. |
| Sicurezza | Testi MFA/obbligo del team/codici di recupero leggibili; chiamate vocali assenti e disattivate. MFA ancora da attivare dal titolare. |
| Profilo | Italiano e Europe/Rome persistono dopo reload. |
| Password | Modulo /login/reset disponibile da autenticato; nessuna password inserita. |
| Messaggi | Inbox caricata senza conversazioni reali; ricezione/invio ancora da provare. |
| Agenda | Date italiane caricate senza errore; sincronizzazione Google non configurata. |
| Contatti | Invio modulo senza email/telefono rifiutato con messaggio esplicito. |

Il browser ha evidenziato altre otto etichette ambigue presenti nel tag stabile,
incluse «Ricollegamento» e «Liberazione del servizio pubblico»: sostituite da
«Ricollega» e «Attiva le risposte automatiche a tutti». Nella revisione finale
entrambi i pulsanti sono stati riletti nel browser: Ricollega ha rigenerato il QR,
il modulo IA mostrava modalità test ed elenco vuoto. Verificati anche fuso delle
fasce di invio, ritardo della prima risposta, millisecondi per carattere e nomi
geografici. Nessuna protezione salvata o risposta pubblica attivata. Nessun warning
o errore nei log console catturati per questa sessione; questo non copre tutti
gli errori intermittenti o percorsi dell’applicazione.

Immagini di prova: readiness-profile.png, readiness-security.png,
readiness-protections.png, readiness-ai-access.png e readiness-connections.png.
Il QR, i segreti e i backup privati non sono nel repository.

## Limiti prima dell’uso esteso

Ricezione, invio, riconnessione del numero e ripristino di una sessione autenticata
richiedono il successivo test del titolare. SMTP/recupero email e integrazioni
Google/Meta/IA esterna non configurati. Capacità sotto carico non collaudata.
Replica automatica dei backup fuori server non attiva. Rimangono traduzioni da
rivedere fuori dal percorso di primo collegamento, alcuni nomi tecnici/etichette
portoghesi e dati predefiniti brasiliani. La preparazione abilita un primo test
controllato, non certifica l’uso esteso con dati di clienti.

Nessuna nuova funzione: nessuna nuova voce richiesta nella Gestione funzioni
dell’amministratore. Documentazione, Novità e grafo dell’italiano aggiornati;
`graft build` e `graft check` riusciti (grafo strutturale, livello semantico non generato).

## Primo collegamento del titolare

1. Da autenticato aprire https://deskcomm-staging.cristianocosta.it/login/reset
   e sostituire la password provvisoria; poi Impostazioni → Sicurezza → Attiva
   per la verifica in due passaggi. Modulo password e pagina Sicurezza verificati;
   nessuna nuova credenziale inserita durante il controllo.
2. Connessioni → WhatsApp tramite QR → Ricollega: sul telefono, WhatsApp →
   Dispositivi collegati → Collega un dispositivo; scansionare il QR corrente.
3. Lasciare IA in modalità test con elenco vuoto; nessuna campagna attiva.
4. Effettuare con una persona di fiducia una prova di ricezione e risposta manuale
   in Messaggi. In questa fase non abilitare tutti i gruppi personali/familiari.
5. Confermare ricezione, invio e riconnessione prima di attivare automatismi.

La prova end-to-end con WhatsApp richiede il numero del titolare e resta da
eseguire dopo la scansione. Backup di file di una sessione non associata non
dimostra il ripristino di una sessione WhatsApp autenticata.

## Fonti

File del repository, verifiche SSH/browser e documentazione ufficiale Supabase:
https://supabase.com/docs/guides/self-hosting/docker. Le scelte di prudenza sul
primo collegamento sono indicazioni operative; il percorso QR è già esistente.
