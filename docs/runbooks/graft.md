# Manutenzione del progetto con Graft

Graft indicizza il codice e le sue dipendenze per aiutare a valutare le modifiche.
Non aggiorna il software upstream e non pubblica sul server. La versione CLI
verificata in questo workspace è **0.21.1**.

## Preparazione e aggiornamento

Installare la stessa CLI su un nuovo ambiente:

```sh
npm install -g @nanonets/graft@0.21.1
pnpm graft:build
pnpm graft:check
```

Rigenerare il grafo dopo un aggiornamento Git e prima dei commit che cambiano
codice; `graft check` deve terminare con successo. Quando segnala un indice
obsoleto, ripetere `graft build` e il controllo. `graft map`, `graft callers` e
`graft blast` aiutano a seguire le dipendenze: consultare il rispettivo `--help`.

Si usa il parsing locale senza `--deep`, senza chiavi LLM e senza registrare
hook o configurazioni globali degli assistenti. I comandi del progetto richiedono
la CLI nel PATH; non viene aggiunta alle dipendenze del runtime CRM.

## Grafo, documentazione e pubblicazione

`graft/` contiene l'indice generato e non viene committato. Il build gestisce
anche `.ignore` per consentire alle ricerche locali di leggere il grafo ignorato
da Git. I JSON sotto `docs/architecture/` descrivono i contratti del prodotto e
rimangono la fonte versionata: Graft non li sostituisce.

Il percorso operativo è codice → `graft build` → indice locale → `graft check`
→ commit; un controllo fallito torna al build, poi al controllo. Le istruzioni
in `AGENTS.md` e `CLAUDE.md` mantengono questo ciclo per le prossime modifiche.

Non serve una voce in Gestione funzioni: è uno strumento di sviluppo, senza
nuove capacità, permessi o schermate amministrative nel CRM.

Il push su `main` pubblica il fork GitHub e attiva i workflow già presenti,
compresa la costruzione delle immagini. Lo staging resta fissato alla sua
immagine stabile italiana: la pubblicazione Git non modifica i container.
