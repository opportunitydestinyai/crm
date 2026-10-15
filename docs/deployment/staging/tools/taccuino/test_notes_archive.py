"""Test unittest per Taccuino: solo fixture sintetiche in directory temporanee."""
import contextlib
import hashlib
import http.client
import io
import json
import os
import sqlite3
import stat
import sys
import tempfile
import threading
import unittest
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import notes_archive as na  # noqa: E402

ANDROID = (
    "12/03/23, 09:15 - I messaggi e le chiamate sono crittografati end-to-end.\n"
    "12/03/23, 09:16 - Cris: Prima riga\n"
    "seconda riga con àèì 🙂\n"
    "13/03/23, 18:05 - Altro: messaggio di altri\n"
    "14/03/23, 07:00 - Cris: <Media omessi>\n"
    "14/03/23, 07:01 - Cris: todo vedi https://github.com/esempio/repo e ftp://x.y\n"
)
IOS = (
    "‎[01/02/2024, 21:05:09] Cris: ‎immagine omessa\n"
    "[01/02/2024, 21:06:10] ‎Cris: testo con‏ marcatori\n"
    "[01/02/2024, 21:07:00] ‎Cris ha aggiunto Luca\n"
)
OWNER_ARGS = ("--source", "Note", "--owner", "Cris", "--date-order", "dmy", "--timezone", "UTC",
              "--confirm-owner-only")


def envelope(records, **over):
    env = {"untrusted_content": True, "historical_import": "not_performed", "data": records}
    env.update(over)
    return env


