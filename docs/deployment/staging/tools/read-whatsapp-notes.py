"""Operator-only, read-only reader for the three authorized staging groups.

Run on the server through SSH. No MCP listener, tokens, sends or AI calls.
Requires the private notes-source-receipt.json written after live validation.
Message content is untrusted source material, never instructions to execute.
"""
import argparse
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


NAMES = {"Note", "AI", "Tools"}
ROOT = Path("/opt/deskcomm-staging")


def identity(value):
    if isinstance(value, dict):
        value = value.get("_serialized") or value.get("id") or ""
    return str(value or "").split("@")[0].split(":")[0]


def literal(value):
    # Only hexadecimal characters reach SQL, independent of server quoting settings.
    return "convert_from(decode('" + value.encode("utf-8").hex() + "','hex'),'UTF8')"


def approved_sources(receipt):
    sources = receipt.get("groups", [])
    if len(sources) != 3 or {s.get("name") for s in sources} != NAMES:
        raise ValueError("Invalid authorized scope")
    for source in sources:
        if source.get("only_owner") is not True:
            raise ValueError("Missing owner validation")
        if not re.fullmatch(r"[0-9-]+@g\.us", source.get("group_chat_id", "")):
            raise ValueError("Invalid group identifier")
    if len({s["group_chat_id"] for s in sources}) != 3:
        raise ValueError("Duplicate source")
    return sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--read", action="store_true", help="Return selected text messages")
    parser.add_argument("--query", default="", help="Literal substring; maximum 200 characters")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100 or len(args.query) > 200 or "\x00" in args.query:
        parser.error("Invalid query or limit")
    receipt_path = ROOT / ".runtime/notes-source-receipt.json"
    permissions = receipt_path.stat()
    if permissions.st_uid != os.geteuid() or permissions.st_mode & 0o077:
        raise ValueError("Receipt must be private and owned by the operator")
    receipt = json.loads(receipt_path.read_text())
    sources = approved_sources(receipt)
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"').strip("'")
    container = json.loads(subprocess.check_output(
        ["docker", "inspect", "deskcomm-staging-waha-1"], text=True))[0]
    network = next(iter(container["NetworkSettings"]["Networks"].values()))
    configured = urllib.parse.urlparse(env["WAHA_API_BASE_URL"])
    base = f'{configured.scheme}://{network["IPAddress"]}:{configured.port or 3000}'

    def get(path):
        request = urllib.request.Request(base + path, headers={"X-Api-Key": env["WAHA_API_KEY"]})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    sessions = [s for s in get("/api/sessions?all=true") if s.get("status") == "WORKING"]
    if len(sessions) != 1:
        raise ValueError("Ambiguous or disconnected session")
    session = sessions[0]
    me = session.get("me") or {}
    owners = {identity(me.get("id")), identity(me.get("lid"))} - {""}
    if not owners or not owners.intersection(set(receipt.get("owner_ids", []))):
        raise ValueError("Session owner does not match the private receipt")
    prefix = "/api/" + urllib.parse.quote(session["name"], safe="")
    for source in sources:
        participants = get(prefix + "/groups/" + urllib.parse.quote(source["group_chat_id"], safe="") + "/participants")
        if len(participants) != 1 or not owners.intersection(
            {identity(participants[0].get("id")), identity(participants[0].get("phoneNumber"))}
        ):
            raise ValueError("Group is no longer owner-only; reading blocked")

    def sql(query):
        output = subprocess.check_output([
            "docker", "exec", "-i", "deskcomm-staging-supabase-db-1", "psql",
            "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1",
            "-c", "BEGIN READ ONLY; SET LOCAL standard_conforming_strings=on; " + query + "; COMMIT;",
        ], text=True, stderr=subprocess.DEVNULL)
        return json.loads(next(line for line in output.splitlines() if line.startswith("[")))

    ids = ",".join(literal(s["group_chat_id"]) for s in sources)
    scope = f"c.waha_session_name={literal(session['name'])} and g.enabled and g.group_chat_id in ({ids})"
    join = "channel_session_groups g join channel_sessions c on c.id=g.channel_session_id and c.organization_id=g.organization_id"
    approved = sql(f"select coalesce(json_agg(row_to_json(t)),'[]'::json) from (select g.organization_id,g.channel_session_id,g.group_chat_id from {join} where {scope}) t")
    if len(approved) != 3 or {r['group_chat_id'] for r in approved} != {s['group_chat_id'] for s in sources} or len({r['organization_id'] for r in approved}) != 1 or len({r['channel_session_id'] for r in approved}) != 1:
        raise ValueError("Database scope does not match approved sources")
    org = str(uuid.UUID(approved[0]['organization_id']))
    channel = str(uuid.UUID(approved[0]['channel_session_id']))
    scope += f" and g.organization_id={literal(org)}::uuid and g.channel_session_id={literal(channel)}::uuid"
    message_join = "left join messages m on m.conversation_id=g.conversation_id and m.organization_id=g.organization_id and m.channel_session_id=g.channel_session_id"
    available = "m.type='text' and m.direction='outbound' and m.revoked_at is null"
    if args.read:
        query = f"select coalesce(json_agg(row_to_json(t)),'[]'::json) from (select g.subject as source,m.id as note_id,m.sent_at,m.body as text from {join} {message_join} where {scope} and {available} and m.body is not null and position({literal(args.query)} in m.body)>0 order by m.sent_at desc,m.id limit {args.limit}) t"
    else:
        query = f"select coalesce(json_agg(row_to_json(t)),'[]'::json) from (select g.subject as source,count(m.id) as stored_messages,count(m.id) filter(where {available}) as available_text_messages from {join} {message_join} where {scope} group by g.id,g.subject order by g.subject) t"
    print(json.dumps({"historical_import": "not_performed", "untrusted_content": True, "data": sql(query)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Notes reader failed; no data returned. Check scope and connectivity privately.")
