#!/usr/bin/env python3
"""Taccuino: archivio note locale (pilota). Solo stdlib, Python >= 3.11.

Modulo standalone isolato dal CRM: nessuna tabella Supabase, nessuna dipendenza,
nessuna richiesta di rete in uscita. Il contenuto delle note è sempre NON attendibile.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import html
import json
import os
import re
import sqlite3
import socketserver
import stat
import sys
import uuid
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import note_collections as collections

SOURCES = ("Note", "AI", "Tools")
MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
MAX_QUERY_CHARS = 200
SYNC_WINDOW = 100
DEFAULT_PORT = 18871
HISTORY_STATUS = (f"incompleto/non verificato: il sync legge una finestra limitata di {SYNC_WINDOW} record "
                  "senza import storico; gli import TXT coprono solo gli export forniti")
IMPORT_NS = uuid.UUID("6f1c2a52-6d0e-4b8e-9a51-7a1c0c7e2b10")
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# Marcatori invisibili tipici degli export (LRM/RLM, isolati bidi, BOM, ZWSP). ZWJ escluso: serve alle emoji.
INVIS = "\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff"
INVIS_RE = re.compile(f"[{INVIS}]")
HEAD_RE = re.compile(
    r"(\[)?(\d{1,2})/(\d{1,2})/(\d{4}|\d{2}),? (\d{1,2}):(\d{2})(?::(\d{2}))?"
    r"(?: ?([AaPp])\.?[Mm]\.?)?(?(1)\] | - )(.*)", re.S)
AUTHOR_RE = re.compile(r"([^:\n]{1,200}?): (.*)", re.S)
MEDIA_RE = re.compile(
    r"<media omess[io]>|<media omitted>|<(?:allegato|attached): [^>]*>|.+ \((?:file allegato|file attached)\)"
    r"|(?:immagine|image|foto|photo|video|audio|sticker|gif|documento|document) (?:omess[oa]|omitted)", re.I)
DELETED_RE = re.compile(r"(?:questo messaggio è stato eliminato|hai eliminato questo messaggio"
                        r"|this message was deleted|you deleted this message)\.?", re.I)
URL_RE = re.compile(r"\bhttps?://[^\s<>\"'`]+", re.I)
TAG_RULES = (
    ("repo", re.compile(r"github\.com|gitlab\.com|bitbucket\.org|\brepo(?:sitory)?\b|\bgit (?:clone|pull|push)\b", re.I)),
    ("attivita", re.compile(r"\b(?:todo|to-do|da fare|attività|task|promemoria|scadenza)\b|\[ \]", re.I)),
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('sync', 'import')),
  created_at TEXT NOT NULL, source TEXT, records_in INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, window_limited INTEGER NOT NULL DEFAULT 0,
  min_sent_utc TEXT, max_sent_utc TEXT, file_basename TEXT, file_sha256 TEXT,
  date_order TEXT, timezone TEXT, owners TEXT);
CREATE TABLE IF NOT EXISTS notes (
  source TEXT NOT NULL CHECK (source IN ('Note', 'AI', 'Tools')),
  note_id TEXT NOT NULL, sent_at TEXT NOT NULL, sent_utc TEXT NOT NULL,
  text TEXT NOT NULL, text_fold TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('live', 'imported')), author TEXT,
  attachment_unavailable INTEGER NOT NULL DEFAULT 0, content_sha256 TEXT NOT NULL,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  PRIMARY KEY (source, note_id));
CREATE INDEX IF NOT EXISTS notes_sent ON notes (sent_utc);
"""


class TaccuinoError(Exception):
    """Errore previsto: il messaggio è sicuro da mostrare (mai contenuti delle note)."""


class ValidationError(TaccuinoError):
    pass


class ParseError(TaccuinoError):
    pass


class SafetyError(TaccuinoError):
    pass


class ConflictError(TaccuinoError):
    pass


# --- Database privato -------------------------------------------------------

def _check_db_path(path: str, create: bool) -> Path:
    p = Path(os.path.abspath(path))
    if not p.name or p.name in (".", ".."):
        raise ValidationError("--db deve indicare un file")
    for q in (p, *p.parents):
        if q.is_symlink():
            raise SafetyError("percorso --db rifiutato: symlink non ammessi, usa un percorso reale")
    real_parent = Path(os.path.realpath(p.parent))
    for d in (real_parent, *real_parent.parents):
        if (d / ".git").exists():
            raise SafetyError("percorso --db rifiutato: è dentro un repository git; "
                              "usa una directory privata fuori da qualsiasi repository")
    if p.exists() and not p.is_file():
        raise SafetyError("--db non è un file regolare")
    if not p.parent.exists():
        if not create:
            raise ValidationError("database non trovato: esegui prima sync o import")
        os.makedirs(p.parent, mode=0o700, exist_ok=True)
        if os.name == "posix":
            os.chmod(p.parent, 0o700)
    if os.name == "posix" and stat.S_IMODE(os.stat(p.parent).st_mode) & 0o077:
        raise SafetyError("directory del database non privata: esegui chmod 700 sulla directory")
    if not p.exists():
        if not create:
            raise ValidationError("database non trovato: esegui prima sync o import")
        os.close(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    if os.name == "posix":
        file_stat = os.stat(p)
        if file_stat.st_uid != os.geteuid() or stat.S_IMODE(file_stat.st_mode) & 0o077:
            raise SafetyError("database non privato o di altro operatore: verifica proprietario e chmod 600")
    return p


def open_db(path: str, readonly: bool = False) -> sqlite3.Connection:
    p = _check_db_path(path, create=not readonly)
    if readonly:
        return sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True)
    conn = sqlite3.connect(p, isolation_level=None)
    try:
        conn.executescript(SCHEMA)
    except BaseException:
        conn.close()
        raise
    return conn


