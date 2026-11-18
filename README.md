# HustVA Backend

Backend hỗ trợ crawl nội dung công khai HUST từ HTML/PDF, embed nội dung đã crawl và chatbot công tác sinh viên (RAG) sử dụng Gemini, LangGraph, MongoDB. Chatbot tra cứu trên các đoạn văn bản đã embed và chỉ trả lời kèm trích dẫn nguồn.

## Chạy local

Tại thư mục `be`, dùng Node.js 22 và pnpm 10.33.0:

```powershell
pnpm.cmd install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
pnpm.cmd dev
```

Nếu chưa có pnpm trên PATH, thay `pnpm.cmd` bằng `npm.cmd exec --yes --package=pnpm@10.33.0 -- pnpm`.

API mặc định chạy tại `http://localhost:4000`, bind `127.0.0.1`. Kiểm tra bằng `GET /api/v1/health`. Tham khảo các biến cấu hình trong [.env.example](.env.example), restart server sau khi sửa `.env`.

## Crawler

Luồng xử lý: request chọn nguồn → tải HTML/PDF → trích xuất → lưu → trả JSON. Không có app Worker hoặc lịch tự động.

Trong Postman gọi:

```http
POST http://localhost:4000/api/v1/crawler/crawl?sourceId=library
```

Không cần body. Response `200` chứa `{ run, documents }`, trong đó `documents` là toàn bộ nội dung trích xuất được. API đọc hết các bài, phân trang và PDF phát hiện được trong phạm vi nguồn đã định nghĩa. Xem các nguồn bằng `GET /api/v1/crawler/sources`.

Một lượt có thể chạy lâu; đặt Request timeout của Postman thành `0` để chờ. Nếu có lượt khác đang crawl, API trả `409`. Không crawl tự động khi khởi động API.

Nội dung và bản gốc lưu trong `.local/crawler`. Các file `exports/latest.txt` và `latest.jsonl` được cập nhật sau mỗi lượt. PDF scan/hình ảnh chưa có OCR; kết quả có cảnh báo khi cần đối chiếu. Không cần MongoDB, Gemini hoặc Docker để chạy crawler.

## MongoDB và Gemini

Để dùng chatbot, điền `MONGODB_URI` và `MONGODB_DB_NAME` trong `.env`. Với Atlas, cấu hình database user, quyền truy cập database và IP access list cho máy chạy API. Không commit URI hoặc password.

```powershell
pnpm.cmd db:check
```

Lệnh trên kiểm tra kết nối; khi có cấu hình embedding, lệnh còn kiểm tra vector index. `pnpm.cmd db:setup` chuẩn bị collections/index cho kho tri thức, chỉ tạo vector index khi đặt `EMBEDDING_DIMENSION`. Chatbot hiện tra cứu trên vector lưu local (`.local/embedding`), chưa cần vector index Atlas. Các lệnh này không tự import dữ liệu crawler.

Chat runtime tự chuẩn bị `chat_conversations` và `chat_requests` khi được dùng. Điền thêm `GEMINI_API_KEY` và `GEMINI_MODEL` được cấp quyền trong project cho câu cần gọi model. Thiếu cấu hình Gemini, câu chào vẫn hoạt động; câu cần model trả `503 GEMINI_NOT_CONFIGURED`.

## Gọi chatbot bằng Postman

Dùng tiền tố `http://localhost:4000/api/v1/chat` cho các endpoint:

| Method | Endpoint                                        | Chức năng                 |
| ------ | ----------------------------------------------- | ------------------------- |
| POST   | `/conversations`                                | Tạo phiên; body JSON `{}` |
| POST   | `/conversations/:id/messages`                   | Gửi câu hỏi               |
| GET    | `/conversations/:id/messages?limit=20&offset=0` | Đọc lịch sử đã lọc        |
| GET    | `/conversations/:id/requests/:requestId`        | Xem trạng thái request    |
| DELETE | `/conversations/:id`                            | Xóa phiên và lịch sử      |

Gửi request tạo phiên trước, lưu `conversationId` và `token` từ response. Với các endpoint còn lại, thay `:id` bằng ID này và đặt Authorization → Bearer Token bằng token phiên. Các request POST dùng `Content-Type: application/json`.

Body thử câu chào, không cần gọi Gemini:

```json
{
  "requestId": "{{$guid}}",
  "message": "Xin chào",
  "context": {
    "cohort": "K69"
  }
}
```

Postman tự tạo UUID mới từ `{{$guid}}`. Kết quả dự kiến là HTTP `200`, `status: "answered"`, `reasonCode: "SOCIAL"` và `retrievalMode: "rag"`.