def rec(text="ciao", source="Note", note_id=None, sent_at="2026-09-01T10:00:00+02:00"):
    return {"source": source, "note_id": note_id or str(uuid.uuid4()), "sent_at": sent_at, "text": text}


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.dir = Path(self._td.name)
        self.db = str(self.dir / "priv" / "taccuino.db")

    def tearDown(self):
        self._td.cleanup()

    def cli(self, *argv, db=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = na.main(["--db", db or self.db, *argv])
        return code, out.getvalue(), err.getvalue()

    def write(self, name, content):
        if isinstance(content, (dict, list)):
            content = json.dumps(content)
        if isinstance(content, str):
            content = content.encode("utf-8")
        path = self.dir / name
        path.write_bytes(content)
        return str(path)

    def sync(self, records, **over):
        return self.cli("sync", "--json", self.write("in.json", envelope(records, **over)))

    def stats(self):
        code, out, err = self.cli("stats")
        self.assertEqual(code, 0, err)
        return json.loads(out)


class ParseTests(unittest.TestCase):
    def test_android_it_multiline_system_and_media(self):
        msgs, errors, info = na.parse_chat(ANDROID)
        self.assertEqual(errors, [])
        self.assertEqual(info, {"formato": "android", "ordine_date": "dmy"})
        self.assertEqual([m["kind"] for m in msgs], ["system", "message", "message", "attachment", "message"])
        self.assertEqual(msgs[1]["author"], "Cris")
        self.assertEqual(msgs[1]["text"], "Prima riga\nseconda riga con àèì 🙂")
        self.assertEqual(msgs[1]["local"], datetime(2023, 3, 12, 9, 16))

    def test_ios_brackets_seconds_and_invisible_markers(self):
        msgs, errors, info = na.parse_chat(IOS, "dmy")
        self.assertEqual(errors, [])
        self.assertEqual(info["formato"], "ios")
        self.assertEqual([m["kind"] for m in msgs], ["attachment", "message", "system"])
        self.assertEqual((msgs[1]["author"], msgs[1]["text"]), ("Cris", "testo con marcatori"))
        self.assertEqual(msgs[1]["local"], datetime(2024, 2, 1, 21, 6, 10))

    def test_english_am_pm(self):
        text = "1/2/23, 3:04 PM - Ann: hello\n1/2/23, 12:30 AM - Ann: late\n12/31/23, 12:05 pm - Ann: noon\n"
        msgs, errors, _ = na.parse_chat(text, "mdy")
        self.assertEqual(errors, [])
        self.assertEqual([m["local"] for m in msgs],
                         [datetime(2023, 1, 2, 15, 4), datetime(2023, 1, 2, 0, 30), datetime(2023, 12, 31, 12, 5)])
        _, errors, _ = na.parse_chat("1/2/23, 13:04 PM - Ann: x\n", "mdy")
        self.assertTrue(errors)

    def test_date_order_ambiguity_fails_without_guessing(self):
        _, errors, info = na.parse_chat("01/02/23, 10:00 - A: x\n")
        self.assertIsNone(info["ordine_date"])
        self.assertIn("ambiguo", errors[0])
        _, errors, _ = na.parse_chat("13/01/23, 10:00 - A: x\n01/13/23, 10:00 - A: y\n")
        self.assertTrue(any("ambiguo" in e for e in errors))

    def test_orphan_line_invalid_date_and_mixed_formats(self):
        _, errors, _ = na.parse_chat("testo orfano\n12/03/23, 09:16 - Cris: x\n", "dmy")
        self.assertEqual(errors, ["riga 1: riga non valida prima della prima intestazione"])
        _, errors, _ = na.parse_chat("31/02/23, 10:00 - Cris: x\n", "dmy")
        self.assertEqual(errors, ["riga 1: data/ora dell'intestazione non valida"])
        _, errors, _ = na.parse_chat("12/03/23, 09:16 - Cris: a\n[12/03/23, 09:17:00] Cris: b\n", "dmy")
        self.assertIn("formati misti", errors[0])

    def test_urls_and_heuristic_tags(self):
        text = "vedi https://github.com/a/b, http://x.it/p?q=1. ftp://no javascript:alert(1) HTTPS://UP.it"
        self.assertEqual(na.extract_urls(text), ["https://github.com/a/b", "http://x.it/p?q=1", "HTTPS://UP.it"])
        self.assertEqual(na.suggest_tags("todo: clona il repo https://github.com/a/b"), ["attivita", "link", "repo"])
        self.assertEqual(na.suggest_tags("ciao a tutti"), [])


class ImportTests(Base):
    def test_preview_counts_without_bodies(self):
        f = self.write("chat.txt", ANDROID)
        code, out, _ = self.cli("preview", "--file", f, "--source", "Note")
        self.assertEqual(code, 0)
        r = json.loads(out)
        self.assertEqual(r["autori"], {"Cris": 3, "Altro": 1})
        self.assertEqual((r["messaggi_di_sistema"], r["prima_data_locale"]), (1, "2023-03-12"))
        for body in ("Prima riga", "messaggio di altri", "github"):
            self.assertNotIn(body, out)
        self.assertFalse(os.path.exists(self.db))
        code, out, _ = self.cli("preview", "--file", self.write("bad.txt", "orfano\n01/02/23, 10:00 - A: x\n"),
                                "--source", "AI")
        self.assertEqual(code, 1)
        self.assertTrue(json.loads(out)["errori"])

    def test_import_requires_confirm_owner_only(self):
        code, _, err = self.cli("import", "--file", self.write("chat.txt", ANDROID), *OWNER_ARGS[:-1])
        self.assertEqual(code, 2)
        self.assertIn("--confirm-owner-only", err)
        self.assertEqual(self.stats()["totale"], 0)

    def test_import_owner_only_receipt_and_idempotence(self):
        f = self.write("chat.txt", ANDROID.replace("13/03/23, 18:05 - Altro: messaggio di altri\n", ""))
        code, out, err = self.cli("import", "--file", f, *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        r = json.loads(out)
        self.assertEqual((r["importati"], r["non_owner_saltati"], r["messaggi_di_sistema_saltati"]), (3, 0, 1))
        self.assertEqual(r["allegati_non_disponibili"], 1)
        self.assertEqual(r["sha256"], hashlib.sha256(Path(f).read_bytes()).hexdigest())
        self.assertEqual((r["file"], r["ordine_date"], r["fuso_orario"]), ("chat.txt", "dmy", "UTC"))
        again = json.loads(self.cli("import", "--file", f, *OWNER_ARGS)[1])
        self.assertEqual((again["importati"], again["duplicati"]), (0, 3))
        self.assertEqual(json.loads(self.cli("search", "--query", "messaggio di altri")[1])["risultati"], [])
        hit = json.loads(self.cli("search", "--query", "MEDIA OMESSI")[1])["risultati"][0]
        self.assertTrue(hit["attachment_unavailable"])
        self.assertEqual(hit["origine"], "imported")
        st = self.stats()
        self.assertEqual(st["fonti"]["Note"]["imported"], 3)
        self.assertEqual(st["ricevute_recenti"][0]["file_sha256"], r["sha256"])
        self.assertNotIn("Prima riga", json.dumps(st))

    def test_import_rejects_whole_file_on_errors(self):
        no_order = [a for a in OWNER_ARGS if a not in ("--date-order", "dmy")]
        cases = (("orfano.txt", "orfano\n12/03/23, 09:16 - Cris: x\n", OWNER_ARGS),
                 ("data.txt", "12/03/23, 09:16 - Cris: ok\n31/02/23, 10:00 - Cris: x\n", OWNER_ARGS),
                 ("ambiguo.txt", "01/02/23, 10:00 - Cris: x\n", no_order))
        for name, content, args in cases:
            with self.subTest(name):
                code, _, err = self.cli("import", "--file", self.write(name, content), *args)
                self.assertEqual(code, 2)
                self.assertIn("file rifiutato", err)
        self.assertEqual(self.stats()["totale"], 0)

    def test_dst_ambiguous_or_missing_time_fails(self):
        try:
            na.load_tz("Europe/Rome")
        except na.ValidationError:
            self.skipTest("database IANA non disponibile su questo sistema")
        args = ["Europe/Rome" if a == "UTC" else a for a in OWNER_ARGS]
        for content in ("29/10/23, 02:30 - Cris: ora doppia\n", "26/03/23, 02:30 - Cris: ora inesistente\n"):
            with self.subTest(content=content[:8]):
                code, _, err = self.cli("import", "--file", self.write("dst.txt", content), *args)
                self.assertEqual(code, 2)
                self.assertIn("ambiguo o inesistente", err)
        code, _, err = self.cli("import", "--file", self.write("ok.txt", "15/07/23, 10:00 - Cris: estate\n"), *args)
        self.assertEqual(code, 0, err)
        hit = json.loads(self.cli("search", "--query", "estate")[1])["risultati"][0]
        self.assertTrue(hit["sent_at"].endswith("+02:00"))


class SyncTests(Base):
    def test_sync_idempotent_and_window_reported(self):
        recs = [rec("prima nota"), rec("seconda", source="AI")]
        code, out, err = self.sync(recs)
        self.assertEqual(code, 0, err)
        r = json.loads(out)
        self.assertEqual((r["inseriti"], r["duplicati"]), (2, 0))
        self.assertTrue(r["finestra_limitata"])
        self.assertFalse(r["finestra_piena"])
        self.assertEqual(r["historical_import"], "not_performed")
        self.assertIn("non verificato", r["copertura_storica"])
        again = json.loads(self.sync(recs)[1])
        self.assertEqual((again["inseriti"], again["duplicati"]), (0, 2))
        self.assertEqual(self.stats()["totale"], 2)

    def test_window_cap_100_records(self):
        code, out, err = self.sync([rec(f"n{i}") for i in range(100)])
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["finestra_piena"])
        code, _, err = self.sync([rec(f"m{i}") for i in range(101)])
        self.assertEqual(code, 2)
        self.assertIn("100", err)
        self.assertEqual(self.stats()["totale"], 100)

    def test_conflicting_id_rolls_back_whole_input(self):
        nid = str(uuid.uuid4())
        self.assertEqual(self.sync([rec("originale", note_id=nid)])[0], 0)
        code, _, err = self.sync([rec("nuova valida"), rec("modificata", note_id=nid)])
        self.assertEqual(code, 2)
        self.assertIn("conflitto", err)
        st = self.stats()
        self.assertEqual((st["totale"], len(st["ricevute_recenti"])), (1, 1))
        self.assertEqual(json.loads(self.cli("get", "--id", nid, "--source", "Note")[1])["text"], "originale")

    def test_same_id_across_sources_kept_separate(self):
        nid = str(uuid.uuid4())
        code, out, _ = self.sync([rec("in note", "Note", nid), rec("in ai", "AI", nid), rec("in tools", "Tools", nid)])
        self.assertEqual(json.loads(out)["inseriti"], 3)
        for src, text in (("Note", "in note"), ("AI", "in ai"), ("Tools", "in tools")):
            code, out, _ = self.cli("get", "--id", nid.upper(), "--source", src)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)["text"], text)
        self.assertEqual(self.cli("get", "--id", str(uuid.uuid4()), "--source", "Note")[0], 1)
        self.assertEqual(self.cli("get", "--id", "non-un-uuid", "--source", "Note")[0], 2)
        with self.assertRaises(SystemExit):
            self.cli("get", "--id", nid, "--source", "Tool")

    def test_strict_envelope_validation_fail_closed(self):
        good = rec()
        cases = {
            "untrusted false": envelope([good], untrusted_content=False),
            "untrusted int": envelope([good], untrusted_content=1),
            "historical": envelope([good], historical_import="performed"),
            "extra envelope key": envelope([good], extra=1),
            "data not list": envelope({"a": good}),
            "extra record key": envelope([{**good, "x": 1}]),
            "source Tool": envelope([{**good, "source": "Tool"}]),
            "source malicious": envelope([{**good, "source": "Note'); DROP TABLE notes;--"}]),
            "id bool": envelope([{**good, "note_id": True}]),
            "id int": envelope([{**good, "note_id": 123}]),
            "id not uuid": envelope([{**good, "note_id": "abc"}]),
            "date naive": envelope([{**good, "sent_at": "2026-09-01T10:00:00"}]),
            "date invalid": envelope([{**good, "sent_at": "2026-02-30T10:00:00+01:00"}]),
            "date bool": envelope([{**good, "sent_at": True}]),
            "text int": envelope([{**good, "text": 5}]),
            "text null": envelope([{**good, "text": None}]),
            "text too long": envelope([{**good, "text": "x" * (na.MAX_TEXT_CHARS + 1)}]),
            "valid then invalid": envelope([rec("valida"), {**good, "source": "tools"}]),
            "duplicate key": '{"untrusted_content": true, "untrusted_content": true, '
                             '"historical_import": "not_performed", "data": []}',
            "nan": '{"untrusted_content": true, "historical_import": "not_performed", "data": [NaN]}',
            "not json": "{nope",
            "top-level list": "[]",
        }
        for name, payload in cases.items():
            with self.subTest(name):
                code, _, err = self.cli("sync", "--json", self.write("bad.json", payload))
                self.assertEqual(code, 2, err)
                self.assertNotIn("DROP TABLE", err)
        code, _, err = self.cli("sync", "--json", self.write("big.json", b" " * (na.MAX_INPUT_BYTES + 1)))
        self.assertEqual(code, 2)
        self.assertIn("10 MB", err)
        self.assertEqual(self.stats()["totale"], 0)


