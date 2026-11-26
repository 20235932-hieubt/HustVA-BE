# HustVA Backend

Backend hỗ trợ crawl nội dung công khai HUST từ HTML/PDF, embed nội dung đã crawl và chatbot công tác sinh viên (RAG) sử dụng Gemini, LangGraph, MongoDB. Chatbot tra cứu trên các đoạn văn bản đã embed và trả lời kèm trích dẫn nguồn. Hệ thống cũng có 5 HUST Partner tool và API quản lý tool; LLM chọn chức năng, backend kiểm tra và thực thi.

## Chạy bằng Docker

Hệ thống gồm hai service:

| Service     | Vai trò                                                                           | Cổng   |
| ----------- | --------------------------------------------------------------------------------- | ------ |
| `api`       | Node.js: crawler, pipeline embedding, chatbot, HUST tools                         | `4000` |
| `embedding` | Python: mô hình `dangvantuan/vietnamese-document-embedding`, trả vector 768 chiều | `8001` |

Chunk, vector và hội thoại lưu trên MongoDB Atlas. Docker volume chỉ giữ file làm việc của crawler, trạng thái index, settings tool và mô hình đã tải. Cần Docker (Docker Desktop trên Windows) và khoảng 4 GB RAM trống cho mô hình.

1. Tạo `.env` từ [.env.example](.env.example) và điền `MONGODB_URI`, `MONGODB_DB_NAME`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `EMBEDDING_STORE=atlas`, `EMBEDDING_DIMENSION=768`. Giữ `CHAT_MAX_TURN_TOKENS=24000`; đặt thấp hơn thì câu hỏi cần đọc nhiều tài liệu bị dừng với `MODEL_BUDGET`. Atlas cần cho phép IP của máy chạy API.
2. Build và chạy:

   ```powershell
   docker compose -f docker-compose.app.yml up -d --build
   ```

   Lần đầu service `embedding` tải mô hình (~1,2 GB) vào volume, mất vài phút. `api` chỉ khởi động khi `embedding` đã sẵn sàng. Compose tự đặt `HOST=0.0.0.0` và địa chỉ service embedding cho container.

3. Kiểm tra: `docker compose -f docker-compose.app.yml ps` và `GET http://localhost:4000/api/v1/embedding/status` (`store` là `atlas`, `chunks` là số đoạn trên Atlas).

Lần đầu dùng một Atlas mới, tạo collections và vector index một lần:

```powershell
docker compose -f docker-compose.app.yml exec api node dist/db/cli.js setup
docker compose -f docker-compose.app.yml exec api node dist/db/cli.js check
```

Lệnh thường dùng:

```powershell
docker compose -f docker-compose.app.yml logs -f api   # xem log
docker compose -f docker-compose.app.yml restart api   # nạp lại .env
docker compose -f docker-compose.app.yml down          # tắt, giữ volume
```

Hai cổng chỉ mở trên `127.0.0.1` của máy chạy. Khi deploy, đặt reverse proxy (HTTPS) trỏ vào `127.0.0.1:4000` và cấu hình `API_ORIGIN`, `WEB_ORIGIN` như mục bên dưới. Không chạy bản Docker cùng lúc với `pnpm.cmd dev` trên cùng một Atlas.

## Chạy local

Chạy riêng service embedding bằng Docker, API bằng Node.js 22 và pnpm 10.33.0:

```powershell
docker compose -f docker-compose.app.yml up -d embedding
pnpm.cmd install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
pnpm.cmd dev
```

Nếu chưa có pnpm trên PATH, thay `pnpm.cmd` bằng `npm.cmd exec --yes --package=pnpm@10.33.0 -- pnpm`.

API mặc định chạy tại `http://localhost:4000`, bind `127.0.0.1`, gọi embedding ở `http://127.0.0.1:8001`. Kiểm tra bằng `GET /api/v1/health`. Tham khảo các biến cấu hình trong [.env.example](.env.example), restart server sau khi sửa `.env`.

## Cấu hình endpoint khi deploy

Các URL và địa chỉ listen được đọc từ `.env` hoặc biến môi trường của hosting:

```dotenv
HOST=0.0.0.0
PORT=4000
API_ORIGIN=https://api.example.com
WEB_ORIGIN=https://chat.example.com
```

`API_ORIGIN` là origin public của backend, không chứa `/api/v1`. Chat router cho
phép hostname này cùng các hostname loopback. `WEB_ORIGIN` là origin frontend chứa
iframe chatbot và được dùng cho CORS cùng kiểm tra Origin. Không đặt `*` và không
điền domain website nhúng vào biến này. Hai giá trị nhận HTTP(S), không chứa path,
query hay thông tin đăng nhập. Restart backend sau khi đổi env.

