# HustVa — Backend

```text
apps/api/          Express API
apps/worker/       Worker độc lập
packages/config/   TypeScript config
packages/shared/   Placeholder types/schema
packages/database/ Placeholder database client/migration
packages/logger/   Placeholder logging
infrastructure/    SQL tạo extension pgvector
```

## Cài đặt và chạy

Yêu cầu Node.js 22 theo `.nvmrc`, pnpm 10.33.0. Docker Desktop cần cho PostgreSQL/Redis.

```powershell
corepack.cmd enable
corepack.cmd install
pnpm.cmd install --frozen-lockfile
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
pnpm.cmd infra:up
pnpm.cmd dev
```

Nếu chưa bật được Corepack, thay `pnpm.cmd <lệnh>` bằng `npm.cmd exec --yes --package=pnpm@10.33.0 -- pnpm <lệnh>`.

`dev` chạy API và Worker. Có thể chạy riêng bằng `pnpm.cmd --filter api dev` và `pnpm.cmd --filter worker dev`. API health: <http://localhost:4000/api/v1/health>. Worker chỉ ghi log sẵn sàng, chưa consume queue. Khung ứng dụng có thể chạy khi chưa có Docker bằng cách bỏ qua `infra:up`.

`WEB_ORIGIN` cấu hình origin của frontend, mặc định `http://localhost:3000`. BE giao tiếp với frontend qua HTTP; không dùng mã nguồn hoặc dependencies của frontend.

Compose chỉ dành cho local, giữ dữ liệu trong volume. SQL extension chạy lần đầu khi tạo volume. `pnpm.cmd infra:down` dừng service và giữ volume.

## Kiểm tra và Git

```powershell
pnpm.cmd format:check
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

Test runner hiện cho phép chưa có test case. Build chỉ biên dịch bộ khung. Cài dependencies tự kích hoạt Husky trong Git repo này: pre-commit chạy lint-staged/Prettier, commit-msg kiểm tra Conventional Commits. Dùng nhánh `feature/<tên>`, `fix/<tên>`, `chore/<tên>` và review qua pull request.

CI thuộc riêng repository này và chạy khi push/PR trên GitHub. Repository local chưa có remote và chưa có commit. Chưa kiểm chứng Docker vì máy chưa có Docker Desktop.

## Phần việc để sau

Backend/Database: Prisma, schema, migration, auth, middleware lỗi, logging và OpenAPI. Worker/AI: ingestion, crawler, chunking, embedding, scheduled crawl, RAG và decision system. Các phần này chưa triển khai.
