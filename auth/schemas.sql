-- Run as the separately provisioned auth migration owner on a verified target.
-- No domain objects or role grants belong here.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS auth_migrations;