class SearchStatsTests(Base):
    def test_search_literal_case_insensitive_and_injection_safe(self):
        texts = ["Ciao Mondo", "100% sicuro", "nota' OR '1'='1", "under_score", "Straße chiusa"]
        self.assertEqual(self.sync([rec(t) for t in texts])[0], 0)

        def q(query, *extra):
            code, out, err = self.cli("search", "--query", query, *extra)
            self.assertEqual(code, 0, err)
            return [r["text"] for r in json.loads(out)["risultati"]]

        self.assertEqual(q("CIAO"), ["Ciao Mondo"])
        self.assertEqual(q("%"), ["100% sicuro"])
        self.assertEqual(q("_"), ["under_score"])
        self.assertEqual(q("' OR '1'='1"), ["nota' OR '1'='1"])
        self.assertEqual(q("x'); DROP TABLE notes; --"), [])
        self.assertEqual(q("STRASSE"), ["Straße chiusa"])
        self.assertEqual(q("Ciao", "--source", "AI"), [])
        self.assertEqual(len(q("o", "--limit", "2")), 2)
        for bad in ("0", "101", "abc", "-1"):
            with self.subTest(limit=bad), self.assertRaises(SystemExit):
                self.cli("search", "--query", "x", "--limit", bad)
        self.assertEqual(self.stats()["totale"], 5)
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            with self.assertRaises(na.ValidationError):
                na.search(conn, "x", limit=True)

    def test_stats_without_bodies_and_history_status(self):
        self.sync([rec("SEGRETO-XYZ"), rec("altro", source="Tools", sent_at="2025-01-01T00:00:00Z")])
        st = self.stats()
        self.assertNotIn("SEGRETO", json.dumps(st))
        self.assertEqual(st["limite_finestra_sync"], 100)
        self.assertIn("incompleto", st["stato_storico"])
        self.assertEqual(st["fonti"]["Note"]["live"], 1)
        self.assertEqual(st["fonti"]["Tools"]["prima_utc"], "2025-01-01T00:00:00.000000+00:00")
        self.assertTrue(st["ricevute_recenti"][0]["window_limited"])
        self.assertEqual(st["ricevute_recenti"][0]["records_in"], 2)


