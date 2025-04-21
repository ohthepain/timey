/*
  Warnings:

  - A unique constraint covering the columns `[title,methodId]` on the table `Module` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Module_title_methodId_key" ON "Module"("title", "methodId");
