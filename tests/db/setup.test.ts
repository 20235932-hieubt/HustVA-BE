import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoServerError, type Db, type Document } from 'mongodb';
import { readMongoConfig } from '../../src/db/config.js';
import {
  assertCompatibleVectorIndex,
  setupKnowledgeDatabase,
  vectorDefinition,
} from '../../src/db/setup.js';

const config = readMongoConfig({ MONGODB_URI: 'mongodb://localhost', EMBEDDING_DIMENSION: '1024' });

function databaseDouble(existing?: Document) {
  const names = new Set(existing ? ['knowledge_chunks'] : []);
  const calls: string[] = [];
  let index = existing;
  const db = {
    listCollections: ({ name }: { name: string }) => ({ hasNext: async () => names.has(name) }),
    createCollection: async (name: string) => {
      if (names.has(name)) throw new MongoServerError({ code: 48, message: 'NamespaceExists' });
      names.add(name);
    },
    collection: () => ({
      listSearchIndexes: () => ({ toArray: async () => (index ? [index] : []) }),
      createIndex: async (_keys: unknown, options: { name: string }) => calls.push(options.name),
      createSearchIndex: async (definition: Document) => {
        calls.push('create-vector');
        index = { ...definition, latestDefinition: definition.definition, queryable: false };
      },
    }),
  } as unknown as Db;
  return { db, calls, names };
}

test('bootstrap can be repeated without recreating the vector index or other collections', async () => {
  const fake = databaseDouble();
  assert.equal((await setupKnowledgeDatabase(fake.db, config)).vector, 'created');
  assert.equal((await setupKnowledgeDatabase(fake.db, config)).vector, 'building');
  assert.equal(fake.calls.filter((call) => call === 'create-vector').length, 1);
  assert.deepEqual([...fake.names].sort(), [
    'ingestion_runs',
    'knowledge_chunks',
    'knowledge_documents',
  ]);
});

test('bootstrap without embedding settings creates no search index', async () => {
  const fake = databaseDouble();
  const result = await setupKnowledgeDatabase(fake.db, {
    ...config,
    embeddingDimension: undefined,
  });
  assert.equal(result.vector, 'skipped');
  assert.ok(!fake.calls.includes('create-vector'));
});

test('an incompatible existing vector index prevents writes instead of replacing it', async () => {
  const fake = databaseDouble({
    type: 'vectorSearch',
    latestDefinition: vectorDefinition({ ...config, embeddingDimension: 768 }),
  });
  await assert.rejects(setupKnowledgeDatabase(fake.db, config), /khác cấu hình/u);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.names.size, 1);
});

test('ordinary search indexes and vector indexes without required filters are incompatible', () => {
  assert.throws(() =>
    assertCompatibleVectorIndex({ type: 'search', definition: vectorDefinition(config) }, config),
  );
  assert.throws(() =>
    assertCompatibleVectorIndex(
      {
        type: 'vectorSearch',
        latestDefinition: { fields: vectorDefinition(config).fields.slice(0, 1) },
      },
      config,
    ),
  );
});

test('an old queryable index is not ready until its latest definition finishes building', async () => {
  const fake = databaseDouble({
    type: 'vectorSearch',
    latestDefinition: vectorDefinition(config),
    queryable: true,
    status: 'BUILDING',
  });
  assert.equal((await setupKnowledgeDatabase(fake.db, config)).vector, 'building');
  assert.ok(!fake.calls.includes('create-vector'));
});

test('a compatible READY and queryable index is reused', async () => {
  const fake = databaseDouble({
    type: 'vectorSearch',
    latestDefinition: vectorDefinition(config),
    queryable: true,
    status: 'READY',
  });
  assert.equal((await setupKnowledgeDatabase(fake.db, config)).vector, 'ready');
  assert.ok(!fake.calls.includes('create-vector'));
});
