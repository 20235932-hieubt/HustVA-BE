import 'dotenv/config';
import { DatabaseConfigError, readMongoConfig } from './config.js';
import { createMongoConnection } from './client.js';
import {
  DatabaseSetupError,
  inspectVectorIndex,
  isVectorIndexReady,
  setupKnowledgeDatabase,
} from './setup.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['check', 'setup'].includes(command ?? ''))
    throw new DatabaseConfigError('Dùng db:check hoặc db:setup.');
  const config = readMongoConfig();
  const { client, db } = createMongoConnection(config);
  try {
    await client.connect();
    await db.command({ ping: 1 }, { timeoutMS: 10_000 });
    console.log(`MongoDB: kết nối thành công, database ${config.dbName}.`);
    if (command === 'setup') {
      const result = await setupKnowledgeDatabase(db, config);
      console.log(
        'Đã chuẩn bị knowledge_documents, knowledge_chunks, ingestion_runs và index thường.',
      );
      if (result.vector === 'skipped') {
        console.log('Chưa tạo vector index: đặt EMBEDDING_DIMENSION sau khi chốt model embedding.');
      } else if (result.vector === 'ready') {
        console.log('Vector index có sẵn, đúng cấu hình và queryable.');
      } else {
        console.log(
          'Vector index đang được tạo/build; chạy db:check để kiểm tra khả năng truy vấn.',
        );
      }
      return;
    }
    if (!config.embeddingDimension) {
      console.log('Chỉ kiểm tra kết nối. Vector Search chưa cấu hình số chiều embedding.');
      return;
    }
    const index = await inspectVectorIndex(db, config);
    if (!index || !isVectorIndexReady(index)) {
      console.error(
        index
          ? 'Vector index chưa queryable; xem trạng thái trên Atlas rồi kiểm tra lại.'
          : 'Chưa có vector index; chạy db:setup khi cấu hình embedding đã đúng.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      'Vector index đúng cấu hình và queryable. Chưa kiểm tra embedding/retrieval thực tế.',
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  // Driver errors can contain credentials or URIs. Only our own validation messages are printable.
  const message =
    error instanceof DatabaseConfigError || error instanceof DatabaseSetupError
      ? error.message
      : 'Không hoàn tất thao tác MongoDB. Kiểm tra URI, quyền DB, IP access list và trạng thái index trên Atlas; xem docs/development/cloud-databases.md.';
  console.error(message);
  process.exitCode = 1;
});
