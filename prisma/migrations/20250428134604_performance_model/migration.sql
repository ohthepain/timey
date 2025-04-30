-- AlterTable
ALTER TABLE "BeatNote" ADD COLUMN     "performanceId" TEXT;

-- CreateTable
CREATE TABLE "Performance" (
    "id" TEXT NOT NULL,
    "beatId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Performance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Performance_beatId_index_key" ON "Performance"("beatId", "index");

-- AddForeignKey
ALTER TABLE "BeatNote" ADD CONSTRAINT "BeatNote_performanceId_fkey" FOREIGN KEY ("performanceId") REFERENCES "Performance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
