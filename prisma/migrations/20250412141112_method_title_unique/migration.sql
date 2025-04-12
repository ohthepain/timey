/*
  Warnings:

  - A unique constraint covering the columns `[title]` on the table `Method` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `description` to the `Method` table without a default value. This is not possible if the table is not empty.
  - Added the required column `index` to the `Method` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Method" ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "index" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Method_title_key" ON "Method"("title");