`HOST` mặc định `127.0.0.1`; dùng `0.0.0.0` nếu hosting/container cần nhận kết nối
từ bên ngoài. `PORT` là cổng nội bộ, có thể khác cổng HTTPS public. Crawler vẫn chỉ
cho phép hostname loopback như trước.

Frontend tương ứng đặt `NEXT_PUBLIC_API_URL=https://api.example.com/api/v1`
trước khi build. Widget tải từ `https://chat.example.com/widget.js` sẽ tự tìm
`/embed` và `/chat` trên cùng origin của frontend.

Các file kiểm thử được lưu riêng ngoài repo, tại `../kiem-thu/be`.

## Crawler API

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

Lệnh trên kiểm tra kết nối; khi có cấu hình embedding, lệnh còn kiểm tra vector index. `pnpm.cmd db:setup` chuẩn bị collections/index cho kho tri thức, chỉ tạo vector index khi đặt `EMBEDDING_DIMENSION`. Với `EMBEDDING_STORE=atlas`, chatbot tra cứu bằng Atlas Vector Search nên cần vector index này. Các lệnh này không tự import dữ liệu crawler.

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

Crawler lưu xong một tài liệu mới hoặc đã đổi nội dung thì phát event `document.saved`; tài liệu được chunk và embed ngay trong nền, không làm chậm hay hỏng lượt crawl. Code nằm ở `src/embedding/`, mô hình chạy ở service `embedding` (Docker, [app.py](services/embedding/app.py)). Vector lưu trên Atlas khi `EMBEDDING_STORE=atlas` (mặc định `local` lưu trong `.local/embedding`); trạng thái index lưu trong `EMBEDDING_DATA_DIR`.

```
crawler saveDocument ─(saved)─► publisher ─► hàng đợi ─► đọc tài liệu → chunk → embed → lưu vector
                                         reconcile (lúc khởi động + mỗi 5 phút) ─┘
```

- Chunk theo cửa sổ khoảng 512 token (1750 ký tự), chồng lấn khoảng 15% (260 ký tự), cắt tại khoảng trắng; đoạn embed gồm tên tài liệu và nội dung. Cách này cho kết quả tìm kiếm tốt nhất khi so sánh các cách chia đoạn. Mỗi chunk giữ URL, trang PDF, Chương/Điều để trích dẫn, tiêu đề cha, khóa (`cohorts`), nguồn.
- Không embed lại tài liệu không đổi (`versionId`). Event bị mất, service embedding đang tắt, tài liệu crawl từ trước, hay đổi mô hình/cách chunk đều được lượt reconcile bắt lại.
- Trang chỉ dẫn tới PDF (`index_only`) được bỏ qua; nội dung nằm ở PDF đi kèm.

Thứ tự chạy: bật service `embedding`, rồi API (compose tự làm theo thứ tự này). Không bật service thì crawler vẫn chạy bình thường, tài liệu chờ embed ở trạng thái `pending`.

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
                                              └─ RagKnowledge: embed câu hỏi → Atlas Vector Search → lọc, bỏ trùng
