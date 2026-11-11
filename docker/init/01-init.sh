#!/bin/bash
# Exécuté une seule fois, à la création du primaire.
set -e
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"

psql -v ON_ERROR_STOP=1 -U slonik -d labo <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SELECT pg_create_physical_replication_slot('replica1');

CREATE EXTENSION pageinspect;
CREATE EXTENSION pg_walinspect;
CREATE EXTENSION pg_buffercache;
CREATE EXTENSION pgstattuple;
CREATE EXTENSION pg_stat_statements;
CREATE EXTENSION pg_visibility;

-- La table du fil rouge. La ligne 42, c'est Gérard.
CREATE TABLE users (
  id         integer PRIMARY KEY,
  name       text NOT NULL,
  city       text NOT NULL,
  age        integer NOT NULL,
  created_at timestamptz NOT NULL
);
INSERT INTO users
SELECT i,
       CASE WHEN i = 42 THEN 'Gérard' ELSE 'user_' || i END,
       (ARRAY['Paris','Lyon','Marseille','Lille','Nantes','Trouville'])[1 + i % 6],
       18 + i % 60,
       now() - (i || ' minutes')::interval
FROM generate_series(1, 100000) i;

-- Une table corrélée à l'ordre physique et une autre mélangée : le planner s'en soucie.
CREATE TABLE orders (
  id        bigint PRIMARY KEY,
  user_id   integer NOT NULL REFERENCES users(id),
  status    text NOT NULL,
  amount    numeric(10,2) NOT NULL,
  placed_at timestamptz NOT NULL
);
INSERT INTO orders
SELECT i,
       (1 + (i::bigint * 7919) % 100000)::integer,
       CASE WHEN i % 100 = 0 THEN 'litige' WHEN i % 10 = 0 THEN 'annulée' ELSE 'livrée' END,
       (i % 50000) / 100.0,
       now() - ((400000 - i) || ' seconds')::interval
FROM generate_series(1, 400000) i;

-- Un compte en banque : le terrain de jeu des transactions et des deadlocks.
CREATE TABLE comptes (id integer PRIMARY KEY, titulaire text NOT NULL, solde integer NOT NULL);
INSERT INTO comptes VALUES (1, 'Gérard', 100), (2, 'Slonik', 100);

ANALYZE;
SQL
