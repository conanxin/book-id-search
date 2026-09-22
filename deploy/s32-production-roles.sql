\set ON_ERROR_STOP on

-- Non-secret production runtime role bootstrap.
-- Required psql variables: db_name, app_role, app_password.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE :"app_role" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
GRANT USAGE ON SCHEMA core, ops, derived TO :"app_role";
REVOKE CREATE ON SCHEMA core, ops, derived FROM :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, ops TO :"app_role";