```

- **Retrieval** ([rag.ts](src/knowledge/rag.ts)): `search_knowledge` embed câu hỏi bằng cùng service Python, lấy các đoạn có điểm ≥ `RAG_MIN_SCORE` (mặc định 0.45), bỏ đoạn trùng nội dung (cùng PDF crawl ở hai nguồn), lọc theo khóa trong `context.cohort` (giữ cả quy định chung). `read_document_section` trả đoạn trước/sau của một evidence đã nhận trong lượt.
- **Generation** ([policy.ts](src/guardrails/policy.ts) `validateDraft`): model chỉ nộp các claim kèm `evidenceIds`. Backend chỉ chấp nhận id do tool trả về trong chính lượt đó, tự ghép câu trả lời, đánh số `[1]`, `[2]` và thêm danh sách nguồn. Claim dẫn tới id lạ → `insufficient_evidence` (`CLAIM_UNGROUNDED`).
- Tài liệu chưa duyệt (`needs_review`, gồm mọi PDF) vẫn được dùng nhưng câu trả lời có `warnings` yêu cầu đối chiếu bản gốc.
- Lần gọi model cuối trong ngân sách chỉ được dùng `submit_answer`, để agent tổng hợp từ evidence đã có thay vì dừng ở `TOOL_BUDGET`.
- Thứ tự chạy: `docker compose -f docker-compose.app.yml up -d` → crawl (nếu chưa có dữ liệu) → hỏi chatbot. Service embedding tắt: tool trả `unavailable`, chatbot trả `insufficient_evidence`.

Hạn chế đã biết: một số PDF cũ dùng font TCVN3/VNI nên chữ trích ra bị lỗi; PDF scan chưa có OCR; kho có văn bản nhiều năm học nên câu hỏi về học phí thường cần hỏi lại năm học; chưa có bộ golden question để đo chất lượng.

Kiểm tra code bằng `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build`. Kiểm thử chức năng crawler do bạn thực hiện qua Postman.

## Bảo vệ thông tin cá nhân

Policy `hustva-ctsv-v2` thay marker chung bằng token HMAC-SHA-256 riêng cho từng giá trị, ví dụ `[[PII_NAME_<hash>]]`, `[[PII_EMAIL_<hash>]]`. Giá trị lặp lại trong cùng lượt dùng cùng token, hai giá trị khác nhau có token khác nhau. Khóa được dẫn xuất từ capability phiên và ID lượt, không dùng SHA thuần cho dữ liệu dễ đoán. Việc tạo HMAC dùng [node:crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehmacalgorithm-key-options).

Bảng token → giá trị gốc chỉ nằm trong RAM backend trong thời gian xử lý, được xóa khi hoàn tất hoặc lỗi. MongoDB lưu câu hỏi đã qua bước giả danh và phản hồi chưa khôi phục. Luồng 5 tool HUST chỉ lưu câu trả lời chứa các trường dữ liệu dùng chung được cho phép (mã học kỳ, điều kiện, tên chương trình, tên giảng viên/đơn vị, tên công ty); không lưu payload API thô. Các lượt tool HUST không đưa vào context cho model. Backend khôi phục **chỉ các token được cấp từ câu hỏi hiện tại** sau bước kiểm tra/lưu kết quả, trước khi trả response cho chủ sở hữu phiên. Không khôi phục secret, token bịa hoặc định danh lấy từ tool/model.

Có hai ranh giới gửi dữ liệu. Model chọn tool nhận câu hỏi hiện tại đã được giả danh bằng bộ lọc tên/email/điện thoại/mã định danh; không nhận lịch sử hoặc kết quả HUST. Tên đã che chỉ được khôi phục tại backend để tra HUST; không khôi phục mã định danh/email/điện thoại làm từ khóa. Luồng RAG giữ ý nghĩa câu hỏi và lịch sử sau bước giả danh, đồng thời gửi những đoạn tài liệu được adapter tra cứu và backend đăng ký trong chính lượt đó. Trường dữ liệu được kiểm tra, thông tin xác thực nhận diện được bị loại và URL nguồn bỏ query/hash. Tài liệu `needs_review` vẫn được dùng như trên main, kèm cảnh báo đối chiếu bản gốc. Bộ lọc PII là best effort, không bảo đảm nhận diện hết thông tin cá nhân, đặc biệt tên viết thường. Không gửi thông tin nhạy cảm không cần thiết.

Context được giới hạn ở khóa `K20`–`K99`, năm học liên tiếp trong khoảng `2000`–`2099` và chương trình `chuẩn`, `tiên tiến`/`CTTT`, `chất lượng cao`/`CLC`. Các giá trị tự do khác trả `400 CONTEXT_UNSAFE`. Không bật LangSmith/LangChain tracing bên ngoài cho luồng này; backend chặn trước graph/provider nếu các cờ tracing tương ứng đang bật. Logger JSON local vẫn dùng được.

Replay cùng UUID và nội dung gốc tái tạo mapping trong RAM để trả lại cùng câu trả lời, kể cả sau restart. Thay thông tin cá nhân nhưng giữ UUID trả `409 REQUEST_ID_REUSED`. Các request trước phiên bản fingerprint này cần UUID mới. Endpoint lịch sử/trạng thái giữ bản giả danh vì không lưu mapping lâu dài. Dữ liệu cũ đã lưu trước thay đổi này không được tự động xóa hoặc di chuyển.

## HUST tools và tool management — giai đoạn 1

Phạm vi hiện tại gồm **5 tool dữ liệu dùng chung** từ HUST Partner. Mỗi tool gọi
một endpoint độc lập, không cần MSSV và không có workflow nhiều bước.

| Tool                    | Endpoint                    | Tham số                    |
| ----------------------- | --------------------------- | -------------------------- |
| `get_semesters`         | `/semesters`                | `{}`                       |
| `get_study_conditions`  | `/student/study-conditions` | `{}`                       |
| `get_advanced_programs` | `/student/kscs`             | `{ "programId": "IT1" }`   |
| `search_teachers`       | `/teacher/search`           | `{ "keyWord": "từ khóa" }` |
| `search_companies`      | `/company/search`           | `{ "keyWord": "từ khóa" }` |

Các tool hồ sơ sinh viên, điểm, thời khóa biểu, lịch thi, chương trình đào tạo,
đề tài, eHUST, workflow bảng điểm và cache học phần chưa nằm trong giai đoạn này;
adapter và nhánh xử lý tương ứng đã được gỡ khỏi mã nguồn. Chat gọi 5 tool trên
qua Gemini function calling: LLM chọn tool và tham số theo ngữ nghĩa câu hỏi,
backend kiểm tra trước khi thực thi. Bộ chọn theo mẫu câu cũ đã được gỡ bỏ.
Luồng tri thức sử dụng RAG trên kho tài liệu đã embed; `StubKnowledge` chỉ là dự phòng khi chưa gắn adapter.

| Câu hỏi mẫu trong chat                | Tool được gọi           |
| ------------------------------------- | ----------------------- |
| Học kỳ hiện tại là gì?                | `get_semesters`         |
| Điều kiện học thạc sĩ là gì?          | `get_study_conditions`  |
| Chương trình kỹ sư chuyên sâu của IT1 | `get_advanced_programs` |
| Tìm giảng viên tên Nguyễn             | `search_teachers`       |
| Tìm công ty FPT                       | `search_companies`      |

[selector.ts](src/tools/selector.ts) đăng ký schema 5 tool và hai nhánh điều khiển
hỏi lại/chuyển luồng tri thức với Gemini. Mỗi lượt chọn tối đa một tool. Backend
từ chối tên tool lạ, nhiều tool call cùng lúc, field lạ, từ khóa tự bịa hoặc token
không thuộc lượt hiện tại. Model chọn hỏi lại nếu thiếu mã ngành/từ khóa.
[chat.ts](src/tools/chat.ts) chỉ kiểm tra và định dạng kết quả bằng các trường cho
phép, không chọn tool bằng regex. Kiểm tra an toàn vẫn chạy trước lời gọi LLM.
Model chọn tool chỉ nhận câu hiện tại; nên hỏi đầy đủ, chưa hỗ trợ “công ty đó”.

Chat và management dùng chung manager từ [runtime.ts](src/tools/runtime.ts).
Tắt tool qua PATCH hoặc trang `/tools` có hiệu lực với lượt chat tiếp theo.
Response tra cứu có `retrievalMode: "hust_api"`, không mang cảnh báo retrieval stub.
Kết quả API không gửi sang Gemini; câu hỏi hiện tại được gửi sau bước giả danh. Lịch sử lưu phần
kết quả dùng chung đã chọn trường để replay cùng requestId không gọi lại API.
Lượt tool bị loại khỏi context đưa cho model. Không tạo citation URL khi API không
cung cấp nguồn công khai phù hợp.

Chat cần MongoDB để quản lý phiên/lịch sử và Gemini để chọn tool. Không còn lựa
chọn tool cố định khi thiếu model; trả thông báo chưa sẵn sàng. Mỗi câu cần chọn
tool có một lời gọi model; chuyển sang tri thức có thể gọi model thêm theo luồng
cũ. Tìm giảng viên/công ty hiển thị tối đa 10
kết quả đầu và số lượng trong phản hồi API; không khẳng định là tổng toàn trường.

Điền `HUST_BASE_API_URL`, `HUST_API_TOKEN`, `HUST_AUTHORIZATION_TOKEN` từ
`api.env` vào môi trường backend và tạo `TOOL_MANAGEMENT_TOKEN` ngẫu nhiên
ít nhất 32 ký tự. Xem [.env.example](.env.example). Mọi endpoint dưới đây đều yêu
cầu `Authorization: Bearer <TOOL_MANAGEMENT_TOKEN>`, kể cả GET. Thiếu token hoặc
token ngắn trả 503; token sai trả 401. Biến eHUST/cache cũ không còn được module đọc.

| Method | Endpoint                    | Chức năng                                          |
| ------ | --------------------------- | -------------------------------------------------- |
| GET    | `/api/v1/tools`             | Danh sách 5 tool, JSON Schema, settings và metrics |
| GET    | `/api/v1/tools/:id`         | Chi tiết tool                                      |
| PATCH  | `/api/v1/tools/:id`         | Cập nhật bật/tắt, timeout và retry                 |
| POST   | `/api/v1/tools/:id/execute` | Thực thi với body `{ "arguments": { ... } }`       |

Request ghi cần `Content-Type: application/json`; Origin trình duyệt phải là
`WEB_ORIGIN` hoặc `API_ORIGIN`. Frontend có trang `/tools` dùng cùng
`NEXT_PUBLIC_API_URL` với chatbot. Token quản trị chỉ giữ trong RAM của trang;
không đặt token vào `NEXT_PUBLIC_*` hay localStorage.

Ví dụ gọi dữ liệu học kỳ, không cần MSSV:

```http
POST /api/v1/tools/get_semesters/execute
Authorization: Bearer <TOOL_MANAGEMENT_TOKEN>
Content-Type: application/json