def _utc(dt: datetime) -> str:
    try:
        return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except (OverflowError, ValueError):
        raise ValidationError("data fuori dall'intervallo rappresentabile in UTC") from None


def _store(conn, records, origin, receipt):
    """Scrive tutto o niente; stesso fonte+id con stesso contenuto = duplicato, diverso = conflitto."""
    receipt = {"created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **receipt}
    inserted = duplicates = 0
    conn.execute("BEGIN IMMEDIATE")
    try:
        rid = conn.execute(f"INSERT INTO receipts ({', '.join(receipt)}) VALUES ({', '.join('?' * len(receipt))})",
                           tuple(receipt.values())).lastrowid
        for r in records:
            utc = _utc(r["sent"])
            digest = hashlib.sha256(f"{utc}\x1f{r['text']}".encode()).hexdigest()
            row = conn.execute("SELECT content_sha256 FROM notes WHERE source = ? AND note_id = ?",
                               (r["source"], r["note_id"])).fetchone()
            if row:
                if row[0] != digest:
                    raise ConflictError(f"conflitto di ID ({r['source']}/{r['note_id']}): contenuto diverso, "
                                        "nessuna sovrascrittura; intero input annullato")
                duplicates += 1
                continue
            conn.execute("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (r["source"], r["note_id"], r["sent"].isoformat(), utc, r["text"], r["text"].casefold(),
                          origin, r["author"], int(r["attachment"]), digest, rid))
            inserted += 1
        conn.execute("UPDATE receipts SET inserted = ?, duplicates = ? WHERE id = ?", (inserted, duplicates, rid))
        conn.execute("COMMIT")
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            conn.execute("ROLLBACK")
        raise
    return rid, inserted, duplicates


# --- Validazione rigorosa ---------------------------------------------------

def _source(v, where):
    if type(v) is not str or v not in SOURCES:
        raise ValidationError(f"{where}: fonte non ammessa (solo esattamente Note, AI, Tools)")
    return v


def _uuid(v, where):
    if type(v) is not str or not UUID_RE.fullmatch(v):
        raise ValidationError(f"{where}: note_id deve essere un UUID testuale 8-4-4-4-12")
    return v.lower()


def _iso(v, where):
    if type(v) is not str or not 10 <= len(v) <= 40:
        raise ValidationError(f"{where}: sent_at deve essere una stringa ISO 8601 con offset")
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        raise ValidationError(f"{where}: sent_at non è una data ISO valida") from None
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValidationError(f"{where}: sent_at senza offset di fuso orario (nessuna deduzione)")
    return dt


def _text(v, where):
    if type(v) is not str or len(v) > MAX_TEXT_CHARS:
        raise ValidationError(f"{where}: text deve essere una stringa di al massimo {MAX_TEXT_CHARS} caratteri")
    try:
        v.encode("utf-8")
    except UnicodeEncodeError:
        raise ValidationError(f"{where}: text contiene caratteri Unicode non validi") from None
    return v


def _read_limited(path) -> bytes:
    if not os.path.isfile(path):
        raise ValidationError("file di input non trovato o non regolare")
    with open(path, "rb") as fh:
        data = fh.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValidationError("file di input oltre il limite di 10 MB: rifiutato")
    return data