class SafetyTests(Base):
    def test_db_inside_git_repo_refused(self):
        (self.dir / "repo" / ".git").mkdir(parents=True)
        db = str(self.dir / "repo" / "dati" / "t.db")
        code, _, err = self.cli("sync", "--json", self.write("in.json", envelope([rec()])), db=db)
        self.assertEqual(code, 2)
        self.assertIn("git", err)
        self.assertFalse(os.path.exists(db))

    def test_symlinked_db_or_dir_refused(self):
        self.assertEqual(self.sync([rec()])[0], 0)
        link, linkdir = self.dir / "link.db", self.dir / "linkdir"
        try:
            os.symlink(self.db, link)
            os.symlink(Path(self.db).parent, linkdir, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink non supportati su questo sistema")
        for db in (str(link), str(linkdir / "taccuino.db")):
            with self.subTest(db=db):
                code, _, err = self.cli("stats", db=db)
                self.assertEqual(code, 2)
                self.assertIn("symlink", err)

    @unittest.skipUnless(os.name == "posix", "permessi POSIX")
    def test_private_permissions(self):
        self.assertEqual(self.sync([rec()])[0], 0)
        self.assertEqual(stat.S_IMODE(os.stat(Path(self.db).parent).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.db).st_mode), 0o600)
        shared = self.dir / "shared"
        shared.mkdir()
        os.chmod(shared, 0o755)
        code, _, err = self.cli("sync", "--json", self.write("in.json", envelope([rec()])), db=str(shared / "t.db"))
        self.assertEqual(code, 2)
        self.assertIn("chmod 700", err)

    def test_db_errors_masked_but_actionable(self):
        Path(self.db).parent.mkdir(mode=0o700)
        Path(self.db).write_bytes(b"non un database " * 200)
        if os.name == "posix":
            os.chmod(self.db, 0o600)
        code, _, err = self.cli("sync", "--json", self.write("in.json", envelope([rec()])))
        self.assertEqual(code, 3)
        self.assertIn("Errore database", err)
        self.assertIn("--db", err)
        for leak in (str(self.dir), "not a database", "Traceback"):
            self.assertNotIn(leak, err)

    def test_serve_refuses_non_loopback_host(self):
        self.sync([rec()])
        code, _, err = self.cli("serve", "--host", "0.0.0.0")
        self.assertEqual(code, 2)
        self.assertIn("127.0.0.1", err)