{"arguments": {}}
```

[catalog.ts](src/tools/catalog.ts) khai báo schema nghiêm ngặt, từ chối field lạ;
từ khóa phải có nội dung. [client.ts](src/tools/client.ts) gọi POST với query string,
Authorization và body trống theo hợp đồng Partner. Kết quả phân biệt thành công,
dữ liệu rỗng, lỗi và timeout; không chuyển tiếp lỗi thô hay URL chứa token.

[ToolManager](src/tools/manager.ts) quản lý timeout toàn lượt gọi, tối đa 2 retry
cho lỗi tạm thời (mặc định 1), tối đa 8 lượt đang xử lý. Timeout cấu hình từ 1000
đến 120000 ms, mặc định 10000 ms. Không lưu kết quả API; chỉ lưu settings bằng
thay thế file nguyên tử tại `.local/tools/settings.json` (đổi bằng `TOOL_DATA_DIR`).
Settings tồn tại qua restart. Metrics chỉ có số lượt đã dispatch, số đang chạy,
tổng thời gian và số lượng theo trạng thái; giữ trong RAM và reset khi restart.
Cấu hình file hiện phục vụ một tiến trình backend.

Tool đã gỡ không xuất hiện trong registry, không gọi được qua execute và không
thể bật lại qua PATCH. Settings cũ của chúng bị bỏ qua khi load. Backend khác có
thể gọi `ToolManager.execute(id, args, signal?)` cho 5 tool dùng chung này.
Chưa có cơ chế xác thực sinh viên hoặc allowlist MSSV vì phạm vi hiện tại không
đọc dữ liệu sinh viên.

Các bài kiểm thử tự động và script kiểm thử API thật đã được chuyển sang
`../kiem-thu/be`, giữ nguyên nội dung để tham khảo hoặc khôi phục khi cần.
Các lệnh `test:*` tương ứng đã được bỏ khỏi `package.json`.

## Trace và kiểm tra code

Backend ghi log JSON ra terminal. Đặt `LOG_LEVEL=debug` trong `.env` rồi restart để xem thêm các bước xử lý. Lấy header `X-Trace-Id` trong response Postman để tìm log; lượt chat có thêm `requestId`/`runId` và thời gian xử lý. Logger không ghi body chat, prompt, token, API key hoặc payload lỗi thô.

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd build
```

