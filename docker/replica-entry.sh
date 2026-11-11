#!/bin/sh
# Première fois : on clone le primaire (pg_basebackup), puis on démarre en hot standby.
set -e
export PGDATA=/var/lib/postgresql/data
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h primary -U replicator >/dev/null 2>&1; do sleep 1; done
  chmod 700 "$PGDATA"
  pg_basebackup -h primary -U replicator -D "$PGDATA" -X stream -S replica1 -R
fi
chmod 700 "$PGDATA"
exec postgres -c hot_standby=on -c max_connections=30 -c max_wal_senders=5 -c max_replication_slots=5