Đổi message thành `Chứng chỉ tiếng Anh quốc tế có thời hạn bao lâu?` để thử luồng RAG (cần service embedding đang chạy và dữ liệu đã crawl, xem mục RAG). Kết quả có `status: "answered"`, `reasonCode: "GROUNDED"`, câu trả lời đánh số `[1]` và danh sách `citations`. Câu hỏi không có tài liệu phù hợp trả `insufficient_evidence`; câu hỏi phụ thuộc khóa/chương trình/năm học có thể trả `needs_clarification`.

Để replay một lượt đã hoàn tất, dùng lại **UUID thực tế đã gửi** và giữ nguyên message/context trong cùng phiên. Backend trả `replayed: true`, không chạy lại model hoặc thêm lượt lịch sử. Dùng `{{$guid}}` cho mỗi lần Send sẽ tạo request mới. Cùng UUID nhưng đổi nội dung trả `409 REQUEST_ID_REUSED`; request pending/failed chưa hỗ trợ resume.

Token phiên là quyền truy cập hội thoại demo local, chưa phải đăng nhập sinh viên. Không gửi mật khẩu, OTP hoặc thông tin hồ sơ nhạy cảm trong chat. Chatbot không dùng trí nhớ của model để trả quy định: mọi câu trả lời phải dẫn tới đoạn văn bản đã tra cứu.

## Embedding

Crawler lưu xong một tài liệu mới hoặc đã đổi nội dung thì phát event `document.saved`; tài liệu được chunk và embed ngay trong nền, không làm chậm hay hỏng lượt crawl. Code nằm ở `src/embedding/`, mô hình chạy ở service Python `services/embedding/` ([cách chạy](services/embedding/README.md)). Vector và trạng thái lưu local trong `.local/embedding`.

```
crawler saveDocument ─(saved)─► publisher ─► hàng đợi ─► đọc tài liệu → chunk → embed → lưu vector
                                         reconcile (lúc khởi động + mỗi 5 phút) ─┘
```

- Chunk theo cửa sổ khoảng 512 token (1750 ký tự), chồng lấn khoảng 15% (260 ký tự), cắt tại khoảng trắng; đoạn embed gồm tên tài liệu và nội dung. Cách này có kết quả tốt nhất trong `pnpm.cmd eval:retrieval`. Mỗi chunk giữ URL, trang PDF, Chương/Điều để trích dẫn, tiêu đề cha, khóa (`cohorts`), nguồn.
- Không embed lại tài liệu không đổi (`versionId`). Event bị mất, service embedding đang tắt, tài liệu crawl từ trước, hay đổi mô hình/cách chunk đều được lượt reconcile bắt lại.
- Trang chỉ dẫn tới PDF (`index_only`) được bỏ qua; nội dung nằm ở PDF đi kèm.

Thứ tự chạy: bật service embedding, rồi `pnpm.cmd dev`. Không bật service thì crawler vẫn chạy bình thường, tài liệu chờ embed ở trạng thái `pending`.

| Endpoint                                       | Việc                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/v1/embedding/status`                 | Mô hình, hàng đợi, số tài liệu theo trạng thái                       |
| `POST /api/v1/embedding/search`                | `{ "query": "...", "limit": 5, "cohort": "K67", "sourceId": "..." }` |
| `GET /api/v1/embedding/documents/:id`          | Trạng thái index của một tài liệu                                    |
| `POST /api/v1/embedding/documents/:id/reindex` | Embed lại một tài liệu                                               |
| `POST /api/v1/embedding/reconcile`             | Xếp hàng mọi tài liệu chưa embed bản mới nhất                        |

### Lưu vector lên MongoDB Atlas

Đặt `EMBEDDING_STORE=atlas` và `EMBEDDING_DIMENSION=768` trong `.env`, chạy `pnpm.cmd db:setup` một lần (tạo vector index `knowledge_vector_v1`), rồi `pnpm.cmd db:check` tới khi báo queryable. Từ đó mỗi tài liệu embed xong được ghi vào Atlas: chunk + vector vào `knowledge_chunks`, thông tin tài liệu vào `knowledge_documents`. Tìm kiếm (`/embedding/search` và tool của chatbot) dùng Atlas Vector Search, lọc theo `indexVersion` (cách chunk + mô hình), `sourceId` và `cohortScope` (khóa; `*` là quy định chung). Đổi store thì lượt reconcile kế tiếp tự embed lại và đẩy toàn bộ lên store mới. Mất kết nối Atlas: tài liệu chờ ở `pending` rồi được thử lại, như khi service embedding tắt. Trạng thái index (`.local/embedding/state`) vẫn lưu local.

Khi chuyển sang MongoDB/RabbitMQ/Qdrant chỉ cần thay phần cài đặt trong `src/embedding/service.ts`: `DocumentReader` (đọc tài liệu), `DocumentEventPublisher` (hàng đợi), `VectorStore` (vector), `IndexStateStore` (`index_status`). Chunk id đã có dạng UUID để dùng làm point id của Qdrant.

## RAG: chatbot tra cứu trên dữ liệu đã embed

```
câu hỏi → guard → ReAct agent (Gemini) ⇄ search_knowledge / read_document_section → submit_answer → kiểm tra căn cứ → trả lời + nguồn
                                              │
                                              └─ RagKnowledge: embed câu hỏi → cosine trên .local/embedding → lọc, bỏ trùng
