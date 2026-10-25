-- Preserve legacy callers during the coordinated cutover. Never match identities by email.
ALTER TABLE "User" ALTER COLUMN "keycloakId" DROP NOT NULL;
