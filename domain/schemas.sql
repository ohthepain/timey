-- Run as the separately provisioned domain migration owner on a verified target.
-- No auth objects or role grants belong here.
CREATE SCHEMA IF NOT EXISTS domain;
CREATE SCHEMA IF NOT EXISTS domain_migrations;
