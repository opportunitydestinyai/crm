"""Taccuino: raccolte per categoria del gruppo Note (pilota). Solo stdlib, Python >= 3.11.

Modulo puro: nessuna scrittura, nessuna rete, nessun processo e nessun import di notes_archive.
Le categorie sono indizi testuali deterministici da confermare: mai inferenze su nomi, stato,
scadenze o date. Il contenuto delle note è sempre NON attendibile e non viene mai eseguito.
"""
from __future__ import annotations

import itertools
import re
from collections.abc import Mapping
from urllib.parse import urlsplit

RULE_VERSION = "note-v1"
SCOPE = "Note"
CATEGORIES = {
    "progetti": "Riferimenti a progetti",
    "attivita": "Possibili attività",
    "repository": "Repository",
    "ai": "Risorse AI",
    "link": "Link",
    "altre": "Altre note",
    "allegati": "Allegati non disponibili",
}
MAX_TEXT_CHARS = 100_000
MAX_QUERY_CHARS = 200
MAX_RECORDS = 10_000
MAX_OFFSET = 10_000
MAX_LIMIT = 100
MAX_CLUE_CHARS = 200
ORIGINS = ("live", "imported")
NOTE_KEYS = ("source", "note_id", "sent_at", "origine", "text", "attachment_unavailable")

# Regex lineari: nessun quantificatore annidato, nessuna normalizzazione del testo (offset originali).
URL_RE = re.compile(r"\bhttps?://[^\s<>\"'`]+", re.I)
URL_TRAIL = ".,;:!?)]}"
REPO_HOSTS = frozenset({"github.com", "gitlab.com", "bitbucket.org",
                        "www.github.com", "www.gitlab.com", "www.bitbucket.org"})
PROJECT_RE = re.compile(r"\bprogett[oi]\b", re.I)
TASK_RE = re.compile(r"\b(?:todo|to-do|da[ \t]+fare|da[ \t]+provare|promemoria|scadenza|task|creare|configurare)\b",
                     re.I)
CHECKBOX_RE = re.compile(r"\[ \]")
REPO_WORD_RE = re.compile(r"\brepo(?:sitory)?\b", re.I)
# Solo termini espliciti: "ai" da solo è quasi sempre la preposizione italiana.
AI_RE = re.compile(r"\b(?:chatgpt|claude|llms?|intelligenza[ \t]+artificiale|modelli[ \t]+linguistici)\b", re.I)


# --- Validazione ------------------------------------------------------------

def _validate(note, where: str) -> None:
    """Messaggi senza contenuti delle note: citano solo la posizione del record."""
    if type(note) is not dict or any(k not in note for k in NOTE_KEYS):
        raise ValueError(f"{where}: attesi i campi {', '.join(NOTE_KEYS)}")
    if type(note["source"]) is not str or note["source"] != SCOPE:
        raise ValueError(f"{where}: fonte non ammessa (solo esattamente {SCOPE})")
    if type(note["note_id"]) is not str or not 1 <= len(note["note_id"]) <= 100:
        raise ValueError(f"{where}: note_id deve essere una stringa non vuota")
    if type(note["sent_at"]) is not str or not 1 <= len(note["sent_at"]) <= 40:
        raise ValueError(f"{where}: sent_at deve essere una stringa")
    if type(note["origine"]) is not str or note["origine"] not in ORIGINS:
        raise ValueError(f"{where}: origine deve essere live o imported")
    if type(note["text"]) is not str or len(note["text"]) > MAX_TEXT_CHARS:
        raise ValueError(f"{where}: text deve essere una stringa di al massimo {MAX_TEXT_CHARS} caratteri")
    if type(note["attachment_unavailable"]) is not bool:
        raise ValueError(f"{where}: attachment_unavailable deve essere un booleano")


# --- Classificazione --------------------------------------------------------

def _url_spans(text: str) -> list[tuple[int, int]]:
    """Posizioni degli URL http/https nel testo originale; nessun URL viene aperto."""
    spans = []
    for m in URL_RE.finditer(text):
        url = m.group(0).rstrip(URL_TRAIL)
        if url.partition("://")[2]:
            spans.append((m.start(), m.start() + len(url)))
    return spans


def _repo_host(url: str) -> bool:
    """Hostname reale (dopo eventuali credenziali), mai una sottostringa: evilgithub.com non vale."""
    try:
        parsed = urlsplit(url)
        return "\\" not in url and parsed.username is None and parsed.hostname in REPO_HOSTS
    except ValueError:
        return False


def _search(rx):
    def find(text, _urls):
        m = rx.search(text)
        return m.span() if m else None
    return find


def _first_url(_text, urls):
    return urls[0] if urls else None


def _first_repo_url(text, urls):
    return next((s for s in urls if _repo_host(text[s[0]:s[1]])), None)


# Ordinate come CATEGORIES; per ogni categoria vince la prima regola che trova un indizio.
RULES = (
    ("progetti", "progetto-parola", _search(PROJECT_RE)),
    ("attivita", "attivita-termine", _search(TASK_RE)),
    ("attivita", "attivita-casella", _search(CHECKBOX_RE)),
    ("repository", "repository-url-host", _first_repo_url),
    ("repository", "repository-parola", _search(REPO_WORD_RE)),
    ("ai", "ai-termine-esplicito", _search(AI_RE)),
    ("link", "link-http", _first_url),
)


