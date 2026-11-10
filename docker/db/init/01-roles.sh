#!/bin/sh
# Runs once, when the database volume is first created.
# Creates the application role (no ownership, no RLS bypass) and the test database.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE "$BOS_APP_DB_USER" LOGIN PASSWORD '$BOS_APP_DB_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE "$BOS_TEST_DB" OWNER "$POSTGRES_USER";
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$BOS_APP_DB_USER";
GRANT CONNECT ON DATABASE "$BOS_TEST_DB" TO "$BOS_APP_DB_USER";
SQL
