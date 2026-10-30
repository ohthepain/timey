import { index, integer, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const domain = pgSchema('domain');

const timestamps = {
  createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).defaultNow().notNull(),
  modifiedAt: timestamp('modifiedAt', { precision: 3, mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const users = domain.table(
  'User',
  {
    id: text('id').primaryKey(),
    keycloakId: text('keycloakId').unique(),
    userName: text('userName').notNull(),
    email: text('email').notNull(),
    currentModuleId: text('currentModuleId'),
    ...timestamps,
  },
  (table) => [uniqueIndex('User_email_key').on(table.email)]
);

export const methods = domain.table(
  'Method',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    index: integer('index').notNull(),
    authorId: text('authorId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [uniqueIndex('Method_title_key').on(table.title)]
);

export const modules = domain.table(
  'Module',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    index: integer('index').notNull(),
    authorId: text('authorId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    methodId: text('methodId')
      .notNull()
      .references(() => methods.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [uniqueIndex('Module_title_methodId_key').on(table.title, table.methodId)]
);

export const beats = domain.table(
  'Beat',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    index: integer('index').notNull(),
    authorId: text('authorId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moduleId: text('moduleId')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [index('Beat_authorId_idx').on(table.authorId), index('Beat_moduleId_idx').on(table.moduleId)]
);

export const performances = domain.table('Performance', {
  id: text('id').primaryKey(),
  beatId: text('beatId')
    .notNull()
    .references(() => beats.id),
  index: integer('index').notNull(),
  userId: text('userId').notNull(),
  createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).defaultNow().notNull(),
  modifiedAt: timestamp('modifiedAt', { precision: 3, mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const beatNotes = domain.table(
  'BeatNote',
  {
    id: text('id').primaryKey(),
    index: integer('index').notNull(),
    duration: integer('duration').notNull(),
    noteString: text('noteString').notNull(),
    barNum: integer('barNum').notNull(),
    beatNum: integer('beatNum').notNull(),
    divisionNum: integer('divisionNum').notNull(),
    subDivisionNum: integer('subDivisionNum').notNull(),
    numSubDivisions: integer('numSubDivisions').notNull(),
    velocity: integer('velocity').notNull(),
    microtiming: integer('microtiming').notNull().default(0),
    beatId: text('beatId').references(() => beats.id, { onDelete: 'cascade' }),
    performanceId: text('performanceId').references(() => performances.id, { onDelete: 'set null' }),
  },
  (table) => [index('BeatNote_beatId_idx').on(table.beatId)]
);

export const methodProgress = domain.table(
  'MethodProgress',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    methodId: text('methodId')
      .notNull()
      .references(() => methods.id),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    targetLevel: integer('targetLevel'),
  },
  (table) => [uniqueIndex('MethodProgress_userId_methodId_key').on(table.userId, table.methodId)]
);

export const moduleProgress = domain.table(
  'ModuleProgress',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    moduleId: text('moduleId')
      .notNull()
      .references(() => modules.id),
    currentMethodId: text('currentMethodId'),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    targetLevel: integer('targetLevel'),
  },
  (table) => [uniqueIndex('ModuleProgress_userId_moduleId_key').on(table.userId, table.moduleId)]
);

export const beatProgress = domain.table(
  'BeatProgress',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id),
    beatId: text('beatId')
      .notNull()
      .references(() => beats.id),
    bestTempo: integer('bestTempo'),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('BeatProgress_userId_beatId_key').on(table.userId, table.beatId)]
);

export type DomainUser = typeof users.$inferSelect;
export type DomainMethod = typeof methods.$inferSelect;
export type DomainModule = typeof modules.$inferSelect;
export type DomainBeat = typeof beats.$inferSelect;
export type DomainBeatNote = typeof beatNotes.$inferSelect;
export type DomainPerformance = typeof performances.$inferSelect;
export type DomainMethodProgress = typeof methodProgress.$inferSelect;
export type DomainModuleProgress = typeof moduleProgress.$inferSelect;
export type DomainBeatProgress = typeof beatProgress.$inferSelect;
