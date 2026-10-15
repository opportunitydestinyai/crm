# Controllo browser dello staging — 4 ottobre 2026

Ambiente: https://deskcomm-staging.cristianocosta.it, sessione amministratore
dell'organizzazione Deskcomm Staging. Dati sintetici, nessun numero WhatsApp
reale collegato e nessun messaggio inviato.

## Risultati prima della correzione

Caricamento verificato di Messaggi, Radar, Agenda, risposte rapide, funnel,
Contatti, attività da svolgere, CRM, agenti IA, ricontatti, casi, hub IA,
connessioni, webhook, risultati, Meta Ads, registro attività, analisi e
impostazioni. Verificate anche organizzazione, profilo, team, notifiche,
gestione funzioni e configurazione Agenda. Nessun errore o avviso nella console
raccolta durante questa navigazione. Questo non esclude errori intermittenti.

- Agenda: date settimanali visualizzate come `4"de" MMM`. Causa: token date-fns
  alterati nella traduzione. Corretti sette formati e aggiunte regressioni con
  data italiana reale; prova locale rossa prima, verde dopo la correzione.
- Nuovo contatto: invio con tutti i campi vuoti accettato, nonostante la
  descrizione richieda email o telefono. Rimasto un record vuoto di audit
  `c6712a09-a138-4c53-a352-c8e512bd67d2`, senza dati personali. Il modulo ora
  rifiuta identificatori vuoti o fatti di spazi; l'API generale resta invariata.
  Test del componente copre rifiuto, email sola e telefono solo. La CI ha
  verificato che togliere la guardia rende rossi i due test degli identificatori
  vuoti, mantenendo verdi i due casi validi; guardia ripristinata prima del build.
- Corrette altre etichette Agenda, stati aperti e prima fonte webhook: 34 voci
  totali, elenco prima/dopo in `browser-check-corrections.json`.

Avvisi previsti: Google Agenda non configurato, nessun orario pubblicato,
Meta Ads senza account e notifiche push senza VAPID. Non sono guasti di
caricamento. Restano traduzioni fuorvianti nelle statistiche e nei ricontatti,
oltre a nomi portoghesi provenienti dai dati iniziali. Verificate anche la pagina
estensioni (nessuna installata), la ricerca globale con risultati per Agenda e
le sei schede della inbox. Non provati invii reali,
provider IA, sincronizzazioni Google e attribuzioni Meta.

## Correzione e pubblicazione

La base resta la release stabile 1.70.0, SHA
`cbf403e201627b49c0a9899f5a0cb5f12e02d975`. Il modulo contatto nella base stabile
è identico al modulo del fork prima della guardia: viene applicata solo questa
correzione oltre all'overlay italiano. Nessuna nuova funzione amministrativa
da registrare; nessun interruttore della gestione funzioni modificato.

Verifica locale Vitest bloccata da `ERR_PACKAGE_IMPORT_NOT_DEFINED` del pacchetto
installato su Windows. La verifica effettiva è stata completata in Linux:
[CI 37164870821](https://github.com/ilpiratacris/WhatsApp-DeskcommCRM/actions/runs/37164870821),
65 test su 8 file superati, typecheck superato, lint senza errori (489 avvisi
preesistenti). Graft: build e controllo del grafo superati, 26056 nodi.

Deploy completato usando l'immagine
`deskcomm-staging-it:bd2d64d9bcac3b929ade119ad8f4a362c504ce5b` costruita dalla CI
sulla base stabile indicata sopra. SHA256 dell'archivio immagine, coincidente
fra PC e server:
`0fb96a76a26508734208e4b53bfe188cab87a80c88c3264b80ddd75fc3f4b959`.
Ricreato soltanto il container applicazione: 44 container prima e dopo,
43 invariati per identità, stato e data di avvio, inclusi gli altri cinque
container CRM. Workers e scheduler restano alla release 1.70.0.
Health pubblico HTTPS: HTTP 200, `healthy`; Supabase, Redis e WAHA `ok`.
Evidenza depurata da segreti in [browser-deploy-result.json](browser-deploy-result.json).

## Accettazione nel browser dopo il deploy

- Agenda: settimana `4 ott — 10 ott`, giorno `domenica, 4 ottobre`, mese
  `ottobre 2026`. [Screenshot mensile](browser-agenda-live.jpg).
- Nuovo contatto: invio completamente vuoto e telefono composto di soli spazi
  rifiutati con «Compilare almeno un identificatore (email o telefono).»;
  finestra rimasta aperta. [Screenshot del rifiuto](browser-contatto-live.jpg).
  Dopo chiusura, ricaricamento e nuova navigazione, elenco ancora a **1 contatto**:
  solo il record sintetico creato per riprodurre il difetto prima della patch.
- Nessun errore console rilevato durante i controlli raccolti. Nessun nuovo
  numero collegato, invio, integrazione o modifica della gestione funzioni.

## Limiti e lavoro ancora necessario

La traduzione completa **non è accettata**: restano, fra gli altri, `Semana`,
frasi poco comprensibili sugli orari dell'Agenda, etichette accessibili come
`4 ottobre a) 07:00`, `Sem nome`, testi della ricerca come «Ricerca di tele»,
termini ambigui nelle statistiche («Decenni», «Funicolare», «Parlamenti»),
ricontatti ed estensioni. Le denominazioni iniziali `Atendimento`, `Consulta`,
`Reunião` provengono dai dati dell'organizzazione e non sono state rinominate.
Questi elementi richiedono ulteriore revisione nel contesto della funzione.

Il controllo copre caricamento e navigazione con uno staging quasi vuoto e
le due regressioni riprodotte. Non è un test di carico né una verifica completa
di conversazioni, automazioni IA, onboarding da zero, Google o Meta Ads.
Gli errori intermittenti segnalati dall'utente non sono stati riprodotti;
non si possono quindi dichiarare tutti risolti. Paese Brasile, valuta BRL e
fuso del profilo America/SaoPaulo sono rimasti invariati; organizzazione con
lingua italiana e fuso Europe/Rome. Nessuna modifica ulteriore del baseline.

Report conservato esclusivamente nel repository, secondo la scelta dell'utente.

## Seguito — preparazione WhatsApp del 4 ottobre 2026

Profilo ora salvato e riletto in Italiano/Europe/Rome. Pubblicata la revisione
stabile c7a2341af, con QR rigenerato senza scansione, accesso IA in modalità test
con elenco vuoto e protezioni di invio verificate. Nessun messaggio reale.
Prove, copie di backup e limiti aggiornati in [WHATSAPP-READINESS.md](WHATSAPP-READINESS.md).
Questo seguito non sostituisce i limiti del controllo precedente né certifica
onboarding da zero, tutte le traduzioni o gli errori intermittenti non riprodotti.
