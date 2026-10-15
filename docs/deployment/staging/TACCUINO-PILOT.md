# Taccuino — pilota delle note WhatsApp

## Obiettivo e perimetro

Nome di lavoro: **Taccuino**. Archivio privato delle sole fonti **Note, AI e Tools**,
contenenti soltanto il titolare. Il pilota conserva provenienza e date, offre ricerca
testuale e suggerisce categorie con regole locali. Non analizza le altre chat e non
invia messaggi. Non addestra modelli né invia automaticamente note a servizi AI.

Destinazione: infrastruttura operativa del fork, separata dal runtime commerciale
DeskcommCRM. Nessuna modifica a schema Supabase, immagini CRM o risposte automatiche.
L'accesso resta quello dell'operatore tramite SSH; sul server il visualizzatore
usa un socket UNIX privato, accessibile soltanto a root. Un tunnel SSH lo rende
consultabile sul loopback del computer dell'operatore. Non è una pagina pubblica del CRM.

## Recupero dello storico: risultato dell'audit iniziale

Il 4 ottobre 2026 WAHA 2026.7.2 NOWEB CORE ha una sessione WORKING.
Gli endpoint dei tre gruppi restituiscono HTTP 400 perché lo store non è abilitato.
Nel database CRM è disponibile un nuovo messaggio testuale del titolare per fonte.
La sola cartella privata runtime ispezionata non contiene export WhatsApp utilizzabili.