class ServerTests(Base):
    def setUp(self):
        super().setUp()
        self.nid = str(uuid.uuid4())
        text = "<script>alert('x')</script> & \"q\" repo https://github.com/a/b"
        code, _, err = self.sync([rec(text, note_id=self.nid)])
        self.assertEqual(code, 0, err)
        self.srv = na.make_server(self.db, 0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, path="/", method="GET", host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=host is not None)
            if host is not None:
                conn.putheader("Host", host)
            conn.endheaders()
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read().decode("utf-8")
        finally:
            conn.close()

    def test_search_escapes_html_and_labels_provenance(self):
        status, headers, body = self.req("/search?q=SCRIPT&source=Note&limit=5")
        self.assertEqual(status, 200)
        self.assertNotIn("<script", body)
        self.assertIn("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt; &amp; &quot;q&quot;", body)
        for label in ("Testo archiviato", self.nid, "<strong>Origine:</strong> Messaggio acquisito dal CRM",
                      "da verificare", "Archivio parziale"):
            self.assertIn(label, body)
        self.assertNotIn('href="https://', body)
        self.assertNotIn("src=", body)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertIn("default-src 'none'", headers["content-security-policy"])

    def test_query_not_reflected(self):
        status, _, body = self.req("/search?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E")
        self.assertEqual(status, 200)
        self.assertNotIn("onerror", body)
        self.assertNotIn("img", body)

    def test_host_header_rebinding_and_methods(self):
        self.assertEqual(self.req(host=f"localhost:{self.port}")[0], 200)
        for host in ("evil.example", f"evil.example:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port + 1}"):
            with self.subTest(host=host):
                self.assertEqual(self.req(host=host)[0], 403)
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            with self.subTest(method=method):
                status, headers, _ = self.req("/search", method=method)
                self.assertEqual(status, 405)
                self.assertEqual(headers["allow"], "GET")

    def test_bad_params_404_and_stats_page(self):
        for path in ("/search?q=a&limit=101", "/search?q=a&source=Tool", "/search?q=a&limit=abc",
                     "/search?q=a&q=b", "/search?q=a&x=1"):
            with self.subTest(path=path):
                self.assertEqual(self.req(path)[0], 400)
        self.assertEqual(self.req("/nope")[0], 404)
        status, _, body = self.req("/stats")
        self.assertEqual(status, 200)
        self.assertIn("Statistiche", body)
        self.assertNotIn("alert", body)

    def test_web_connection_is_read_only(self):
        with contextlib.closing(sqlite3.connect(self.srv.db_uri, uri=True)) as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM notes")


if __name__ == "__main__":
    unittest.main()
