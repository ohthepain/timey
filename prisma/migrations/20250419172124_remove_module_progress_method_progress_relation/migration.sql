/*
  Warnings:

  - You are about to drop the column `methodProgressId` on the `ModuleProgress` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ModuleProgress" DROP CONSTRAINT "ModuleProgress_methodProgressId_fkey";

-- AlterTable
ALTER TABLE "ModuleProgress" DROP COLUMN "methodProgressId";
