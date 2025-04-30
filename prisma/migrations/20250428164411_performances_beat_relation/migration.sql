-- DropIndex
DROP INDEX "Performance_beatId_index_key";

-- AddForeignKey
ALTER TABLE "Performance" ADD CONSTRAINT "Performance_beatId_fkey" FOREIGN KEY ("beatId") REFERENCES "Beat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
