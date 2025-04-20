/*
  Warnings:

  - A unique constraint covering the columns `[userId,moduleId]` on the table `ModuleProgress` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ModuleProgress_userId_moduleId_key" ON "ModuleProgress"("userId", "moduleId");
