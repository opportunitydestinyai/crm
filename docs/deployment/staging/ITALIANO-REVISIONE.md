# Revisione funzionale dell’italiano — 4 ottobre 2026

Il catalogo iniziale derivava da traduzione automatica pt→en→it e conteneva
errori di significato, omissioni e istruzioni tecniche alterate. La copertura
delle chiavi non era una verifica editoriale sufficiente.

## Metodo e perimetro

Confronto con le chiavi portoghesi e con il codice che utilizza i testi:

- `app/onboarding/welcome/_form.tsx` e `lib/tempo/fusos.ts`: la località seleziona
  un fuso orario, non il settore lavorativo o l’indirizzo dell’azienda.
- `app/onboarding/funil/_client.tsx` e i percorsi `setup-ai`, `testar`,
  `connect-whatsapp`, `done`: funnel modificabile, assistente IA in bozza o
  pubblicato, verifica della chiave, collegamento del numero e stato finale.
- `lib/navigation/catalogo.ts`: distinzione tra attività da svolgere e registro
  delle attività, incassi e fatturazione dell’abbonamento, configurazione e
  monitoraggio dell’agente, proposte commerciali e suggerimenti dell’IA.
- `app/app/imports/_client.tsx`, persone e aziende: righe di file, importazioni,
  referenti aziendali e CNPJ. CNPJ, BrasilAPI e formati restano quelli brasiliani;
  non è stata inventata un’integrazione italiana.
- `lib/conversoes/historico.ts`: un account collegato può avere l’invio
  disattivato. Non indica un caricamento in corso. Accettazione dell’evento da
  parte della piattaforma non equivale ad attribuzione all’annuncio.
- Istruzioni del tracciamento: mantenuti `data-storage="none"`,
  `data-rastreio-ignorar`, gclid/gbraid/wbraid e UTM; esclusione dal tracciamento
  distinta dall’eliminazione del link.
- Prove degli agenti: interrompere l’attesa non interrompe necessariamente il
  lavoro già inviato al provider; la simulazione non invia messaggi ai contatti.

Sono state modificate **735 voci**, di cui **521 con riscrittura editoriale** e
**214 con sola uniformazione terminologica o del verbo di comando**. La seconda
categoria non certifica il resto della frase. L’elenco prima/dopo con tipo di
revisione è in `italiano-revisione.json`.

## Terminologia

| Funzione | Termine italiano |
| --- | --- |
| Fasi commerciali e relative schede | Funnel, fase, trattativa |
| Potenziale contatto nel CRM | Lead (mai piombo) |
| Azienda dell’operatore | Organizzazione / attività |
| Operatore automatico | Assistente IA / agente |
| Configurazione non pubblicata | Bozza |
| Collegamento al provider | Account collegato |
| Trasmissione di messaggi o conversioni | Invio; attivo, sospeso o in attesa |
| Vista del messaggio prima dell’invio | Anteprima del messaggio |
| Ripresa automatica di una conversazione | Ricontatto automatico |

## Verifica e limiti

Il workflow Linux 37162939077 ha superato typecheck, lint senza errori e 54 test
su 7 file. La revisione è pubblicata nello staging su base stabile 1.70.0.
[Prova visiva dopo il deploy](italiano-revisione-live.jpg).

Il test `i18n-italiano.test.ts` verifica copertura e conservazione dei token su
tutto il catalogo. Esegue inoltre la funzione reale di diagnostica con invio
attivo/disattivato e controlla l’italiano risultante. Un controllo separato
preserva gli attributi HTML necessari al tracciamento.

Pubblicazione e prove effettivamente eseguite sono registrate nel
`docs/handoffs/REPORT-ilpiratacris-staging.md`. Non vengono considerati verificati
gli invii WhatsApp, i servizi IA, le conversioni pubblicitarie o le integrazioni
non configurate. Nessun dato reale è necessario per questa revisione.

**Le 8.889 voci non sono tutte editorialmente certificate.** Rimangono da
revisionare in dettaglio i moduli specialistici, le schermate amministrative
meno usate e le istruzioni lunghe non comprese nell’elenco. Contenuti salvati,
risposte generate dall’IA, email e testi delle estensioni esterne non derivano
necessariamente da questo catalogo. Le stesse parole portoghesi possono indicare
funzioni differenti: in questa modifica i contesti delle proposte si distinguono
tramite le descrizioni esistenti; non sono stati cambiati routing o componenti.
