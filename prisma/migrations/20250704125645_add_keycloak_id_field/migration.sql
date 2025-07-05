/*
  Warnings:

  - A unique constraint covering the columns `[keycloakId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `keycloakId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- First, add the column as nullable
ALTER TABLE "User" ADD COLUMN "keycloakId" TEXT;

-- Update existing users with a temporary keycloak ID based on their existing ID
UPDATE "User" SET "keycloakId" = 'legacy-user-' || "id" WHERE "keycloakId" IS NULL;

-- Now make the column NOT NULL
ALTER TABLE "User" ALTER COLUMN "keycloakId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_keycloakId_key" ON "User"("keycloakId");
