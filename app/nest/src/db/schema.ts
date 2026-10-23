import { boolean, customType, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const geometry = customType<{ data: string }>({ dataType: () => 'geometry' });

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false), image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  role: text('role').default('engineer'), banned: boolean('banned').default(false), banReason: text('banReason'),
  banExpires: timestamp('banExpires'),
});

export const sessions = pgTable('session', {
  id: text('id').primaryKey(), expiresAt: timestamp('expiresAt').notNull(), token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  ipAddress: text('ipAddress'), userAgent: text('userAgent'), userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }), impersonatedBy: text('impersonatedBy'),
}, (t) => [index('session_userId_idx').on(t.userId)]);

export const accounts = pgTable('account', {
  id: text('id').primaryKey(), accountId: text('accountId').notNull(), providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }), accessToken: text('accessToken'), refreshToken: text('refreshToken'), idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'), refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'), password: text('password'), issuer: text('issuer'),
  createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [index('account_userId_idx').on(t.userId)]);

export const verifications = pgTable('verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [index('verification_identifier_idx').on(t.identifier)]);

export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(), publicKey: text('publicKey').notNull(), privateKey: text('privateKey').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(), expiresAt: timestamp('expiresAt'), alg: text('alg'), crv: text('crv'),
});

export const projects = pgTable('project', {
  id: text('id').primaryKey(), name: text('name').notNull(), layers: jsonb('layers').notNull().default([]),
  filters: jsonb('filters').notNull().default({}), feature_colors: jsonb('feature_colors').notNull().default({}),
  generation_config: jsonb('generation_config').notNull().default({}), userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  created_at: timestamp('created_at').notNull().defaultNow(), updated_at: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [index('project_userId_idx').on(t.userId)]);

export const designVersions = pgTable('design_version', {
  id: text('id').primaryKey(), projectId: text('projectId').notNull().references(() => projects.id, { onDelete: 'cascade' }), version: integer('version').notNull(),
  config: jsonb('config').notNull(), metadata: jsonb('metadata').notNull(), validation: jsonb('validation').notNull(),
  stats: jsonb('stats').notNull(), status: text('status').notNull(), createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (t) => [uniqueIndex('design_version_projectId_version_key').on(t.projectId, t.version)]);

export const generationJobs = pgTable('generation_job', {
  id: text('id').primaryKey(), userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }), projectId: text('projectId').references(() => projects.id, { onDelete: 'cascade' }), batchId: text('batchId'), itemId: text('itemId'),
  status: text('status').notNull().default('QUEUED'), stage: text('stage'), progress: integer('progress').notNull().default(0),
  error: text('error'), result: jsonb('result'), createdAt: timestamp('createdAt').notNull().defaultNow(), updatedAt: timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [index('generation_job_userId_createdAt_idx').on(t.userId, t.createdAt), index('generation_job_projectId_createdAt_idx').on(t.projectId, t.createdAt), index('generation_job_status_idx').on(t.status)]);

export const auditLogs = pgTable('audit_log', {
  id: text('id').primaryKey(), userId: text('userId').notNull().references(() => users.id), action: text('action').notNull(), projectId: text('projectId'),
  versionId: text('versionId'), details: jsonb('details').notNull().default({}), createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (t) => [index('audit_log_userId_idx').on(t.userId), index('audit_log_projectId_idx').on(t.projectId)]);

export const projectCustomers = pgTable('project_customer', {
  id: text('id').primaryKey(), projectId: text('projectId').notNull().references(() => projects.id, { onDelete: 'cascade' }), location: geometry('location'),
}, (t) => [index('project_customer_projectId_idx').on(t.projectId)]);

export const designOdcs = pgTable('design_odc', {
  id: text('id').primaryKey(), designVersionId: text('designVersionId').notNull().references(() => designVersions.id, { onDelete: 'cascade' }), label: text('label').notNull(), location: geometry('location'),
}, (t) => [index('design_odc_designVersionId_idx').on(t.designVersionId)]);

export const designOdps = pgTable('design_odp', {
  id: text('id').primaryKey(), designVersionId: text('designVersionId').notNull().references(() => designVersions.id, { onDelete: 'cascade' }), odcId: text('odcId').notNull().references(() => designOdcs.id, { onDelete: 'cascade' }),
  label: text('label').notNull(), location: geometry('location'),
}, (t) => [index('design_odp_designVersionId_idx').on(t.designVersionId), index('design_odp_odcId_idx').on(t.odcId)]);

export const designCables = pgTable('design_cable', {
  id: text('id').primaryKey(), designVersionId: text('designVersionId').notNull().references(() => designVersions.id, { onDelete: 'cascade' }), type: text('type').notNull(),
  sourceLabel: text('sourceLabel').notNull(), targetLabel: text('targetLabel').notNull(), length: real('length').notNull(), path: geometry('path'),
}, (t) => [index('design_cable_designVersionId_idx').on(t.designVersionId)]);

