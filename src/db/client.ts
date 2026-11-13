import { MongoClient } from 'mongodb';
import type { MongoConfig } from './config.js';

// The caller owns connect/close. Importing this module does not connect or write data.
export function createMongoConnection(config: MongoConfig) {
  const client = new MongoClient(config.uri, {
    appName: 'HustVA',
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
    waitQueueTimeoutMS: 10_000,
  });
  return { client, db: client.db(config.dbName) };
}
