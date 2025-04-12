-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Method" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "methodId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beat" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "moduleId" TEXT NOT NULL,

    CONSTRAINT "Beat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BeatNote" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "noteString" TEXT NOT NULL,
    "barNum" INTEGER NOT NULL,
    "beatNum" INTEGER NOT NULL,
    "divisionNum" INTEGER NOT NULL,
    "subDivisionNum" INTEGER NOT NULL,
    "numSubDivisions" INTEGER NOT NULL,
    "velocity" INTEGER NOT NULL,
    "beatId" TEXT NOT NULL,

    CONSTRAINT "BeatNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Beat_authorId_idx" ON "Beat"("authorId");

-- CreateIndex
CREATE INDEX "Beat_moduleId_idx" ON "Beat"("moduleId");

-- CreateIndex
CREATE INDEX "BeatNote_beatId_idx" ON "BeatNote"("beatId");

-- AddForeignKey
ALTER TABLE "Method" ADD CONSTRAINT "Method_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Module" ADD CONSTRAINT "Module_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Module" ADD CONSTRAINT "Module_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beat" ADD CONSTRAINT "Beat_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beat" ADD CONSTRAINT "Beat_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BeatNote" ADD CONSTRAINT "BeatNote_beatId_fkey" FOREIGN KEY ("beatId") REFERENCES "Beat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
