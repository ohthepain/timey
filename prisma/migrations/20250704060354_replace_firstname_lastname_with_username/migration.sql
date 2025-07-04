/*
  Warnings:

  - You are about to drop the column `firstName` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `lastName` on the `User` table. All the data in the column will be lost.
  - Added the required column `userName` to the `User` table without a default value. This is not possible if the table is not empty.

*/

-- First, add the new column as nullable
ALTER TABLE "User" ADD COLUMN "userName" TEXT;

-- Update existing data by combining firstName and lastName
UPDATE "User" SET "userName" = COALESCE("firstName", '') || ' ' || COALESCE("lastName", '');
UPDATE "User" SET "userName" = TRIM("userName");

-- Set a default value for any empty userName
UPDATE "User" SET "userName" = 'User' WHERE "userName" = '' OR "userName" IS NULL;

-- Make the column NOT NULL
ALTER TABLE "User" ALTER COLUMN "userName" SET NOT NULL;

-- Drop the old columns
ALTER TABLE "User" DROP COLUMN "firstName",
DROP COLUMN "lastName";