```

- **Retrieval** ([rag.ts](src/knowledge/rag.ts)): `search_knowledge` embed câu hỏi bằng cùng service Python, lấy các đoạn có điểm ≥ `RAG_MIN_SCORE` (mặc định 0.45), bỏ đoạn trùng nội dung (cùng PDF crawl ở hai nguồn), lọc theo khóa trong `context.cohort` (giữ cả quy định chung). `read_document_section` trả đoạn trước/sau của một evidence đã nhận trong lượt.
- **Generation** ([policy.ts](src/guardrails/policy.ts) `validateDraft`): model chỉ nộp các claim kèm `evidenceIds`. Backend chỉ chấp nhận id do tool trả về trong chính lượt đó, tự ghép câu trả lời, đánh số `[1]`, `[2]` và thêm danh sách nguồn. Claim dẫn tới id lạ → `insufficient_evidence` (`CLAIM_UNGROUNDED`).
- Tài liệu chưa duyệt (`needs_review`, gồm mọi PDF) vẫn được dùng nhưng câu trả lời có `warnings` yêu cầu đối chiếu bản gốc.
- Lần gọi model cuối trong ngân sách chỉ được dùng `submit_answer`, để agent tổng hợp từ evidence đã có thay vì dừng ở `TOOL_BUDGET`.
- Thứ tự chạy: service embedding → `pnpm.cmd dev` → crawl (nếu chưa có dữ liệu) → hỏi chatbot. Service embedding tắt: tool trả `unavailable`, chatbot trả `insufficient_evidence`.

Hạn chế đã biết: một số PDF cũ dùng font TCVN3/VNI nên chữ trích ra bị lỗi; PDF scan chưa có OCR; kho có văn bản nhiều năm học nên câu hỏi về học phí thường cần hỏi lại năm học; chưa có bộ golden question để đo chất lượng.

Kiểm tra code bằng `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build`. Kiểm thử chức năng crawler do bạn thực hiện qua Postman. Không cần Docker để chạy crawler.

## Trace và kiểm tra code

Backend ghi log JSON ra terminal. Đặt `LOG_LEVEL=debug` trong `.env` rồi restart để xem thêm các bước xử lý. Lấy header `X-Trace-Id` trong response Postman để tìm log; lượt chat có thêm `requestId`/`runId` và thời gian xử lý. Logger không ghi body chat, prompt, token, API key hoặc payload lỗi thô.

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd build
```

Bộ test tự động và các script `test:chat`/`test:db` đã được gỡ. Có thể kiểm tra chức năng qua các endpoint Postman ở trên.

## Mã nguồn chính

| Thành phần               | File                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| HTTP app/server          | [app.ts](src/app.ts), [server.ts](src/server.ts)                                                                      |
| Nguồn crawl và điều phối | [sources.ts](src/crawler/sources.ts), [engine.ts](src/crawler/engine.ts)                                              |
| Trích xuất HTML/PDF      | [extract.ts](src/crawler/extract.ts)                                                                                  |
| API và lưu hội thoại     | [routes.ts](src/chat/routes.ts), [service.ts](src/chat/service.ts), [repository.ts](src/chat/repository.ts)           |
| Gemini và LangGraph      | [model.ts](src/agent/model.ts), [graph.ts](src/agent/graph.ts)                                                        |
| Guardrail và kiểm căn cứ | [policy.ts](src/guardrails/policy.ts)                                                                                 |
| Tools tra cứu (RAG)      | [rag.ts](src/knowledge/rag.ts), [stub.ts](src/knowledge/stub.ts) (interface + stub dự phòng)                          |
| Embedding                | [chunker.ts](src/embedding/chunker.ts), [pipeline.ts](src/embedding/pipeline.ts), [app.py](services/embedding/app.py) |
| MongoDB setup            | [config.ts](src/db/config.ts), [setup.ts](src/db/setup.ts)                                                            |
| Logger                   | [logger.ts](src/observability/logger.ts)                                                                              |
