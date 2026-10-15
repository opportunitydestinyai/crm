"""Prove aggiuntive del coordinatore: privacy, fedeltà e ripristino (dati sintetici)."""
import contextlib
import json
import os
import sqlite3
import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import notes_archive as na
from test_notes_archive import Base, OWNER_ARGS, rec


class AcceptanceTests(Base):
    def test_foreign_author_rejects_whole_import(self):
        text = "01/02/24, 10:00 - Cris: nota propria\n01/02/24, 10:01 - Altro: privata\n"
        code, out, err = self.cli("import", "--file", self.write("chat.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 2)
        self.assertIn("autore non autorizzato", err)
        self.assertNotIn("privata", out + err)
        self.assertEqual(self.stats()["totale"], 0)
        self.assertEqual(self.stats()["ricevute_recenti"], [])

    def test_invisible_marker_does_not_discard_owner_note(self):
        text = "[01/02/2024, 10:00:00] Cris: \u200enota da conservare 🙂\n"
        code, _, err = self.cli("import", "--file", self.write("ios.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        results = json.loads(self.cli("search", "--query", "conservare")[1])["risultati"]
        self.assertEqual(results[0]["text"], "nota da conservare 🙂")

    def test_final_newline_does_not_create_duplicate_note(self):
        text = "01/02/24, 10:00 - Cris: nota identica"
        for suffix in ("\n", ""):
            code, _, err = self.cli("import", "--file", self.write("chat.txt", text + suffix), *OWNER_ARGS)
            self.assertEqual(code, 0, err)
        self.assertEqual(self.stats()["totale"], 1)

    def test_live_export_overlap_is_reported_and_provenance_preserved(self):
        self.sync([rec("nota sovrapposta", sent_at="2024-02-01T10:00:15+00:00")])
        text = "01/02/24, 10:00 - Cris: nota sovrapposta\n"
        code, _, err = self.cli("import", "--file", self.write("chat.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        st = self.stats()
        self.assertEqual(st["totale"], 2)
        self.assertEqual(st["sovrapposizioni_live_export_possibili"], 1)
        origins = {n["origine"] for n in json.loads(self.cli("search", "--query", "sovrapposta")[1])["risultati"]}
        self.assertEqual(origins, {"live", "imported"})

    def test_empty_later_snapshot_does_not_imply_deletion(self):
        self.sync([rec("conservata")])
        self.sync([])
        self.assertEqual(self.stats()["totale"], 1)
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            self.assertIn("revoche WhatsApp non eliminano", na.render_stats(conn))

    def test_read_only_access_never_chmods_database(self):
        self.sync([rec()])
        with patch.object(na.os, "chmod", side_effect=OSError("filesystem readonly")):
            self.assertEqual(self.cli("stats")[0], 0)

    def test_same_export_different_timezone_rejected(self):
        f = self.write("chat.txt", "01/02/24, 10:00 - Cris: salvata\n")
        self.assertEqual(self.cli("import", "--file", f, *OWNER_ARGS)[0], 0)
        options = ["Etc/GMT-1" if a == "UTC" else a for a in OWNER_ARGS]
        try:
            na.load_tz("Etc/GMT-1")
        except na.ValidationError:
            self.skipTest("database IANA non disponibile")
        code, _, err = self.cli("import", "--file", f, *options)
        self.assertEqual(code, 2)
        self.assertIn("opzioni diverse", err)
        self.assertEqual(self.stats()["totale"], 1)

    def test_media_caption_and_nonbreaking_space_preserved(self):
        text = "01/02/24, 10:00 - Cris: foto.jpg (file allegato)\ndidascalia con\u00a0spazio\n"
        code, _, err = self.cli("import", "--file", self.write("chat.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        n = json.loads(self.cli("search", "--query", "didascalia")[1])["risultati"][0]
        self.assertTrue(n["attachment_unavailable"])
        self.assertIn("con\u00a0spazio", n["text"])

    def test_overflow_date_is_safe_and_atomic(self):
        code, _, err = self.sync([rec("nota valida"), rec(sent_at="0001-01-01T00:00:00+23:59")])
        self.assertEqual(code, 2)
        self.assertNotIn("Traceback", err)
        self.assertEqual(self.stats()["totale"], 0)

    @unittest.skipUnless(os.name == "posix", "socket UNIX")
    def test_private_socket_permissions_and_read_only_http(self):
        self.sync([rec("sintetica")])
        runtime = self.dir / "runtime"
        runtime.mkdir(mode=0o700)
        sock_path = runtime / "viewer.sock"
        srv = na.make_private_server(self.db, str(sock_path))
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertEqual(sock_path.stat().st_mode & 0o777, 0o600)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(sock_path))
                client.sendall(b"GET /stats HTTP/1.0\r\nHost: 127.0.0.1:18871\r\n\r\n")
                response = b""
                while chunk := client.recv(4096):
                    response += chunk
            self.assertIn(b"200 OK", response)
            self.assertIn(b"Statistiche", response)
            self.assertNotIn(b"sintetica", response)
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join()

    @unittest.skipUnless(os.name == "posix", "socket UNIX")
    def test_empty_socket_path_cannot_fall_back_to_tcp(self):
        self.sync([rec()])
        code, _, err = self.cli("serve", "--socket", "")
        self.assertEqual(code, 2)
        self.assertIn("nessun fallback TCP", err)

    def test_unicode_line_separator_stays_inside_message(self):
        text = "01/02/24, 10:00 - Cris: prima\u202801/02/24, 11:00 - Cris: resta nel testo\n"
        code, _, err = self.cli("import", "--file", self.write("chat.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.stats()["totale"], 1)

    @unittest.skipUnless(os.name == "posix", "permessi POSIX")
    def test_shared_database_refused_without_silent_permission_change(self):
        self.sync([rec()])
        os.chmod(self.db, 0o644)
        self.assertEqual(self.cli("stats")[0], 2)
        self.assertEqual(Path(self.db).stat().st_mode & 0o777, 0o644)

    def test_viewer_coverage_notice_remains_true_after_export_import(self):
        text = "01/02/24, 10:00 - Cris: nota storica sintetica\n"
        code, _, err = self.cli("import", "--file", self.write("chat.txt", text), *OWNER_ARGS)
        self.assertEqual(code, 0, err)
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            page = na.render_stats(conn)
        self.assertIn("export importati", page)
        self.assertIn("completezza rispetto a WhatsApp non è verificata", page)
        self.assertNotIn("servono gli export dei tre gruppi", page)

    def test_search_page_preserves_applied_group_and_limit(self):
        self.sync([rec()])
        with contextlib.closing(na.open_db(self.db, readonly=True)) as conn:
            page = na.render_search(conn, "q=nessuna&source=AI&limit=7")
        self.assertIn('<option value="AI" selected>AI</option>', page)
        self.assertIn('value="7"', page)
        self.assertIn("Risultati: 0.", page)

    def test_backup_restores_exact_counts_and_content(self):
        self.sync([rec("nota salvata"), rec("seconda", source="Tools")])
        backup = str(self.dir / "priv" / "backup.db")
        with contextlib.closing(na.open_db(self.db, readonly=True)) as src:
            with contextlib.closing(sqlite3.connect(backup)) as dst:
                src.backup(dst)
        if os.name == "posix":
            os.chmod(backup, 0o600)
        restored = json.loads(self.cli("stats", db=backup)[1])
        self.assertEqual(restored, self.stats())
        hits = json.loads(self.cli("search", "--query", "salvata", db=backup)[1])["risultati"]
        self.assertEqual(hits[0]["text"], "nota salvata")


if __name__ == "__main__":
    unittest.main()
