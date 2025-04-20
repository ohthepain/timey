/*
  Warnings:

  - You are about to drop the column `currentBeatId` on the `MethodProgress` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,beatId]` on the table `BeatProgress` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,methodId]` on the table `MethodProgress` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "MethodProgress" DROP COLUMN "currentBeatId",
ADD COLUMN     "targetLevel" INTEGER;

-- AlterTable
ALTER TABLE "ModuleProgress" ADD COLUMN     "methodProgressId" TEXT,
ADD COLUMN     "targetLevel" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "BeatProgress_userId_beatId_key" ON "BeatProgress"("userId", "beatId");

-- CreateIndex
CREATE UNIQUE INDEX "MethodProgress_userId_methodId_key" ON "MethodProgress"("userId", "methodId");

-- AddForeignKey
ALTER TABLE "ModuleProgress" ADD CONSTRAINT "ModuleProgress_methodProgressId_fkey" FOREIGN KEY ("methodProgressId") REFERENCES "MethodProgress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