Có thể kiểm tra chức năng qua các endpoint Postman ở trên.

## Mã nguồn chính

| Thành phần               | File                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP app/server          | [app.ts](src/app.ts), [server.ts](src/server.ts)                                                                                           |
| Nguồn crawl và điều phối | [sources.ts](src/crawler/sources.ts), [engine.ts](src/crawler/engine.ts)                                                                   |
| Trích xuất HTML/PDF      | [extract.ts](src/crawler/extract.ts)                                                                                                       |
| API và lưu hội thoại     | [routes.ts](src/chat/routes.ts), [service.ts](src/chat/service.ts), [repository.ts](src/chat/repository.ts)                                |
| Gemini và LangGraph      | [model.ts](src/agent/model.ts), [graph.ts](src/agent/graph.ts)                                                                             |
| Guardrail và kiểm căn cứ | [policy.ts](src/guardrails/policy.ts)                                                                                                      |
| Tools tra cứu (RAG)      | [rag.ts](src/knowledge/rag.ts), [stub.ts](src/knowledge/stub.ts) (interface + stub dự phòng)                                               |
| Embedding                | [chunker.ts](src/embedding/chunker.ts), [pipeline.ts](src/embedding/pipeline.ts), [app.py](services/embedding/app.py)                      |
| MongoDB setup            | [config.ts](src/db/config.ts), [setup.ts](src/db/setup.ts)                                                                                 |
| Logger                   | [logger.ts](src/observability/logger.ts)                                                                                                   |
| Docker                   | [Dockerfile](Dockerfile), [services/embedding/Dockerfile](services/embedding/Dockerfile), [docker-compose.app.yml](docker-compose.app.yml) |
