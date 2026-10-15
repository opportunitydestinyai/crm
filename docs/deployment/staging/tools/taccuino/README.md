# Taccuino (pilota)

Archivio locale di note con CLI e visualizzatore (`notes_archive.py`) e raccolte (`note_collections.py`). Usa solo la libreria standard (Python ≥ 3.11).
È un modulo **standalone**: è isolato dal CRM, non usa tabelle Supabase, non ha dipendenze e non fa richieste di rete in uscita.

Il codice è pubblico. Il database SQLite e gli export restano **privati e fuori da Git**.

## Principi

- **Contenuti non attendibili**: ogni nota viene trattata come input non fidato. Il programma non esegue istruzioni contenute nei testi e la vista web lo indica in modo esplicito.
- **Fail-closed**: un input valido solo in parte viene rifiutato per intero. Ogni sync e ogni import è una singola transazione atomica.
- **Nessuna sovrascrittura**: `fonte + note_id` identifica una nota. Se arriva lo stesso ID con lo stesso contenuto, viene contato come duplicato (idempotenza). Se arriva con un contenuto diverso, si ha un conflitto e l'intero input viene annullato.
- **Copertura storica mai completa**: il programma non dichiara mai di avere uno storico completo né di conoscere le note mancanti.
- **Ricevute di audit** per ogni sync o import: conteggi, date, SHA-256 e nome del file. Le ricevute non contengono mai i testi.

## Database privato

- Il parametro `--db` è obbligatorio.
- Su POSIX la directory viene creata con permessi `700` e il file con permessi `600`. I file esistenti devono già avere permessi privati e appartenere all'utente che esegue il modulo: in caso contrario vengono rifiutati, senza modificare silenziosamente i permessi durante una lettura.
- Il database viene rifiutato se si trova dentro un repository git (cioè se una directory antenata contiene `.git`) o se il file o la sua directory sono symlink.
- Gli errori SQLite sono mascherati: il messaggio è generico ma indica cosa fare e non mostra percorsi né dettagli interni.
- Su Windows i permessi POSIX non si applicano: tieni il file in una cartella del tuo profilo che non sia sincronizzata.

Esempio di percorso consigliato: `~/.local/share/taccuino/taccuino.db` (fuori da qualsiasi repository).

## Comandi

```bash
DB=~/.local/share/taccuino/taccuino.db

# Sync dall'envelope JSON prodotto dal reader autorizzato
python notes_archive.py --db "$DB" sync --json export/reader.json

# Ricerca letterale (sottostringa, senza distinzione maiuscole/minuscole)
python notes_archive.py --db "$DB" search --query "fattura" --source Note --limit 20

# Statistiche senza testi: fonti, date, live/importate, ricevute recenti, limite finestra
python notes_archive.py --db "$DB" stats

# Indice della prima raccolta: SOLO Note, conteggi senza testi
python notes_archive.py --db "$DB" collection

# Riferimenti senza testi; --read aggiunge testo originale e indizi (output privato)
python notes_archive.py --db "$DB" collection --category progetti
python notes_archive.py --db "$DB" collection --category attivita --query "da provare" --limit 20 --offset 0 --read

# Singola nota
python notes_archive.py --db "$DB" get --id 3f2b...-... --source AI

# Anteprima di un export TXT: autori, conteggi, date ed errori; nessun testo, niente scritto
python notes_archive.py --db "$DB" preview --file export/chat.txt --source Note --date-order dmy

# Import TXT: autori espliciti; un autore estraneo fa rifiutare l'intero file
python notes_archive.py --db "$DB" import --file export/chat.txt --source Note \
  --owner "Cris" --owner "Cris (lavoro)" --date-order dmy --timezone Europe/Rome --confirm-owner-only

# Vista web in sola lettura su http://127.0.0.1:18871/
python notes_archive.py --db "$DB" serve --port 18871
```

