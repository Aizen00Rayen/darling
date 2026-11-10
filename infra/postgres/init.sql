-- Runs once, as the postgres superuser, on a fresh data volume
-- (mounted into /docker-entrypoint-initdb.d). CI runs the same file against
-- its Postgres service container.
--
-- Roles:
--   darling_owner  owns the databases and the public schema; runs migrations and
--                  the test harness (CREATEDB). Creates the citext extension in
--                  migrations (trusted extension, allowed for a database owner).
--   darling_app    runtime role: LOGIN only, DML on tables created by darling_owner.

CREATE ROLE darling_owner LOGIN CREATEDB PASSWORD 'darling_owner';
CREATE ROLE darling_app LOGIN PASSWORD 'darling_app';

CREATE DATABASE darling OWNER darling_owner;
-- Template copied by CREATE DATABASE ... TEMPLATE for every test database.
CREATE DATABASE darling_test_template OWNER darling_owner;

-- ALTER DEFAULT PRIVILEGES is per database, so configure each one. Template
-- databases carry these defaults over to every database created from them.
\connect darling
ALTER SCHEMA public OWNER TO darling_owner;
GRANT USAGE ON SCHEMA public TO darling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE darling_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO darling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE darling_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO darling_app;

\connect darling_test_template
ALTER SCHEMA public OWNER TO darling_owner;
GRANT USAGE ON SCHEMA public TO darling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE darling_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO darling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE darling_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO darling_app;
