-- AlterTable
ALTER TABLE "Beat" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "Method" ALTER COLUMN "description" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Module" ADD COLUMN     "description" TEXT;
