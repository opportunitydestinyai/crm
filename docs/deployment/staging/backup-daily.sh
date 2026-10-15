#!/usr/bin/env bash
# Dedicated staging only. Secrets and customer data stay in protected backups.
set -euo pipefail
umask 077
cd /opt/deskcomm-staging
install -d -m 700 backups
bash hostgator-setup-kit/backup.sh >> .runtime/backup-daily.log 2>&1
latest_db=$(find backups -maxdepth 1 -name 'db-*.sql.gz' -mmin -15 -print -quit)
latest_session=$(find backups -maxdepth 1 -name 'waha-*.tgz' -mmin -15 -print -quit)
latest_storage=$(find backups -maxdepth 1 -name 'storage-*.tgz' -mmin -15 -print -quit)
test -n "$latest_db" && test -n "$latest_session" && test -n "$latest_storage"
gzip -t "$latest_db"
tar tzf "$latest_session" >/dev/null
tar tzf "$latest_storage" >/dev/null
date -u +%FT%TZ > .runtime/backup-last-success
