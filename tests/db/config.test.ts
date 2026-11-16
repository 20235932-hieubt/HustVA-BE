import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readMongoConfig } from '../../src/db/config.js';

const valid = { MONGODB_URI: 'mongodb+srv://user:secret@example.mongodb.net/' };

test('Mongo config needs only a URI before an embedding model is selected', () => {
  const config = readMongoConfig(valid);
  assert.equal(config.dbName, 'hustva_dev');
  assert.equal(config.embeddingDimension, undefined);
  assert.equal(config.vectorIndexName, 'knowledge_vector_v1');
  assert.equal(config.similarity, 'cosine');
});

test('invalid embedding dimensions are rejected before any database operation', () => {
  for (const dimension of ['0', '-1', '1.5', '8193', 'NaN', 'Infinity', '1e3']) {
    assert.throws(() => readMongoConfig({ ...valid, EMBEDDING_DIMENSION: dimension }));
  }
  assert.equal(readMongoConfig({ ...valid, EMBEDDING_DIMENSION: '1024' }).embeddingDimension, 1024);
});

test('invalid database/index names and unsupported metrics are rejected', () => {
  for (const settings of [
    { MONGODB_DB_NAME: 'bad/database' },
    { MONGODB_VECTOR_INDEX: '$bad' },
    { EMBEDDING_SIMILARITY: 'COSINE' },
  ]) {
    assert.throws(() => readMongoConfig({ ...valid, ...settings }));
  }
});

test('CLI exits unsuccessfully on invalid settings without printing credentials', () => {
  const secret = 'do-not-print-this-password';
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/cli.ts', 'check'], {
    encoding: 'utf8',
    env: { ...process.env, MONGODB_URI: `invalid://${secret}`, DOTENV_CONFIG_QUIET: 'true' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MONGODB_URI/u);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});