def _no_dupes(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValidationError("JSON non valido: chiave duplicata")
        out[k] = v
    return out


def _bad_const(_name):
    raise ValidationError("JSON non valido: NaN/Infinity non ammessi")


def parse_envelope(data: bytes) -> list[dict]:
    try:
        env = json.loads(data.decode("utf-8-sig"), object_pairs_hook=_no_dupes, parse_constant=_bad_const)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise ValidationError("JSON non valido o non UTF-8") from None
    if type(env) is not dict or set(env) != {"untrusted_content", "historical_import", "data"}:
        raise ValidationError("envelope non valido: chiavi attese untrusted_content, historical_import, data")
    if env["untrusted_content"] is not True:
        raise ValidationError("envelope non valido: untrusted_content deve essere true")
    if type(env["historical_import"]) is not str or env["historical_import"] != "not_performed":
        raise ValidationError("envelope non valido: historical_import deve essere \"not_performed\"")
    if type(env["data"]) is not list:
        raise ValidationError("envelope non valido: data deve essere una lista")
    if len(env["data"]) > SYNC_WINDOW:
        raise ValidationError(f"oltre {SYNC_WINDOW} record: input rifiutato (finestra del reader superata)")
    out = []
    for i, r in enumerate(env["data"]):
        where = f"record {i}"
        if type(r) is not dict or set(r) != {"source", "note_id", "sent_at", "text"}:
            raise ValidationError(f"{where}: campi attesi esattamente source, note_id, sent_at, text")
        out.append({"source": _source(r["source"], where), "note_id": _uuid(r["note_id"], where),
                    "sent": _iso(r["sent_at"], where), "text": _text(r["text"], where),
                    "author": None, "attachment": False})
    return out


def sync_file(conn, path) -> dict:
    recs = parse_envelope(_read_limited(path))
    utcs = [_utc(r["sent"]) for r in recs]
    rid, ins, dup = _store(conn, recs, "live", {
        "kind": "sync", "records_in": len(recs), "window_limited": 1,
        "min_sent_utc": min(utcs, default=None), "max_sent_utc": max(utcs, default=None)})
    return {"ricevuta": rid, "ricevuti": len(recs), "inseriti": ins, "duplicati": dup,
            "finestra_limitata": True, "limite_finestra": SYNC_WINDOW, "finestra_piena": len(recs) == SYNC_WINDOW,
            "historical_import": "not_performed", "copertura_storica": HISTORY_STATUS,
            "nota": "nessuna deduzione su note mancanti o delta non ricevuti"}


# --- Import TXT (export chat) ----------------------------------------------

def _local_dt(g, order) -> datetime:
    a, b, y, hh, mm, ss, ampm = g
    day, month = (int(a), int(b)) if order == "dmy" else (int(b), int(a))
    year = int(y) + (2000 if len(y) == 2 else 0)  # anno sempre presente nell'intestazione, mai dedotto
    hour = int(hh)
    if ampm:
        if not 1 <= hour <= 12:
            raise ValueError("ora am/pm fuori intervallo")
        hour = hour % 12 + (12 if ampm in "Pp" else 0)
    return datetime(year, month, day, hour, int(mm), int(ss or 0))


def parse_chat(text: str, date_order: str | None = None):
    """Restituisce (messaggi, errori, info). Gli errori citano solo numeri di riga, mai contenuti."""
    if date_order not in (None, "dmy", "mdy"):
        raise ValidationError("--date-order deve essere dmy o mdy")
    msgs, errors, fmts = [], [], set()
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # terminatore del file, non una riga aggiuntiva nel corpo
    for n, line in enumerate(lines, 1):
        s = line
        header = s.replace("\u202f", " ").replace("\u00a0", " ")
        m = HEAD_RE.match(header.lstrip(INVIS))
        if not m:
            if msgs:
                msgs[-1]["text"] += "\n" + INVIS_RE.sub("", s)
            elif s.strip(INVIS + " \t"):
                errors.append(f"riga {n}: riga non valida prima della prima intestazione")
            continue
        fmts.add("ios" if m.group(1) else "android")
        # Usa la posizione del corpo nella riga originale: conserva NBSP/NNBSP nelle note.
        rest = s.lstrip(INVIS)[m.start(9):]
        am = AUTHOR_RE.match(rest)
        raw = am.group(2) if am else ""
        msgs.append({"line": n, "g": m.groups()[1:8], "text": INVIS_RE.sub("", raw),
                     "author": unicodedata.normalize("NFC", INVIS_RE.sub("", am.group(1)).strip()) if am else None,
                     "marked": bool(raw) and raw[0] in INVIS})
    if len(fmts) > 1:
        errors.append("formati misti Android/iOS nello stesso file")
    if not msgs and not errors:
        errors.append("nessuna intestazione di messaggio riconosciuta")
    order = date_order
    if order is None and msgs:
        evidence = ({"dmy" for x in msgs if int(x["g"][0]) > 12} | {"mdy" for x in msgs if int(x["g"][1]) > 12})
        if len(evidence) == 1:
            order = evidence.pop()
        else:
            errors.append("ordine delle date ambiguo o incoerente: specifica --date-order dmy|mdy")
    for x in msgs:
        x["local"] = None
        if order:
            try:
                x["local"] = _local_dt(x["g"], order)
            except ValueError:
                errors.append(f"riga {x['line']}: data/ora dell'intestazione non valida")
        x["text"] = x["text"].rstrip()  # niente righe vuote finali accodate dalle continuazioni
        t = x["text"].strip()
        if x["author"] is None or DELETED_RE.fullmatch(t):
            x["kind"] = "system"
        elif MEDIA_RE.fullmatch(t.splitlines()[0] if t else ""):
            x["kind"] = "attachment"  # segnaposto: l'allegato non viene mai aperto né scaricato
        else:
            x["kind"] = "message"  # LRM/RLM in un testo normale non dimostra che sia un evento di sistema.
    return msgs, errors, {"formato": "/".join(sorted(fmts)) or None, "ordine_date": order}


def _decode_txt(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValidationError("il file TXT deve essere UTF-8") from None


def load_tz(name: str):
    if name in ("UTC", "Etc/UTC"):
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, KeyError, ValueError, OSError):
        raise ValidationError("--timezone non disponibile: usa un nome IANA esplicito (es. Europe/Rome); "
                              "senza database IANA sul sistema usa UTC") from None


def _localize(local: datetime, tz, line: int) -> datetime:
    a, b = local.replace(tzinfo=tz, fold=0), local.replace(tzinfo=tz, fold=1)
    if a.utcoffset() != b.utcoffset():
        raise ParseError(f"riga {line}: orario ambiguo o inesistente per cambio ora legale (nessuna deduzione)")
    return a


def preview_txt(path, source, date_order=None) -> dict:
    _source(source, "--source")
    raw = _read_limited(path)
    msgs, errors, info = parse_chat(_decode_txt(raw), date_order)
    kinds = Counter(x["kind"] for x in msgs)
    dates = sorted(x["local"] for x in msgs if x["local"] is not None)
    return {"anteprima": True, "file": os.path.basename(path), "sha256": hashlib.sha256(raw).hexdigest(),
            "fonte": source, **info,
            "autori": dict(Counter(x["author"] for x in msgs if x["kind"] != "system").most_common()),
            "messaggi": kinds["message"], "allegati_non_disponibili": kinds["attachment"],
            "messaggi_di_sistema": kinds["system"],
            "prima_data_locale": dates[0].date().isoformat() if dates else None,
            "ultima_data_locale": dates[-1].date().isoformat() if dates else None,
            "errori": errors[:50], "nota": "nessun contenuto mostrato e nessun dato scritto"}


def import_txt(conn, path, source, owners, date_order, tz_name, confirm_owner_only) -> dict:
    if not confirm_owner_only:
        raise ValidationError("import rifiutato: serve --confirm-owner-only (importa solo i messaggi degli --owner)")
    _source(source, "--source")
    if not owners or any(type(o) is not str or not o.strip() or len(o) > 200 for o in owners):
        raise ValidationError("--owner deve essere un'etichetta autore non vuota (ripetibile)")
    owners = [unicodedata.normalize("NFC", INVIS_RE.sub("", o).strip()) for o in owners]
    tz = load_tz(tz_name)
    raw = _read_limited(path)
    msgs, errors, info = parse_chat(_decode_txt(raw), date_order)
    if errors:
        raise ParseError("file rifiutato: " + "; ".join(errors[:5]))
    recs, seen, authors = [], Counter(), set()
    skipped = system = 0
    for x in msgs:
        if x["kind"] == "system":
            system += 1
            continue
        authors.add(x["author"])
        if x["author"] not in owners:
            raise ParseError("file rifiutato: autore non autorizzato; ricontrolla fonte e alias del titolare")
        if len(x["text"]) > MAX_TEXT_CHARS:
            raise ParseError(f"riga {x['line']}: messaggio oltre {MAX_TEXT_CHARS} caratteri")
        sent = _localize(x["local"], tz, x["line"])
        key = "\x1f".join((source, x["author"], _utc(sent), x["text"]))
        seen[key] += 1  # messaggi identici nello stesso minuto restano distinti ma stabili tra re-import
        recs.append({"source": source, "note_id": str(uuid.uuid5(IMPORT_NS, f"{key}\x1f{seen[key]}")),
                     "sent": sent, "text": x["text"], "author": x["author"], "attachment": x["kind"] == "attachment"})
    utcs = [_utc(r["sent"]) for r in recs]
    sha = hashlib.sha256(raw).hexdigest()
    old = conn.execute("SELECT date_order, timezone, owners FROM receipts "
                       "WHERE kind='import' AND source=? AND file_sha256=?",
                       (source, sha)).fetchall()
    options = (info["ordine_date"], tz_name, json.dumps(sorted(set(owners)), ensure_ascii=False))
    if any(row != options for row in old):
        raise ConflictError("stesso export con opzioni diverse: rifiutato per evitare duplicati o date errate")
    if not recs:
        raise ParseError("file rifiutato: nessuna nota del titolare riconosciuta")
    rid, ins, dup = _store(conn, recs, "imported", {
        "kind": "import", "source": source, "records_in": len(recs), "skipped": skipped + system,
        "min_sent_utc": min(utcs, default=None), "max_sent_utc": max(utcs, default=None),
        "file_basename": os.path.basename(path), "file_sha256": sha, "date_order": info["ordine_date"],
        "timezone": tz_name, "owners": json.dumps(sorted(set(owners)), ensure_ascii=False)})
    return {"ricevuta": rid, "file": os.path.basename(path), "sha256": sha, "fonte": source, **info,
            "fuso_orario": tz_name, "candidati_owner": len(recs), "importati": ins, "duplicati": dup,
            "non_owner_saltati": skipped, "messaggi_di_sistema_saltati": system,
            "allegati_non_disponibili": sum(r["attachment"] for r in recs),
            "owner_non_trovati": sorted(set(owners) - authors), "copertura_storica": HISTORY_STATUS}


# --- Lettura ----------------------------------------------------------------

NOTE_COLS = "source, note_id, sent_at, origin, author, attachment_unavailable, text"


def extract_urls(text: str) -> list[str]:
    """Solo http/https; nessun link viene mai aperto o scaricato."""
    out = []
    for m in URL_RE.finditer(text):
        u = m.group(0).rstrip(".,;:!?)]}")
        if u.split("://", 1)[1] and u not in out:
            out.append(u)
    return out


def suggest_tags(text: str) -> list[str]:
    """Tag euristici deterministici (regex locali): suggerimenti, non inferenze confermate."""
    tags = {name for name, rx in TAG_RULES if rx.search(text)}
    if extract_urls(text):
        tags.add("link")
    return sorted(tags)


def _note(row) -> dict:
    src, nid, sent, origin, author, att, text = row
    return {"source": src, "note_id": nid, "sent_at": sent, "origine": origin, "autore": author,
            "attachment_unavailable": bool(att), "untrusted_content": True, "text": text,
            "url": extract_urls(text), "tag_suggeriti": suggest_tags(text), "tag_euristici_non_confermati": True}


def search(conn, query, source=None, limit=20) -> list[dict]:
    if type(query) is not str or not query.strip() or len(query) > MAX_QUERY_CHARS:
        raise ValidationError(f"query: testo non vuoto di al massimo {MAX_QUERY_CHARS} caratteri")
    if source is not None:
        _source(source, "source")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValidationError("limit deve essere un intero tra 1 e 100")
    # instr() = sottostringa letterale (nessun carattere jolly); casefold lato Python per Unicode.
    sql, args = f"SELECT {NOTE_COLS} FROM notes WHERE instr(text_fold, ?) > 0", [query.casefold()]
    if source:
        sql += " AND source = ?"
        args.append(source)
    sql += " ORDER BY sent_utc DESC, source, note_id LIMIT ?"
    return [_note(r) for r in conn.execute(sql, (*args, limit))]


def get_note(conn, note_id, source) -> dict | None:
    nid, src = _uuid(note_id, "--id"), _source(source, "--source")
    row = conn.execute(f"SELECT {NOTE_COLS} FROM notes WHERE source = ? AND note_id = ?", (src, nid)).fetchone()
    return _note(row) if row else None


def collect_notes(conn, category=None, query=None, limit=20, offset=0, include_text=False) -> dict:
    """Prima raccolta: solo Note, derivata in sola lettura, senza cambiare le fonti."""
    conn.execute("PRAGMA query_only = ON")
    rows = conn.execute(f"SELECT {NOTE_COLS} FROM notes WHERE source = ? "
                        "ORDER BY sent_utc DESC, note_id LIMIT 10001", ("Note",))
    try:
        return collections.build_collection((_note(row) for row in rows), category, query,
                                            limit, offset, include_text)
    except ValueError:
        raise ValidationError("Raccolta non valida: controlla categoria, ricerca, paginazione e record Note; massimo 10000") from None


def stats(conn) -> dict:
    fonti = {s: {"totale": 0, "live": 0, "imported": 0, "prima_utc": None, "ultima_utc": None} for s in SOURCES}
    for src, origin, n, lo, hi in conn.execute(
            "SELECT source, origin, COUNT(*), MIN(sent_utc), MAX(sent_utc) FROM notes GROUP BY source, origin"):
        f = fonti[src]
        f[origin] = n
        f["totale"] += n
        f["prima_utc"] = lo if f["prima_utc"] is None else min(f["prima_utc"], lo)
        f["ultima_utc"] = hi if f["ultima_utc"] is None else max(f["ultima_utc"], hi)
    cols = ("id", "kind", "created_at", "source", "records_in", "inserted", "duplicates", "skipped",
            "window_limited", "min_sent_utc", "max_sent_utc", "file_basename", "file_sha256", "date_order", "timezone")
    ricevute = [dict(zip(cols, r)) for r in conn.execute(
        f"SELECT {', '.join(cols)} FROM receipts ORDER BY id DESC LIMIT 50")]
    for r in ricevute:
        r["window_limited"] = bool(r["window_limited"])
    att = conn.execute("SELECT COUNT(*) FROM notes WHERE attachment_unavailable = 1").fetchone()[0]
    overlaps = conn.execute("SELECT COUNT(*) FROM notes a JOIN notes b ON a.source=b.source "
                           "AND a.text=b.text AND substr(a.sent_utc,1,16)=substr(b.sent_utc,1,16) "
                           "WHERE a.origin='live' AND b.origin='imported'").fetchone()[0]
    return {"fonti": fonti, "totale": sum(f["totale"] for f in fonti.values()), "allegati_non_disponibili": att,
            "sovrapposizioni_live_export_possibili": overlaps,
            "ricevute_recenti": ricevute, "limite_finestra_sync": SYNC_WINDOW, "stato_storico": HISTORY_STATUS,
            "nota": "nessun contenuto incluso"}


# --- Vista web in sola lettura ---------------------------------------------

E = html.escape
CSS = ("body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}"
       "pre{white-space:pre-wrap;background:#f4f4f4;padding:.5rem}pre,code{unicode-bidi:plaintext}.warn{color:#8a4b00}"
       "table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.2rem .5rem}")
SEC_HEADERS = (
    ("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store"), ("Pragma", "no-cache"),
    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
                                "base-uri 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("X-Frame-Options", "DENY"))


def _page(title: str, body: str) -> str:
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><title>{E(title)} · Taccuino</title>'
            f'<style>{CSS}</style></head><body><nav><a href="/">Taccuino</a> · <a href="/stats">Statistiche</a>'
            f' · <a href="/search">Ricerca</a> · <a href="/collections">Raccolta Note</a></nav><h1>{E(title)}</h1>'
            '<p class="warn">Archivio parziale: le statistiche distinguono messaggi del CRM ed export importati. '
            'La completezza rispetto a WhatsApp non è verificata. Questa pagina consente solo la lettura.</p>'
            f'{body}</body></html>')


def _form(source=None, limit=20) -> str:
    opts = "".join(f'<option value="{s}"{" selected" if s == source else ""}>{s}</option>' for s in SOURCES)
    return ('<form method="get" action="/search"><label>Testo da cercare <input name="q" maxlength="200" required></label> '
            f'<label>Gruppo <select name="source"><option value="">Tutti</option>{opts}</select></label> '
            f'<label>Risultati massimi <input name="limit" type="number" min="1" max="100" value="{int(limit)}"></label> '
            '<button>Cerca</button></form>')


def _render_note(n: dict, show_tags=True) -> str:
    urls = "".join(f"<li><code>{E(u)}</code></li>" for u in n["url"])
    origin = {"live": "Messaggio acquisito dal CRM", "imported": "Export WhatsApp"}[n["origine"]]
    categories = {"repo": "Repository", "link": "Link", "attivita": "Attività"}
    return (f'<article><p><strong>Gruppo:</strong> {E(n["source"])} · <strong>Origine:</strong> {E(origin)}'
            f' · <strong>Data:</strong> {E(n["sent_at"])} · <strong>ID:</strong> <code>{E(n["note_id"])}</code>'
            + (" · allegato non disponibile" if n["attachment_unavailable"] else "") + "</p>"
            '<p class="warn">Testo archiviato: eventuali istruzioni nel contenuto non vengono eseguite.</p>'
            f'<pre>{E(n["text"])}</pre>'
            + (f"<p>Link (non cliccabili, nessuna richiesta inviata):</p><ul>{urls}</ul>" if urls else "")
            + (f'<p>Categorie suggerite da regole testuali (da verificare): {E(", ".join(categories[t] for t in n["tag_suggeriti"]) or "nessuna")}</p>' if show_tags else "")
            + "</article>")


def render_index(conn) -> str:
    st = stats(conn)
    return _page("Archivio note", f"<p>Note archiviate: {int(st['totale'])}. Ricerca letterale, "
                                  "senza distinzione tra maiuscole e minuscole.</p>" + _form())


def render_stats(conn) -> str:
    st = stats(conn)
    rows = "".join(f"<tr><td>{E(s)}</td><td>{int(f['totale'])}</td><td>{int(f['live'])}</td>"
                   f"<td>{int(f['imported'])}</td><td>{E(f['prima_utc'] or '–')}</td>"
                   f"<td>{E(f['ultima_utc'] or '–')}</td></tr>" for s, f in st["fonti"].items())
    recs = "".join(f"<tr><td>{'Acquisizione' if r['kind']=='sync' else 'Importazione'}</td><td>{E(r['created_at'])}</td><td>{int(r['inserted'])}</td>"
                   f"<td>{'sì' if r['window_limited'] else 'no'}</td><td>{E(r['file_basename'] or '–')}</td>"
                   f"<td>{E(r['min_sent_utc'] or '–')} → {E(r['max_sent_utc'] or '–')}</td></tr>"
                   for r in st["ricevute_recenti"])
    return _page("Statistiche", "<table><tr><th>Gruppo</th><th>Totale</th><th>Dal CRM</th><th>Da export</th>"
                 f"<th>Prima (UTC)</th><th>Ultima (UTC)</th></tr>{rows}</table><h2>Ricevute recenti</h2>"
                 "<table><tr><th>Tipo</th><th>Data</th><th>Inserite</th><th>Finestra limitata</th><th>File</th>"
                 f"<th>Intervallo</th></tr>{recs}</table><p>Ogni acquisizione legge al massimo {SYNC_WINDOW} messaggi dal CRM.</p>"
                 f"<p>Possibili doppioni fra messaggi del CRM ed export: {st['sovrapposizioni_live_export_possibili']}. "
                 "Sono conservate entrambe le provenienze; nessuna fusione automatica.</p>"
                 "<p>Archivio conservativo: le successive revoche WhatsApp non eliminano copie già archiviate.</p>")


def render_search(conn, query_string: str) -> str:
    params = parse_qs(query_string, keep_blank_values=True, max_num_fields=10)
    if set(params) - {"q", "source", "limit"} or any(len(v) > 1 for v in params.values()):
        raise ValidationError("parametri non validi")
    q = params.get("q", [""])[0]
    limit = params.get("limit", ["20"])[0]
    if not re.fullmatch(r"\d{1,3}", limit):
        raise ValidationError("limit non valido")
    if not q:
        return _page("Ricerca", _form())
    source = params.get("source", [""])[0] or None
    notes = search(conn, q, source, int(limit))
    # Il testo cercato non viene mai riproposto nella pagina (nessun HTML riflesso).
    return _page("Ricerca", _form(source, int(limit)) + f"<p>Risultati: {len(notes)}.</p>" + "".join(map(_render_note, notes)))


def render_collection(conn, query_string: str) -> str:
    params = parse_qs(query_string, keep_blank_values=True, max_num_fields=10)
    if set(params) - {"category", "q", "limit", "offset"} or any(len(v) != 1 for v in params.values()):
        raise ValidationError("parametri raccolta non validi")
    category = params.get("category", [None])[0]
    q = params.get("q", [None])[0]
    lim, off = params.get("limit", ["20"])[0], params.get("offset", ["0"])[0]
    if not re.fullmatch(r"\d{1,3}", lim) or not re.fullmatch(r"\d{1,5}", off):
        raise ValidationError("paginazione non valida")
    data = collect_notes(conn, category, q, int(lim), int(off), include_text=category is not None)
    intro = ("<p>Prima raccolta del solo gruppo <strong>Note</strong>. Categorie suggerite da regole locali, "
             "da confermare: nessun modello AI ha analizzato i testi e nessuna attività è stata creata.</p>"
             "<p>Una nota storica non dimostra un impegno ancora aperto. Nomi di progetti, stato attuale "
             "e scadenze non vengono dedotti. Una nota può comparire in più categorie.</p>"
             f"<p>Record Note: {data['totale_record']}; testi: {data['testi']}; allegati non disponibili: "
             f"{data['allegati_non_disponibili']}. Regole: {E(data['versione_regole'])}.</p>")
    cats = "".join(f'<li><a href="/collections?{E(urlencode({"category": c["categoria"]}))}">'
                   f'{E(c["etichetta"])}</a>: {int(c["conteggio"])}</li>' for c in data["categorie"])
    body = intro + "<ul>" + cats + "</ul>"
    pagination = data["filtro"]
    if category is not None:
        body += (f'<h2>{E(collections.CATEGORIES[category])}</h2><form method="get" action="/collections">'
                 f'<input type="hidden" name="category" value="{E(category)}">'
                 '<label>Filtra il testo <input name="q" maxlength="200" required></label> '
                 '<button>Filtra</button></form>'
                 f'<p>Risultati nel filtro: {pagination["totale_filtrato"]}; visualizzati: {len(data["risultati"])} '
                 f'(da {pagination["offset"] + 1 if data["risultati"] else 0}).</p>')
        for n in data["risultati"]:
            proof = ", ".join(f'{E(collections.CATEGORIES[i["categoria"]])}: <code>{E(i["indizio"] or "nessun indizio testuale")}</code>'
                              for i in n["indicatori"])
            body += f'<p class="warn">Suggerimenti da confermare — {proof}. Stato attuale non verificato.</p>'
            body += _render_note(_note((n["source"], n["note_id"], n["sent_at"], n["origine"], None,
                                       n["attachment_unavailable"], n["text"])), show_tags=False)
        for label, offset in (("Precedenti", max(0, int(off)-int(lim))), ("Successivi", int(off)+int(lim))):
            if (label == "Precedenti" and int(off) > 0) or (label == "Successivi" and pagination["has_more"]):
                args = {"category": category, "limit": int(lim), "offset": offset}
                if q is not None:
                    args["q"] = q
                body += f'<p><a href="/collections?{E(urlencode(args))}">{label}</a></p>'
    return _page("Raccolta Note", body)


class _Handler(BaseHTTPRequestHandler):
    server_version = "Taccuino"
    sys_version = ""

    def log_message(self, fmt, *args):  # nessun log di query o contenuti
        pass

    def _send(self, code, body, extra=()):
        data = body.encode("utf-8")
        self.send_response(code)
        for k, v in (*SEC_HEADERS, *extra):
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        port = self.server.viewer_port
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1 or hosts[0] not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return self._send(403, _page("Richiesta rifiutata", "<p>Host non consentito.</p>"))
        try:
            url = urlsplit(self.path)
        except ValueError:
            return self._send(400, _page("Richiesta non valida", "<p>Percorso non valido.</p>"))
        routes = {"/": render_index, "/stats": render_stats, "/search": None, "/collections": None}
        if url.path not in routes:
            return self._send(404, _page("Pagina non trovata", "<p>Percorso inesistente.</p>"))
        try:
            with contextlib.closing(sqlite3.connect(self.server.db_uri, uri=True)) as conn:
                if url.path == "/search":
                    body = render_search(conn, url.query)
                elif url.path == "/collections":
                    body = render_collection(conn, url.query)
                else:
                    body = routes[url.path](conn)
        except (TaccuinoError, ValueError):
            message = ("Raccolta non valida: scegli una categoria Note, usa limit 1..100, offset 0..10000 "
                       "e una ricerca non vuota di massimo 200 caratteri. Controlla anche i record dell'archivio."
                       if url.path == "/collections" else
                       "Parametri non validi: limit 1..100, fonte Note, AI o Tools.")
            return self._send(400, _page("Richiesta non valida",
                                         f"<p>{message}</p>"))
        except sqlite3.Error:
            return self._send(500, _page("Errore database", "<p>Archivio non leggibile: controlla il file --db.</p>"))
        self._send(200, body)

    def _deny(self):
        self._send(405, _page("Metodo non consentito", "<p>Vista in sola lettura: solo GET.</p>"), (("Allow", "GET"),))

    do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = do_TRACE = do_CONNECT = _deny


def make_server(db_path: str, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    p = _check_db_path(db_path, create=False)
    srv = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    srv.daemon_threads = True
    srv.viewer_port = srv.server_address[1]
    srv.db_uri = p.resolve().as_uri() + "?mode=ro"
    return srv


def make_private_server(db_path: str, socket_path: str, viewer_port: int = DEFAULT_PORT):
    """Socket UNIX privato: nessuna porta TCP sul server condiviso."""
    if os.name != "posix" or not hasattr(socketserver, "ThreadingUnixStreamServer"):
        raise SafetyError("il socket privato richiede un sistema POSIX")
    if not socket_path:
        raise SafetyError("socket privato: percorso vuoto rifiutato, nessun fallback TCP")
    db = _check_db_path(db_path, create=False)
    target = Path(os.path.abspath(socket_path))
    if any(p.is_symlink() for p in (target, *target.parents)):
        raise SafetyError("socket privato: symlink rifiutato")
    parent = target.parent.stat()
    if parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o077:
        raise SafetyError("socket privato: directory deve appartenere all'operatore con permessi 700")
    if target.exists():
        raise SafetyError("socket già presente: non viene sovrascritto")
    srv = socketserver.ThreadingUnixStreamServer(str(target), _Handler)
    os.chmod(target, 0o600)
    srv.daemon_threads = True
    srv.viewer_port = viewer_port
    srv.db_uri = db.resolve().as_uri() + "?mode=ro"
    return srv


# --- CLI --------------------------------------------------------------------

def _limit(v: str) -> int:
    if not re.fullmatch(r"\d{1,3}", v) or not 1 <= int(v) <= 100:
        raise argparse.ArgumentTypeError("deve essere un intero tra 1 e 100")
    return int(v)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="notes_archive.py", description="Taccuino: archivio note locale (pilota).")
    p.add_argument("--db", required=True, help="file SQLite privato, fuori da qualsiasi repository git")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sync", help="salva un envelope JSON del reader autorizzato").add_argument("--json", required=True)
    s = sub.add_parser("search", help="ricerca letterale senza distinzione maiuscole/minuscole")
    s.add_argument("--query", required=True)
    s.add_argument("--source", choices=SOURCES)
    s.add_argument("--limit", type=_limit, default=20)
    sub.add_parser("stats", help="conteggi e date, senza contenuti")
    s = sub.add_parser("collection", help="raccolta suggerita del solo gruppo Note; senza testi per default")
    s.add_argument("--category", choices=collections.CATEGORIES)
    s.add_argument("--query")
    s.add_argument("--limit", type=_limit, default=20)
    s.add_argument("--offset", type=int, default=0)
    s.add_argument("--read", action="store_true", help="includi esplicitamente testi e indizi non attendibili")
    s = sub.add_parser("get", help="mostra una nota")
    s.add_argument("--id", required=True)
    s.add_argument("--source", required=True, choices=SOURCES)
    s = sub.add_parser("preview", help="anteprima di un export TXT senza contenuti")
    s.add_argument("--file", required=True)
    s.add_argument("--source", required=True, choices=SOURCES)
    s.add_argument("--date-order", choices=("dmy", "mdy"))
    s = sub.add_parser("import", help="importa solo i messaggi degli --owner da un export TXT")
    s.add_argument("--file", required=True)
    s.add_argument("--source", required=True, choices=SOURCES)
    s.add_argument("--owner", action="append", required=True)
    s.add_argument("--date-order", choices=("dmy", "mdy"))
    s.add_argument("--timezone", required=True, help="nome IANA esplicito, es. Europe/Rome")
    s.add_argument("--confirm-owner-only", action="store_true")
    s = sub.add_parser("serve", help="vista web locale in sola lettura")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s.add_argument("--socket", help="socket UNIX in una directory privata 700 (consigliato sul server)")
    return p


def _emit(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "preview":
            out = preview_txt(args.file, args.source, args.date_order)
            _emit(out)
            return 1 if out["errori"] else 0
        if args.cmd == "serve":
            if args.host != "127.0.0.1":
                raise SafetyError("--host ammette solo 127.0.0.1")
            if not 1 <= args.port <= 65535:
                raise ValidationError("--port deve essere tra 1 e 65535")
            factory = make_private_server(args.db, args.socket, args.port) if args.socket is not None else make_server(args.db, args.port)
            with factory as srv:
                print("Taccuino in sola lettura su socket privato" if args.socket else
                      f"Taccuino in sola lettura su http://127.0.0.1:{args.port}/ (Ctrl+C per uscire)", file=sys.stderr)
                with contextlib.suppress(KeyboardInterrupt):
                    srv.serve_forever()
            return 0
        with contextlib.closing(open_db(args.db, readonly=args.cmd in ("search", "stats", "get", "collection"))) as conn:
            if args.cmd == "sync":
                _emit(sync_file(conn, args.json))
            elif args.cmd == "import":
                _emit(import_txt(conn, args.file, args.source, args.owner, args.date_order,
                                 args.timezone, args.confirm_owner_only))
            elif args.cmd == "search":
                _emit({"untrusted_content": True, "risultati": search(conn, args.query, args.source, args.limit)})
            elif args.cmd == "stats":
                _emit(stats(conn))
            elif args.cmd == "collection":
                _emit(collect_notes(conn, args.category, args.query, args.limit, args.offset, args.read))
            else:
                note = get_note(conn, args.id, args.source)
                if note is None:
                    print("Nota non trovata per la fonte indicata.", file=sys.stderr)
                    return 1
                _emit(note)
        return 0
    except TaccuinoError as exc:
        print(f"Errore: {exc}", file=sys.stderr)
        return 2
    except sqlite3.Error:
        print("Errore database: operazione non completata, nessuna modifica parziale salvata. Verifica che --db "
              "indichi un archivio Taccuino valido, non in uso da altri processi e con spazio disponibile.",
              file=sys.stderr)
        return 3
    except OSError:
        print("Errore file: impossibile accedere al percorso indicato. Verifica esistenza e permessi.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    with contextlib.suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