Non è stato abilitato store/full sync, rifatto il pairing o scollegato il telefono.
La [documentazione NOWEB](https://waha.devlike.pro/docs/engines/noweb/) avverte di
non cambiare lo store dopo il QR e descrive limiti allo storico sincronizzabile.
Il recupero retroattivo richiede quindi gli export disponibili sul telefono.
**Non è verificato, né promesso, un archivio completo dalla creazione dei gruppi.**

## Percorso degli export

Da ciascun gruppo WhatsApp usare Esporta chat, inizialmente **senza media**.
Consegnare i tre TXT privatamente, separati e associati esplicitamente a Note,
AI e Tools. Non salvarli nel repository, nella wiki o nelle richieste a Claude.

L'operatore esegue prima un'anteprima di autori, date e conteggi; identifica gli
alias realmente usati dal titolare e conferma la fonte. L'importazione ha un
formato data esplicito e un fuso orario; non indovina date ambigue. Il nome file
e la scelta della fonte non dimostrano da soli l'identità del gruppo: la conferma
del titolare e il controllo degli autori sono parte della procedura.

Le righe relative ad allegati omessi sono riferimenti non disponibili, non
contenuti analizzati. Una fase successiva dovrà acquisire e verificare gli
allegati reali, con limiti di spazio e tipi supportati. Nessun percorso o URL
contenuto in una nota viene aperto o eseguito automaticamente.

## Ecosistema e nomi di lavoro

| Nome di lavoro     | Componente reale         | Ruolo e stato                                                          |
| ------------------ | ------------------------ | ---------------------------------------------------------------------- |
| Taccuino           | Questo modulo operativo  | Archivio circoscritto WhatsApp; prove del pilota sotto                 |
| Atlante (proposto) | Hindsight                | Memoria organizzata; integrazione futura, nessuna importazione avviata |
| AI-Wiki            | Wiki personale esistente | Conoscenza curata e procedure; nessuna scrittura in questa attività    |
| DeskcommCRM        | Staging esistente        | Ricezione e gestione conversazioni; base di codice conservata          |

`C:/Users/ilpir/Documents/Hindsight/Punto-di-ripresa.md` registra una pausa
dell'importazione wiki, con 198 fonti su 494 revisionate. Questi sono dati del
punto di ripresa, non un nuovo conteggio API. La pausa resta rispettata: il
pilota non chiama Hindsight e non riattiva raccolte o consolidamenti.

Il futuro collegamento trasferirà sintesi selezionate con riferimenti alle note,
non trascrizioni grezze nella wiki. Per ChatGPT serve un connettore circoscritto
ancora distinto dall'MCP generale del CRM. Codex può utilizzare il lettore SSH
già autorizzato; ciò comporta che i testi consultati arrivano al modello.

## Piano e criteri di accettazione

1. Archivio SQLite privato fuori Git; file e cartella privati su Linux.
2. Sincronizzazione idempotente dei testi del lettore verificato.
3. Importazione TXT con anteprima e conferma; date e autori espliciti.
4. Ricerca letterale parametrizzata, fonte e provenienza visibili.
5. Visualizzatore italiano in sola lettura su socket privato e tunnel SSH.
6. Prove su fixture sintetiche: formati export, ambiguità, scope, duplicati,
   input ostili, HTML e SQL injection, rollback e permessi.
7. Prova sul server con i tre nuovi testi reali, senza divulgarli nel repository.
8. Importazione storica e confronto col telefono quando i tre export sono forniti.

Il lettore CRM restituisce al massimo 100 testi per esecuzione: il pilota dichiara
questa finestra, non interpreta un batch pieno come copertura completa. La
classificazione è un suggerimento deterministico, non un progetto o un impegno
confermato dal titolare. Errori e risultati sconosciuti devono restare visibili.

Fable è incaricato del piano in sola lettura; Opus 5.5 del codice e dei test
isolati su dati sintetici. Il coordinatore controlla codice, prove e installazione.
Le chiamate Claude non ricevono export, note reali, identificatori o segreti.

## Risultati realmente verificati

Verifica del 4 ottobre 2026:

| Livello                | Evidenza                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archivio reale         | 3 note: Note 1, AI 1, Tools 1. Nessun export storico importato.                                                                                                                                                             |
| Idempotenza reale      | Prima acquisizione: 3 inserite; seconda: 0 inserite, 3 duplicati.                                                                                                                                                           |
| Ricerca browser e CLI  | La stessa nota di prova restituisce 1 risultato in Note e 0 in AI.                                                                                                                                                          |
| Interfaccia            | Navigazione, statistiche, ricerca e filtro verificati in italiano; nessun errore console rilevato. Il filtro conserva il gruppo applicato.                                                                                  |
| Backup                 | Backup SQLite privato: integrity_check ok; ripristino letto e confrontato con tutte e tre le note senza stampare i testi.                                                                                                   |
| Sicurezza server       | Directory dati 700, DB 600; socket 600 in directory 700; nessuna porta TCP del servizio sul server; accesso socket negato all'utente nobody.                                                                                |
| Servizio isolato       | deskcomm-taccuino.service attivo; systemd-analyze verify superato. Limiti: memoria 128 MiB, CPU 10%, 16 task; consumo osservato circa 12,6 MiB.                                                                             |
| CRM dopo installazione | Container app healthy; HTTPS /login HTTP 200. Nessuna modifica a compose, schema, pairing o store WAHA.                                                                                                                     |
| Test del modulo        | 43 test superati su Linux, fixture sintetiche. Comprendono scope, import, date, duplicati, rollback, SQL/HTML injection, socket privato, sola lettura e backup.                                                             |
| Prova negativa         | Eliminando l'escape HTML in una copia esterna al repository, il test XSS fallisce. Il codice consegnato mantiene la protezione.                                                                                             |
| Check CRM              | Typecheck superato. Lint standard bloccato da tre errori preesistenti in .runtime/check-agenda-date.cjs, ignorato da Git. ESLint escludendo .runtime: 0 errori, 489 warning preesistenti. Nessuna modifica a quello script. |

Verifica locale Windows: 43 test eseguiti, 5 saltati per vincoli POSIX/socket UNIX;
nessun fallimento. Graft rigenerato e check superato (grafo strutturale, senza deep
semantico); frammento Novità riconosciuto da `pnpm release:conferir`, senza tagliare
una nuova release. Il test Vitest mirato dei mappe non si avvia nel workspace
Windows (`ERR_PACKAGE_IMPORT_NOT_DEFINED`, `#module-evaluator`). Il JSON del pilota
è stato verificato separatamente: ID e lane validi, mainPath valido, nessun nodo
orfano, archivio e visualizzatore con almeno due collegamenti. Le integrazioni
future sono dichiarate nei contratti, senza falsi flussi dati.

Fable 5.1 ha prodotto piano e due revisioni indipendenti; Opus 5.5 ha scritto
modulo e test sintetici. Il coordinatore ha corretto i problemi individuati,
aggiunto test di accettazione e verificato l'installazione. Nessun contenuto
privato è stato inviato a Claude. Non è stata eseguita l'intera suite Vitest
del CRM: il pilota non modifica il runtime TypeScript.

Codice e unit systemd sono nel repository; dati, ricevute e backup sono fuori Git
in `/var/lib/deskcomm-taccuino`. Il visualizzatore legge il DB in sola lettura.
Il servizio riavvia soltanto sé stesso in caso di guasto; non ripara o sovrascrive
note in conflitto. Nessuna funzione è stata aggiunta al pannello admin del CRM:
questo è un modulo operativo SSH separato, non una nuova rotta del prodotto.

### Importazione degli export recuperati dalle sessioni Work

Aggiornamento del 4 ottobre 2026, dopo il baseline iniziale a tre note:
gli strumenti ufficiali dell'app hanno individuato e reso accessibili gli allegati
delle sessioni **Organizzazione cronologia chat** (Note), **Organizza cronologia chat**
(AI) e **Analisi cronologia WhatsApp** (Tools). Nessun messaggio è stato inviato
alle sessioni. Non è stato necessario chiedere al titolare di ricaricare gli ZIP.

I tre ZIP contengono un solo TXT ciascuno. Copie persistenti e TXT estratti sono
fuori Git in `%LOCALAPPDATA%/DeskcommTaccuino/imports/2026-10-04`, con ACL riservata
al titolare e SYSTEM. Sul server i TXT sono in
`/var/lib/deskcomm-taccuino/imports/2026-10-04` (directory 700, file 600).
L'anteprima non mostra contenuti, ha trovato soltanto l'autore del titolare e zero
errori di formato. Usato ordine date `dmy` e fuso `Europe/Rome`, coerente con
l'ambiente del titolare; il confronto con gli orari sul telefono resta aperto.

| Fonte  | Record importati | Testi | Riferimenti a media omessi | Righe di sistema escluse |
| ------ | ---------------: | ----: | -------------------------: | -----------------------: |
| Note   |             1057 |   790 |                        267 |                       70 |
| AI     |              252 |   243 |                          9 |                        3 |
| Tools  |              316 |   285 |                         31 |                        9 |
| Totale |             1625 |  1318 |                        307 |                       82 |

Archivio risultante: **1628 record**, inclusi i tre messaggi già acquisiti dal CRM.
Le tre sovrapposizioni CRM/export vengono segnalate mantenendo la provenienza.
Ripetendo l'importazione: **zero nuovi record e 1625 duplicati riconosciuti**.
Ricerca letterale su contenuti importati verificata in tutte e tre le fonti senza
stampare i testi. Statistiche reali verificate nel browser; nessun contenuto dei
gruppi è incluso nelle prove visive o nei report Git.

Backup prima dell'importazione (3 record) e dopo l'importazione (1628 record):
SQLite integrity_check ok e confronto esatto di fonte, ID, data e testo superato.
Il modulo aggiornato passa **44 test su Linux**. L'avviso italiano ora distingue
export importati e completezza non verificata, evitando di chiedere export già
acquisiti. Il CRM resta separato; nessun invio WhatsApp o modifica dello store.

Non sono stati consultati URL o contenuti degli allegati; nessuna trascrizione
grezza è stata inviata a Claude, copiata in wiki o committata.

### Limiti e passo successivo

- **Storico:** i tre export reali sono importati e verificati per idempotenza.
  Resta da confrontare la copertura con il telefono: non è dimostrata la completezza
  dalla creazione dei gruppi, né l'assenza di messaggi esclusi dall'export WhatsApp.
- **Aggiornamento:** l'acquisizione è manuale, con massimo 100 messaggi per lettura.
  Non è ancora un archivio che si aggiorna automaticamente né una scansione completa.
- **Allegati:** conservati solo riferimenti a media omessi negli export, non i file.
- **Duplicati CRM/export:** le sovrapposizioni possibili vengono segnalate per testo
  esatto e minuto UTC; nessuna fusione automatica fra provenienze diverse.
- **Date:** orari ambigui o inesistenti per cambio ora legale sono rifiutati;
  messaggi con lo stesso timestamp non hanno un ordinamento originale garantito.
- **Revoche:** lo snapshot conserva copie già archiviate anche dopo una revoca WhatsApp.
  Un procedimento esplicito di cancellazione resta da progettare prima di ampliare lo scope.
- **Organizzazione:** categorie suggerite da regole testuali, da confermare;
  ricerca semantica, progetti strutturati e integrazioni ChatGPT/Hindsight non implementati.

Il prossimo test utile è confrontare conteggi e intervalli con il titolare e
recuperare una sua nota di progetto dall'archivio storico già importato.
Le altre chat restano escluse. Nessun messaggio è stato inviato durante questo pilota.

## Prima raccolta Note — 04/10/2026

Disponibile nella vista privata `/collections`, tramite lo stesso socket UNIX e
tunnel SSH già autorizzati. La raccolta iniziale contiene **solo Note**: AI e Tools
restano consultabili nella ricerca generale. La navigazione permette di aprire
una categoria, leggere la nota originale con fonte/data/ID, filtrare il testo e
passare alla pagina successiva o precedente. Nessun testo privato è incluso nel
report o nella [prova browser](evidence/taccuino-collection-2026-10-04.jpg).

| Categoria suggerita      | Record |
| ------------------------ | -----: |
| Riferimenti a progetti   |      3 |
| Possibili attività       |     13 |
| Repository               |     17 |
| Risorse AI               |      7 |
| Link                     |    546 |
| Altre note               |    235 |
| Allegati non disponibili |    267 |

Totale Note: **1058 record**, di cui **791 testi** e **267 riferimenti a media**.
556 testi hanno almeno un indizio; 235 non hanno indizi. 29 record compaiono in più
categorie: le righe della tabella **non si sommano** al totale. I conteggi derivano
dal database reale tramite codice in sola lettura, non da stime o interpretazioni.

Le regole locali `note-v1` mostrano un indizio letterale per ogni categoria; nessun
modello AI ha analizzato i contenuti. Non è un censimento di progetti, né un elenco
di attività ancora aperte: una nota storica può essere superata. Nomi, scadenze e
stato attuale non sono dedotti. Non esistono conferme persistenti o promemoria.
Gli URL non vengono visitati e i media omessi restano non disponibili.

### Prove completate

- **Preparazione:** modulo puro `note_collections.py`, CLI `collection` e nuova
  pagina italiana. Default CLI senza testi/indizi; `--read` è una lettura esplicita.
  Doppio controllo Note, query letterali, cap 10000 record e pagine di massimo 100.
- **Test:** 76 test su Linux superati; Windows 76 con 5 prove POSIX non applicabili.
  Prove indipendenti di isolamento, originali, HTML escaping, HTTP Host/CSP/no-store,
  paginazione e file invariato. Mutazione intenzionale del filtro SQL Note → AI in
  una copia temporanea: il test diventa rosso; il codice attivo non è stato mutato.
- **Claude:** piano e revisione indipendente Fable 5.1 in sola lettura; delega
  circoscritta a modulo/test con Opus 5.5, effort high. Solo codice e dati sintetici.
  Corrette due osservazioni della revisione: URL ambigui con backslash/credenziali
  non diventano repository, e la raccolta non mostra vecchie etichette concorrenti.
  Gli indizi HTML usano `code` con isolamento bidirezionale.
- **Deploy:** copiati soltanto i due moduli dell'utilità e riavviato
  `deskcomm-taccuino.service`. Nessuna migrazione, modifica Docker/Traefik/Supabase,
  nuovo ingresso pubblico o modifica del runtime CRM. SHA-256 SQLite identico
  prima e dopo deploy/consultazione. Permessi e isolamento del servizio invariati.
- **Browser reale:** indice coerente con CLI; categoria progetti con 3 originali;
  filtro letterale `progetto` con 1 risultato; categoria link con 546 record,
  prima pagina 20 da 1 e seconda pagina 20 da 21. Nessun errore console rilevato.
  Screenshot pubblico limitato all'indice senza contenuti o identificativi.
- **CRM:** HTTPS `/login` restituisce 200 dopo il deploy dell'utilità. Non è stata
  ripetuta una sessione autenticata completa del CRM: questa modifica è separata.
- **Governance:** aggiornati README, report, grafo e frammento Novità. Nessuna voce
  nuova nel pannello Gestione funzioni: l'utilità è privata, fuori dal runtime CRM.
- **Controlli repository:** typecheck e `release:conferir` superati; il comando
  release ha solo verificato i frammenti, senza creare una release. Grafo Graft
  rigenerato/verificato e mappa architetturale controllata per ID, lane, archi e
  assenza di nodi isolati. `pnpm lint` resta rosso per 3 errori preesistenti nel
  helper locale ignorato `.runtime/check-agenda-date.cjs`, oltre agli avvisi già
  presenti; quel file non è parte del codice consegnato né è stato modificato.
  ESLint escludendo solo `.runtime/**`: zero errori, 489 avvisi preesistenti.

### Come consultarla e cosa manca

L'operatore con SSH apre il tunnel descritto nel runbook del pilota e visita
`http://127.0.0.1:18871/collections`. **Non è una pagina pubblica nel CRM e non è
accessibile direttamente dallo smartphone**. Il comando `collection` rende già
recuperabili i riferimenti a Codex tramite SSH; questo non costituisce un
connettore ChatGPT. Per esempi e output privato esplicito vedere il README del modulo.

Il passo successivo è confermare con il titolare alcune categorie e il significato
delle note prima di costruire progetti strutturati, attività o memoria semantica.
Successivamente si potrà estendere la raccolta ad AI e Tools e progettare accesso
ChatGPT limitato a queste fonti. Restano aperti copertura sul telefono, recupero
allegati e aggiornamento automatico. Hindsight e importazioni wiki restano in pausa.

## Provenienza

Audit server in sola lettura, report [WHATSAPP-NOTES.md](WHATSAPP-NOTES.md),
documentazione ufficiale NOWEB e punto di ripresa locale Hindsight.
AI-Wiki: `wiki/sources/cristiano-costa-master-profile-llm-wiki.md` per la
distinzione fra fatti e ipotesi operative; consultati AGENTS.md, index.md e log.md.
Consultata anche `wiki/analyses/morning-briefing-shared-memory-2026-09-24.md`:
memoria curata e integrazione ChatGPT locale ancora da verificare. Wiki solo letta.
Nomi di lavoro e architettura futura sono proposte, non integrazioni esistenti.
