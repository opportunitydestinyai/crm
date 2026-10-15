"""Prove indipendenti dell'integrazione raccolte: solo dati sintetici."""
import contextlib
import hashlib
import json
import sqlite3
import threading
import urllib.error
import urllib.request
from pathlib import Path

import notes_archive as na
import note_collections as nc
from test_notes_archive import Base, rec


class CollectionAcceptance(Base):
    def test_ambiguous_repository_urls_are_not_repository_clues(self):
        for text in ("https://evil.test\\@github.com/x", "https://user@github.com/x"):
            n = dict(rec(text), origine="live", attachment_unavailable=False)
            self.assertEqual([c["categoria"] for c in nc.classify(n)], ["link"])

    def test_sql_scope_and_explicit_read(self):
        self.sync([rec("progetto segreto sintetico"), rec("progetto fuori scope", source="AI"),
                   rec("progetto fuori scope tools", source="Tools")])
        code, out, err = self.cli("collection", "--category", "progetti")
        self.assertEqual(code, 0, err)
        data = json.loads(out)
        self.assertEqual(data["totale_record"], 1)
        self.assertEqual(data["filtro"]["totale_filtrato"], 1)
        self.assertNotIn("segreto", out)
        self.assertNotIn("indicatori", out)
        result = json.loads(self.cli("collection", "--category", "progetti", "--read")[1])["risultati"][0]
        self.assertEqual(result["text"], "progetto segreto sintetico")
        self.assertEqual(result["source"], "Note")
        self.assertEqual(result["stato_attuale"], "non verificato")
        self.assertIn("note_id", result)
        self.assertIn("sent_at", result)

    def test_read_never_changes_archive(self):
        self.sync([rec("da provare")])
        before = hashlib.sha256(Path(self.db).read_bytes()).hexdigest()
        self.assertEqual(self.cli("collection")[0], 0)
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            na.collect_notes(conn)
            self.assertEqual(conn.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM notes")
        self.assertEqual(hashlib.sha256(Path(self.db).read_bytes()).hexdigest(), before)

    def test_html_escapes_and_pagination_preserves_filter(self):
        self.sync([rec('<script>alert(1)</script> progetto https://example.test/?a=<x>') for _ in range(3)])
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            body = na.render_collection(conn, "category=progetti&limit=1&q=progetto")
        self.assertNotIn("<script>", body)
        self.assertIn("&lt;script&gt;", body)
        self.assertIn("offset=1&amp;q=progetto", body)
        self.assertIn("Suggerimenti da confermare", body)
        self.assertIn("Stato attuale non verificato", body)
        self.assertNotIn("Categorie suggerite da regole testuali", body)
        self.assertIn("<code>progetto</code>", body)

    def test_invalid_queries_rejected_without_reflecting_input(self):
        self.sync([rec()])
        for query in ("category=AI", "category=progetti&category=link", "source=Tools",
                      "category=link&offset=-1", "category=link&limit=101", "q=privato"):
            with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
                with self.assertRaises((na.ValidationError, ValueError)) as err:
                    na.render_collection(conn, query)
                self.assertNotIn("privato", str(err.exception))

    def test_http_new_route_inherits_privacy_and_readonly(self):
        self.sync([rec("progetto sintetico")])
        server = na.make_server(str(self.db), 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.viewer_port}/collections"
        try:
            with urllib.request.urlopen(url) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("no-store", response.headers["Cache-Control"])
                self.assertIn("default-src 'none'", response.headers["Content-Security-Policy"])
                self.assertIn("Record Note: 1", response.read().decode())
            for request, expected in ((urllib.request.Request(url, method="POST"), 405),
                                      (urllib.request.Request(url + "?category=AI"), 400),
                                      (urllib.request.Request(url, headers={"Host": "evil.test"}), 403)):
                with self.assertRaises(urllib.error.HTTPError) as err:
                    urllib.request.urlopen(request)
                self.assertEqual(err.exception.code, expected)
                if expected == 400:
                    self.assertIn("scegli una categoria Note", err.exception.read().decode())
                err.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
