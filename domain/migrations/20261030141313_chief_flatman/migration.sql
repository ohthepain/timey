CREATE TABLE "domain"."BeatNote" (
	"id" text PRIMARY KEY,
	"index" integer NOT NULL,
	"duration" integer NOT NULL,
	"noteString" text NOT NULL,
	"barNum" integer NOT NULL,
	"beatNum" integer NOT NULL,
	"divisionNum" integer NOT NULL,
	"subDivisionNum" integer NOT NULL,
	"numSubDivisions" integer NOT NULL,
	"velocity" integer NOT NULL,
	"microtiming" integer DEFAULT 0 NOT NULL,
	"beatId" text,
	"performanceId" text
);
--> statement-breakpoint
CREATE TABLE "domain"."BeatProgress" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"beatId" text NOT NULL,
	"bestTempo" integer,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain"."Beat" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"index" integer NOT NULL,
	"authorId" text NOT NULL,
	"moduleId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"modifiedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain"."MethodProgress" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"methodId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp(3) DEFAULT now() NOT NULL,
	"targetLevel" integer
);
--> statement-breakpoint
CREATE TABLE "domain"."Method" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text,
	"index" integer NOT NULL,
	"authorId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"modifiedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain"."ModuleProgress" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"moduleId" text NOT NULL,
	"currentMethodId" text,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp(3) DEFAULT now() NOT NULL,
	"targetLevel" integer
);
--> statement-breakpoint
CREATE TABLE "domain"."Module" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text,
	"index" integer NOT NULL,
	"authorId" text NOT NULL,
	"methodId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"modifiedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain"."Performance" (
	"id" text PRIMARY KEY,
	"beatId" text NOT NULL,
	"index" integer NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"modifiedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain"."User" (
	"id" text PRIMARY KEY,
	"keycloakId" text UNIQUE,
	"userName" text NOT NULL,
	"email" text NOT NULL,
	"currentModuleId" text,
	"createdAt" timestamp(3) DEFAULT now() NOT NULL,
	"modifiedAt" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "BeatNote_beatId_idx" ON "domain"."BeatNote" ("beatId");--> statement-breakpoint
CREATE UNIQUE INDEX "BeatProgress_userId_beatId_key" ON "domain"."BeatProgress" ("userId","beatId");--> statement-breakpoint
CREATE INDEX "Beat_authorId_idx" ON "domain"."Beat" ("authorId");--> statement-breakpoint
CREATE INDEX "Beat_moduleId_idx" ON "domain"."Beat" ("moduleId");--> statement-breakpoint
CREATE UNIQUE INDEX "MethodProgress_userId_methodId_key" ON "domain"."MethodProgress" ("userId","methodId");--> statement-breakpoint
CREATE UNIQUE INDEX "Method_title_key" ON "domain"."Method" ("title");--> statement-breakpoint
CREATE UNIQUE INDEX "ModuleProgress_userId_moduleId_key" ON "domain"."ModuleProgress" ("userId","moduleId");--> statement-breakpoint
CREATE UNIQUE INDEX "Module_title_methodId_key" ON "domain"."Module" ("title","methodId");--> statement-breakpoint
CREATE UNIQUE INDEX "User_email_key" ON "domain"."User" ("email");--> statement-breakpoint
ALTER TABLE "domain"."BeatNote" ADD CONSTRAINT "BeatNote_beatId_Beat_id_fkey" FOREIGN KEY ("beatId") REFERENCES "domain"."Beat"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."BeatNote" ADD CONSTRAINT "BeatNote_performanceId_Performance_id_fkey" FOREIGN KEY ("performanceId") REFERENCES "domain"."Performance"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "domain"."BeatProgress" ADD CONSTRAINT "BeatProgress_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "domain"."User"("id");--> statement-breakpoint
ALTER TABLE "domain"."BeatProgress" ADD CONSTRAINT "BeatProgress_beatId_Beat_id_fkey" FOREIGN KEY ("beatId") REFERENCES "domain"."Beat"("id");--> statement-breakpoint
ALTER TABLE "domain"."Beat" ADD CONSTRAINT "Beat_authorId_User_id_fkey" FOREIGN KEY ("authorId") REFERENCES "domain"."User"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."Beat" ADD CONSTRAINT "Beat_moduleId_Module_id_fkey" FOREIGN KEY ("moduleId") REFERENCES "domain"."Module"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."MethodProgress" ADD CONSTRAINT "MethodProgress_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "domain"."User"("id");--> statement-breakpoint
ALTER TABLE "domain"."MethodProgress" ADD CONSTRAINT "MethodProgress_methodId_Method_id_fkey" FOREIGN KEY ("methodId") REFERENCES "domain"."Method"("id");--> statement-breakpoint
ALTER TABLE "domain"."Method" ADD CONSTRAINT "Method_authorId_User_id_fkey" FOREIGN KEY ("authorId") REFERENCES "domain"."User"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."ModuleProgress" ADD CONSTRAINT "ModuleProgress_userId_User_id_fkey" FOREIGN KEY ("userId") REFERENCES "domain"."User"("id");--> statement-breakpoint
ALTER TABLE "domain"."ModuleProgress" ADD CONSTRAINT "ModuleProgress_moduleId_Module_id_fkey" FOREIGN KEY ("moduleId") REFERENCES "domain"."Module"("id");--> statement-breakpoint
ALTER TABLE "domain"."Module" ADD CONSTRAINT "Module_authorId_User_id_fkey" FOREIGN KEY ("authorId") REFERENCES "domain"."User"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."Module" ADD CONSTRAINT "Module_methodId_Method_id_fkey" FOREIGN KEY ("methodId") REFERENCES "domain"."Method"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "domain"."Performance" ADD CONSTRAINT "Performance_beatId_Beat_id_fkey" FOREIGN KEY ("beatId") REFERENCES "domain"."Beat"("id");