def _clue(text: str, categoria: str, regola: str, span: tuple[int, int]) -> dict:
    start, end = span
    out = {"categoria": categoria, "regola": regola, "indizio": text[start:min(end, start + MAX_CLUE_CHARS)]}
    if end - start > MAX_CLUE_CHARS:
        out["indizio_troncato"] = True
    return out


def _classify(note: dict) -> list[dict]:
    if note["attachment_unavailable"]:
        # Il media non è disponibile: nessuna prova inventata dalla didascalia o dal segnaposto.
        return [{"categoria": "allegati", "regola": "media-mancante", "indizio": ""}]
    text = note["text"]
    urls = _url_spans(text)
    out, found = [], set()
    for categoria, regola, find in RULES:
        if categoria in found:
            continue
        span = find(text, urls)
        if span is not None:
            found.add(categoria)
            out.append(_clue(text, categoria, regola, span))
    return out or [{"categoria": "altre", "regola": "nessun-indizio", "indizio": ""}]


def classify(note: dict) -> list[dict]:
    """Indizi letterali (max 1 per categoria, max 200 caratteri) da confermare, mai inferenze."""
    _validate(note, "nota")
    return _classify(note)


# --- Raccolte ---------------------------------------------------------------

def _entry(note: dict, clues: list[dict], include_text: bool) -> dict:
    e = {"source": note["source"], "note_id": note["note_id"], "sent_at": note["sent_at"],
         "origine": note["origine"], "attachment_unavailable": note["attachment_unavailable"],
         "regole": [c["regola"] for c in clues], "untrusted_content": True, "stato_attuale": "non verificato"}
    if include_text:
        e["text"] = note["text"]
        e["indicatori"] = [dict(c) for c in clues]
    return e


def build_collection(notes, category=None, query=None, limit=20, offset=0, include_text=False) -> dict:
    """Conteggi sull'intero corpus Note; con una categoria, risultati filtrati e paginati.

    L'ordine dei risultati è quello dell'iterable (il chiamante ordina via SQL). La query è una
    sottostringa letterale casefold e non viene mai riproposta nell'output.
    """
    if category is not None and (type(category) is not str or category not in CATEGORIES):
        raise ValueError(f"categoria non ammessa: usa una di {', '.join(CATEGORIES)}")
    if query is not None and (type(query) is not str or not query.strip() or len(query) > MAX_QUERY_CHARS):
        raise ValueError(f"query: testo non vuoto di al massimo {MAX_QUERY_CHARS} caratteri")
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit deve essere un intero tra 1 e {MAX_LIMIT}")
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET:
        raise ValueError(f"offset deve essere un intero tra 0 e {MAX_OFFSET}")
    if type(include_text) is not bool:
        raise ValueError("include_text deve essere un booleano")
    if category is None and (query is not None or offset):
        raise ValueError("indice delle categorie: query e offset richiedono una categoria")
    if isinstance(notes, (str, bytes, bytearray, Mapping)):
        raise ValueError("notes deve essere una sequenza di note")
    try:
        it = iter(notes)
    except TypeError:
        raise ValueError("notes deve essere una sequenza di note") from None

    records, ids = [], set()
    for i, note in enumerate(itertools.islice(it, MAX_RECORDS + 1)):
        if i >= MAX_RECORDS:
            raise ValueError(f"oltre {MAX_RECORDS} record: input rifiutato")
        _validate(note, f"record {i}")
        if note["note_id"] in ids:
            raise ValueError(f"record {i}: note_id duplicato")
        ids.add(note["note_id"])
        records.append((note, _classify(note)))

    counts = dict.fromkeys(CATEGORIES, 0)
    texts = with_clues = multi = 0
    for note, clues in records:
        slugs = [c["categoria"] for c in clues]
        for slug in slugs:
            counts[slug] += 1  # una nota in più categorie conta in ciascuna
        if not note["attachment_unavailable"]:
            texts += 1
            with_clues += slugs != ["altre"]
        multi += len(slugs) > 1

    page, total = [], 0
    if category is not None:
        needle = query.casefold() if query is not None else None
        matched = [(n, c) for n, c in records if any(x["categoria"] == category for x in c)
                   and (needle is None or needle in n["text"].casefold())]
        total = len(matched)
        page = matched[offset:offset + limit]

    return {"scope": SCOPE, "versione_regole": RULE_VERSION, "untrusted_content": True, "da_confermare": True,
            "totale_record": len(records), "testi": texts, "allegati_non_disponibili": counts["allegati"],
            "testi_con_indizi": with_clues, "testi_senza_indizi": texts - with_clues,
            "record_multicategoria": multi,
            "categorie": [{"categoria": slug, "etichetta": label, "conteggio": counts[slug]}
                          for slug, label in CATEGORIES.items()],
            "filtro": {"categoria": category, "query_presente": query is not None, "limit": limit,
                       "offset": offset, "totale_filtrato": total, "has_more": offset + len(page) < total},
            "risultati": [_entry(n, c, include_text) for n, c in page]}