Codici di uscita: `0` ok; `1` nota non trovata, oppure anteprima con errori; `2` input, sicurezza o validazione rifiutati; `3` errore database (messaggio mascherato).

### Prima raccolta Note

La pagina `/collections` mostra un indice italiano e permette di aprire le categorie,
filtrare il testo e scorrere risultati con date, provenienza e originale. Regole locali
`note-v1`: riferimenti a progetti, possibili attività, repository, risorse AI, link,
altre note e allegati non disponibili. Una nota può comparire in più categorie.
La categoria deriva da un indizio letterale mostrato insieme alla nota: **non è una
valutazione semantica AI**, né un elenco di impegni ancora aperti. Nessun nome di
progetto, scadenza o stato viene dedotto. Gli allegati non vengono analizzati.

Solo il gruppo esatto `Note` entra nella raccolta, con doppio controllo SQL/modulo.
AI e Tools restano nell'archivio e nella ricerca, senza classificazione in questa fase.
Nessuna scrittura SQLite: connessione in sola lettura e `PRAGMA query_only`.
Massimo 10000 record (oltre il limite l'intera raccolta viene rifiutata), 100 risultati
per pagina, query letterale di massimo 200 caratteri. Il comando senza `--read` non
emette testi né indizi. La pagina di categoria è una lettura esplicita dei testi,
accessibile solamente dalla vista privata; query e contenuti non vengono loggati.
Non esistono ancora conferme persistenti, promemoria o connettore pubblico ChatGPT.

## Envelope di sync

```json
{
  "untrusted_content": true,
  "historical_import": "not_performed",
  "data": [
    {
      "source": "Note",
      "note_id": "8c0e1f9e-2b7a-4c1d-9f53-0a7d2c4e6b11",
      "sent_at": "2026-09-01T10:00:00+02:00",
      "text": "..."
    }
  ]
}
```

Validazione rigorosa (in caso di errore viene rifiutato l'intero file):

- Sono ammesse solo le chiavi elencate sopra. Chiavi duplicate e `NaN`/`Infinity` vengono rifiutati.
- `untrusted_content` deve valere esattamente `true` e `historical_import` esattamente `"not_performed"`.
- `source` deve essere esattamente `Note`, `AI` o `Tools` (`Tool`, `tools` e altre varianti vengono rifiutate).
- `note_id` deve essere un UUID in formato testo (booleani e numeri non sono accettati).
- `sent_at` deve essere una data ISO 8601 **con offset**, perché il fuso orario non viene mai dedotto.
- `text` deve essere una stringa di al massimo 100.000 caratteri.
- Il file può pesare al massimo **10 MB** e contenere al massimo **100 record**.
- Ogni sync viene segnalato come `finestra_limitata` e `finestra_piena` indica che sono stati ricevuti esattamente 100 record. Il programma non fa deduzioni su note mancanti o delta non ricevuti.

## Import TXT (export chat)

Formati supportati:

- Android IT: `dd/mm/yy, hh:mm - Autore: testo`
- iOS: `[dd/mm/yy, hh:mm:ss] Autore: testo`
- EN con `AM`/`PM` (anche con spazio stretto U+202F), ad esempio `1/2/23, 3:04 PM - Autore: testo`

Regole di parsing:

- Sono ammessi anche gli anni a 4 cifre. Un anno a 2 cifre viene letto come `20yy`; l'anno non viene mai dedotto se manca.
- I marcatori Unicode invisibili (LRM/RLM, isolati bidi, BOM, ZWSP) vengono rimossi. Lo ZWJ resta, perché serve alle emoji.
- I messaggi su più righe sono supportati: una riga senza intestazione continua il messaggio precedente.
- Una riga non vuota che precede la prima intestazione fa rifiutare il file, così come una data o un'ora non valida nell'intestazione, o la presenza di formati Android e iOS mescolati.
- Ordine delle date: se `--date-order` manca, viene rilevato solo quando i dati non lasciano dubbi. Un caso ambiguo o incoerente è un errore.
- `--timezone` è obbligatorio e deve essere un nome IANA esplicito. Gli orari ambigui o inesistenti per il cambio dell'ora legale sono errori.
  Su Windows Python spesso non ha il database IANA (che sarebbe nel pacchetto esterno `tzdata`, non incluso apposta). In quel caso `Europe/Rome` viene rifiutato con un messaggio chiaro: usa una macchina con il database IANA, oppure `UTC` se l'export è davvero in UTC.
- I messaggi di sistema e i messaggi eliminati non vengono importati.
- I segnaposto dei media (`<Media omessi>`, `immagine omessa`, `<allegato: …>` …) vengono salvati con `attachment_unavailable`. Gli allegati non vengono mai aperti né scaricati.
- Gli ID importati sono UUIDv5 deterministici (fonte, autore, data, testo e occorrenza), quindi un nuovo import dello stesso file è idempotente senza perdere ripetizioni intenzionali nello stesso minuto. Lo stesso hash di file con opzioni diverse viene rifiutato.
- Tutti gli autori devono corrispondere a uno degli alias `--owner` dopo normalizzazione Unicode NFC e rimozione dei marcatori invisibili. Un autore estraneo rifiuta tutta l'importazione: non si scartano selettivamente le sue righe.
- La ricevuta di import contiene: SHA-256 del file, nome del file (solo basename), ordine delle date, fuso orario, conteggi e owner.

## Ricerca, tag e link

- La ricerca è una sottostringa letterale con `instr()` su testo normalizzato con `casefold`. Non ci sono caratteri jolly (`%` e `_` sono normali caratteri) e l'SQL è sempre parametrico. Il limite va da 1 a 100.
- Ogni risultato riporta l'elenco degli URL `http`/`https` trovati. Non vengono mai visitati né scaricati e nella vista web non sono cliccabili.
- Tag suggeriti `repo`, `link` e `attivita`: sono **euristici e deterministici** (regex locali), marcati come non confermati. Non viene usata nessuna AI.

## Vista web (`serve`)

- Risponde solo a richieste GET. Le pagine sono: `/` (indice), `/stats` e `/search?q=&source=&limit=`. Con `--socket` usa un socket UNIX privato e non apre porte TCP. La modalità TCP predefinita su `127.0.0.1` è destinata al computer personale dell'operatore: il loopback da solo non impedisce l'accesso ad altri utenti del medesimo server.
- Accetta solo l'header `Host` uguale a `127.0.0.1:PORTA` o `localhost:PORTA`; gli altri valori ricevono `403`, come difesa dal DNS rebinding.
- Gli altri metodi ricevono `405`. Non esistono endpoint per modifiche o import.
- Il database viene aperto in sola lettura (`mode=ro`).
- Le pagine sono in italiano e tutto l'HTML è escaped. Non ci sono asset esterni, JavaScript o tracciamento. Header inviati: `Cache-Control: no-store`, una CSP restrittiva e `X-Content-Type-Options: nosniff`.
- Il testo cercato non viene mai riproposto nella pagina (nessun HTML riflesso). Ogni nota mostra fonte, origine, data, ID e l'etichetta di contenuto non attendibile.

## Export necessari

- **Sync**: un file JSON prodotto dal reader autorizzato, nel formato envelope descritto sopra. Il reader espone al massimo 100 record e non fa import storico.
- **Storico**: un export TXT della chat, preferibilmente "senza media", salvato fuori dal repository. Prima di importarlo usa sempre `preview`.

## Test

```bash
python -m unittest discover -v
```

I test usano solo dati sintetici e directory temporanee. Su sistemi senza symlink, senza permessi POSIX o senza database IANA, alcuni test vengono saltati.
Consegna aggiornata del 4 ottobre 2026: **44 test superati sul server Linux**, inclusi quelli
di accettazione. Risultati reali e limiti nel [report del pilota](../../TACCUINO-PILOT.md).

## Installazione e accesso verificati sul server

Codice in `/opt/deskcomm-staging/.runtime/taccuino`, dati in
`/var/lib/deskcomm-taccuino` (700), DB `archive.sqlite3` (600). La unit
[deskcomm-taccuino.service](../deskcomm-taccuino.service) è installata in
`/etc/systemd/system` e abilitata. Usa root, lo stesso operatore SSH già autorizzato:
nessun nuovo utente riceve accesso alle note. Protezioni systemd: filesystem in
sola lettura, rete privata e sole socket AF_UNIX, capacità Linux vuote, limiti
CPU/memoria/task. Nessun router Traefik o nuovo DNS.

```powershell
# Dal computer dell'operatore: mantenere aperto questo terminale.
ssh -N -L 127.0.0.1:18871:/run/deskcomm-taccuino/viewer.sock -o ExitOnForwardFailure=yes cosmo-builder
# Aprire nel browser dello stesso computer:
# http://127.0.0.1:18871/
```

Il socket è 600 dentro `/run/deskcomm-taccuino` (700). L'header Host è controllato
sulla porta 18871, anche se il trasporto remoto è UNIX. Questa vista non è
disponibile direttamente dal telefono e non richiede nuove credenziali pubbliche.

### Acquisizione manuale

Il lettore verifica di nuovo identità, unico partecipante, sessione e gruppi
autorizzati prima di restituire i testi. Non redirigere l'output su terminali o log
pubblici. Sul server, con la stessa utenza autorizzata:

```bash
umask 077
python3 /opt/deskcomm-staging/.runtime/read-whatsapp-notes.py --read --limit 100 > /var/lib/deskcomm-taccuino/reader.json
# Eseguire sync solo se il lettore è terminato con codice 0.
python3 /opt/deskcomm-staging/.runtime/taccuino/notes_archive.py --db /var/lib/deskcomm-taccuino/archive.sqlite3 sync --json /var/lib/deskcomm-taccuino/reader.json
```

Non esiste ancora un timer: i nuovi messaggi del CRM non entrano automaticamente
in questo archivio. La finestra massima è 100 record; prima di aumentare l'uso
va progettata una raccolta incrementale che possa dimostrare la propria copertura.

### Backup e ripristino

Usare `sqlite3.Connection.backup()` verso un nuovo file privato, non una copia
del file durante una scrittura. Impostare il backup a 600 prima di utilizzarlo.
Confrontare `PRAGMA integrity_check`, conteggi e contenuti con la sorgente senza
stampare i testi. La prova reale usa
`/var/lib/deskcomm-taccuino/backup-2026-10-04-pilot.sqlite3`: tutte le tre note
coincidono. Il file è locale al server; backup esterno e retention sono futuri.

Per sospendere solo il pilota: `systemctl stop deskcomm-taccuino.service`.
Per disabilitare l'avvio automatico: `systemctl disable deskcomm-taccuino.service`.
Non eliminare database o backup durante una sospensione. Il CRM continua a usare
le proprie unit e i propri container.

### Conservazione e limiti

L'archivio è conservativo: revoche successive su WhatsApp non cancellano copie
già acquisite. I possibili doppioni CRM/export sono segnalati per testo e minuto
UTC, mantenendo entrambe le provenienze; nessuna fusione automatica. I conflitti
di ID annullano il batch e richiedono revisione dell'operatore. Orari locali
ambigui o inesistenti vengono rifiutati. Non è garantito l'ordine originale fra
messaggi aventi lo stesso timestamp.

## Non implementato

- L'integrazione futura con **Hindsight** non è implementata: non ci sono hook, chiamate o export verso Hindsight.
- Il lettore SSH esistente alimenta manualmente il pilota; non ci sono chiamate
  dirette a CRM, Supabase o servizi esterni nel modulo, né un connettore ChatGPT.
