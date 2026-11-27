# HustVA Backend

Backend hỗ trợ crawl nội dung công khai HUST từ HTML/PDF, embed nội dung đã crawl và chatbot công tác sinh viên (RAG) sử dụng Gemini, LangGraph, MongoDB. Chatbot tra cứu trên các đoạn văn bản đã embed và trả lời kèm trích dẫn nguồn. Hệ thống cũng có 5 HUST Partner tool và API quản lý tool; LLM chọn chức năng, backend kiểm tra và thực thi.

## Chạy local

Tại thư mục `be`, dùng Node.js 22 và pnpm 10.33.0:

```powershell
pnpm.cmd install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
pnpm.cmd dev
```

Nếu chưa có pnpm trên PATH, thay `pnpm.cmd` bằng `npm.cmd exec --yes --package=pnpm@10.33.0 -- pnpm`.

API mặc định chạy tại `http://localhost:4000`, bind `127.0.0.1`. Kiểm tra bằng `GET /api/v1/health`. Tham khảo các biến cấu hình trong [.env.example](.env.example), restart server sau khi sửa `.env`.

## Xoay vòng key Gemini

Backend hỗ trợ `GEMINI_API_KEYS` là danh sách key phân cách bằng dấu phẩy
(tối đa 20 key, tự loại trùng). Nếu danh sách trống, dùng `GEMINI_API_KEY` cũ.
Danh sách không trống thay thế key đơn; không tự thêm key đơn vào danh sách.
Chỉ đặt key thật trong `.env` local hoặc secret manager; không gửi key vào chat,
frontend, log hoặc repository. Restart backend sau khi thay đổi key.

```dotenv
# Thay các placeholder bằng key thật của bạn khi cấu hình local.
GEMINI_API_KEYS=key_1,key_2,key_3
GEMINI_MAX_REQUESTS_PER_MINUTE=15
GEMINI_KEY_COOLDOWN_MS=60000
GEMINI_MAX_ATTEMPTS=2
```

Routing và agent dùng chung pool theo runtime config, chọn key round-robin và
cache client riêng theo key. Tổng lượt bắt đầu gọi tối đa 15 trong bất kỳ 60 giây
liên tiếp trên một process; có thể cấu hình thấp hơn, không nhân giới hạn theo
số key. Lần lỗi và failover đều tính vào ngân sách. SDK maxRetries=0 để tránh
retry ẩn ngoài bộ đếm.

- `401`/`403` hoặc lỗi có reason `API_KEY_INVALID`: loại key khỏi pool đến khi
  sửa cấu hình và restart; có thể chuyển key khác trong giới hạn attempts.
- `429`: tạm dừng cả pool ít nhất GEMINI_KEY_COOLDOWN_MS, tôn trọng Retry-After
  dài hơn nếu có; trả GEMINI_RATE_LIMITED, không thử tiếp các key khác ngay.
- `408`/`500`/`502`/`503`/`504`: cooldown key, backoff có jitter rồi thử key khác
  nếu còn key khả dụng và còn ngân sách. Không thử lại cùng key trong một lượt.
- Lỗi input `400` thông thường hoặc lỗi không xác định: không xoay/retry tự động,
  trả lỗi đã làm sạch. Abort dừng các lần thử tiếp theo.

Google áp dụng quota theo project, không theo key. Nhiều key cùng project không
tăng RPM/TPM/RPD. Giới hạn local chỉ kiểm soát RPM, không thay thế quota provider.
Pool/budget/cooldown hiện nằm trong RAM; nhiều replica hoặc restart không chia sẻ
trạng thái. Cần quota store tập trung trước khi triển khai nhiều replica.
Không dùng cơ chế này để tăng lượt khi project đã hết quota.

Tham khảo [Google rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
và [retry strategy](https://ai.google.dev/gemini-api/docs/troubleshooting).
Test offline chỉ giữ local: build backend rồi từ workspace chạy
`node kiem-thu/be/gemini/run-tests.mjs`; không commit/push test hoặc runner.

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

- Chunk theo cửa sổ khoảng 512 token (1750 ký tự), chồng lấn khoảng 15% (260 ký tự), cắt tại khoảng trắng; đoạn embed gồm tên tài liệu và nội dung. Cách này cho kết quả tìm kiếm tốt nhất khi so sánh các cách chia đoạn. Mỗi chunk giữ URL, trang PDF, Chương/Điều để trích dẫn, tiêu đề cha, khóa (`cohorts`), nguồn.
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

## Bảo vệ thông tin cá nhân

Policy `hustva-ctsv-v2` thay marker chung bằng token HMAC-SHA-256 riêng cho từng giá trị, ví dụ `[[PII_NAME_<hash>]]`, `[[PII_EMAIL_<hash>]]`. Giá trị lặp lại trong cùng lượt dùng cùng token, hai giá trị khác nhau có token khác nhau. Khóa được dẫn xuất từ capability phiên và ID lượt, không dùng SHA thuần cho dữ liệu dễ đoán. Việc tạo HMAC dùng [node:crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreatehmacalgorithm-key-options).

Bảng token → giá trị gốc chỉ nằm trong RAM backend trong thời gian xử lý, được xóa khi hoàn tất hoặc lỗi. MongoDB lưu câu hỏi đã qua bước giả danh và phản hồi chưa khôi phục. Luồng 5 tool HUST chỉ lưu câu trả lời chứa các trường dữ liệu dùng chung được cho phép (mã học kỳ, điều kiện, tên chương trình, tên giảng viên/đơn vị, tên công ty); không lưu payload API thô. Các lượt tool HUST không đưa vào context cho model. Backend khôi phục **chỉ các token được cấp từ câu hỏi hiện tại** sau bước kiểm tra/lưu kết quả, trước khi trả response cho chủ sở hữu phiên. Không khôi phục secret, token bịa hoặc định danh lấy từ tool/model.

Có hai ranh giới gửi dữ liệu. Model chọn tool nhận câu hỏi hiện tại đã được giả danh bằng bộ lọc tên/email/điện thoại/mã định danh; không nhận lịch sử hoặc kết quả HUST. Tên đã che chỉ được khôi phục tại backend để tra HUST; không khôi phục mã định danh/email/điện thoại làm từ khóa. Luồng RAG giữ ý nghĩa câu hỏi và lịch sử sau bước giả danh, đồng thời gửi những đoạn tài liệu được adapter tra cứu và backend đăng ký trong chính lượt đó. Trường dữ liệu được kiểm tra, thông tin xác thực nhận diện được bị loại và URL nguồn bỏ query/hash. Tài liệu `needs_review` vẫn được dùng như trên main, kèm cảnh báo đối chiếu bản gốc. Bộ lọc PII là best effort, không bảo đảm nhận diện hết thông tin cá nhân, đặc biệt tên viết thường. Không gửi thông tin nhạy cảm không cần thiết.

Context được giới hạn ở khóa `K20`–`K99`, năm học liên tiếp trong khoảng `2000`–`2099` và chương trình `chuẩn`, `tiên tiến`/`CTTT`, `chất lượng cao`/`CLC`. Các giá trị tự do khác trả `400 CONTEXT_UNSAFE`. Không bật LangSmith/LangChain tracing bên ngoài cho luồng này; backend chặn trước graph/provider nếu các cờ tracing tương ứng đang bật. Logger JSON local vẫn dùng được.

Replay cùng UUID và nội dung gốc tái tạo mapping trong RAM để trả lại cùng câu trả lời, kể cả sau restart. Thay thông tin cá nhân nhưng giữ UUID trả `409 REQUEST_ID_REUSED`. Các request trước phiên bản fingerprint này cần UUID mới. Endpoint lịch sử/trạng thái giữ bản giả danh vì không lưu mapping lâu dài. Dữ liệu cũ đã lưu trước thay đổi này không được tự động xóa hoặc di chuyển.

## HUST tools và tool management

Sau khi tích hợp origin/main, giữ cả tool hồ sơ `get_student_info` (chọn trường
identity/class/program/status/advisor/cpa/gpa/credits/warning) và các tool điểm.
`get_academic_result` là tool nội bộ cho hồ sơ, không đưa vào schema model.
Hồ sơ và kết quả học tập dùng MSSV từ phiên demo còn hiệu lực, kiểm tra owner
conversation và không lưu dữ liệu cá nhân vào history/replay. DEMO_STUDENT_ID
chỉ còn là mapping dự phòng cho management đã xác thực, không thay thế mapping
tài khoản đang đăng nhập. Không tự gán một hồ sơ demo chung cho mọi khách chat.

Gemini giữ key pool và ngân sách 15 lượt/phút chung, đồng thời tích hợp deadline
từng attempt và retry lỗi quá tải từ origin. Retry không nhân đôi bên trong SDK;
mỗi attempt đều qua bộ đếm RPM, lỗi 429 vẫn dừng theo cooldown của project.

Catalog gồm **5 tool dữ liệu dùng chung** và **2 tool điểm cá nhân tắt mặc định**
từ HUST Partner. Các tool dùng chung không cần MSSV; tool điểm nhận MSSV 8 hoặc
9 chữ số. Chat chỉ cho tài khoản demo tra cứu MSSV đã được người vận hành gắn sẵn.

| Tool                    | Endpoint                    | Tham số                    |
| ----------------------- | --------------------------- | -------------------------- |
| `get_semesters`         | `/semesters`                | `{}`                       |
| `get_study_conditions`  | `/student/study-conditions` | `{}`                       |
| `get_advanced_programs` | `/student/kscs`             | `{ "programId": "IT1" }`   |
| `search_teachers`       | `/teacher/search`           | `{ "keyWord": "từ khóa" }` |
| `search_companies`      | `/company/search`           | `{ "keyWord": "từ khóa" }` |
| `get_student_info`      | `/student/info`             | `{}` (MSSV do backend gắn) |
| `get_academic_result`   | `/academicresult`           | `{ "semester": "20252" }`  |

Các tool hồ sơ sinh viên, thời khóa biểu, lịch thi, chương trình đào tạo,
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
| Xem hồ sơ của tôi / Cố vấn của tôi    | `get_student_info`      |

[selector.ts](src/tools/selector.ts) mặc định đăng ký schema 5 tool dùng chung và hai nhánh điều khiển
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
kết quả dùng chung đã chọn trường để replay cùng requestId không gọi lại API. Kết quả điểm
chỉ trả trực tiếp, không lưu để replay (xem phần tra cứu điểm bên dưới).
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

| Method | Endpoint                    | Chức năng                                        |
| ------ | --------------------------- | ------------------------------------------------ |
| GET    | `/api/v1/tools`             | Danh sách tool, JSON Schema, settings và metrics |
| GET    | `/api/v1/tools/:id`         | Chi tiết tool                                    |
| PATCH  | `/api/v1/tools/:id`         | Cập nhật bật/tắt, timeout và retry               |
| POST   | `/api/v1/tools/:id/execute` | Thực thi với body `{ "arguments": { ... } }`     |

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
thể gọi `ToolManager.execute(id, args, signal?, access?)`. Tool điểm bắt buộc có
execution context do server tạo: demo principal còn hiệu lực hoặc management
context sau khi đã xác thực bearer token. Không deserialize context quyền từ body.
Management token xác thực người vận hành, không xác minh chủ sở hữu MSSV.
Chỉ dùng dữ liệu cá nhân của MSSV được ban tổ chức chỉ định.

### Tool tra cứu điểm học tập

Hai tool ánh xạ trực tiếp tới API Partner, không dùng eHUST transcript:

| Tool                   | Endpoint           | Tham số                          |
| ---------------------- | ------------------ | -------------------------------- |
| `get_grades`           | `/grades`          | `studentId`, `semester` tùy chọn |
| `get_grades_by_course` | `/gradebycourseid` | `studentId`, `courseId`          |

Input dùng strict schema; `studentId` là chuỗi 8/9 chữ số, giữ số 0 ở đầu.
`semester` có dạng `YYYY1`, `YYYY2`, `YYYY3`; bỏ field để lấy tất cả kỳ, không
gửi chuỗi rỗng. `courseId` là mã học phần, chuẩn hóa chữ hoa. Không truyền
`courseId` vào `get_grades` hay `semester` vào `get_grades_by_course`.

Ví dụ chỉ dùng với mock (MSSV tổng hợp, không dùng gọi dịch vụ thật):

```json
{ "arguments": { "studentId": "20990001", "semester": "20251" } }
```

```json
{ "arguments": { "studentId": "009990001", "courseId": "IT3090" } }
```

Gửi body trên tới `POST /api/v1/tools/<tool-id>/execute` với management bearer token.
Trước đó bật tool bằng `PATCH /api/v1/tools/<tool-id>` với `{"enabled":true}`.
HTTP client gửi POST, query string và body trống sang HUST đúng hợp đồng Partner.

Để thử qua chat, bật `CHAT_GRADES_ENABLED=true`, `DEMO_AUTH_ENABLED=true`, cấp tài
khoản theo hướng dẫn bên dưới và restart backend; bật từng tool qua management.
Khách chưa đăng nhập vẫn hỏi thông tin công khai được. Tắt auth không mở lại quyền
tra điểm bằng MSSV tự khai. Self identity lấy từ mapping server của phiên đăng nhập;
model chỉ nhận tham chiếu giả danh cấp mới cho từng lượt. MSSV khác trong câu hỏi
bị chặn trước routing/dispatch, không âm thầm thay bằng MSSV của người đang đăng nhập.
Context tự khai chỉ hỗ trợ hội thoại, không xác nhận quyền sở hữu hoặc ghi đè mapping.
Nhận diện ý định hiện vẫn có guardrail/rule; chưa refactor toàn bộ ngữ nghĩa sang LLM.

Output management và chat chỉ giữ các trường điểm được phép. Chat hiển thị theo
học kỳ và lớp, tối đa 30 hàng cùng giới hạn độ dài, nêu rõ khi chưa hiển thị hết.
Điểm 0 khác với thiếu dữ liệu. Giữ mọi lần học, không tự tính GPA/CPA hoặc kết luận
đỗ/trượt. HTTP 200 có error vẫn là lỗi; null/[] là chưa có dữ liệu, không suy đoán.

Kết quả điểm không gửi sang Gemini, không lưu vào history/context model. History
và request status chứa thông báo kết quả không được lưu với `replayable:false`.
Gửi lại UUID cũ trả `409 REQUEST_NOT_REPLAYABLE`, không gọi HUST lần hai; đổi nội
dung với cùng UUID vẫn trả `REQUEST_ID_REUSED`. Muốn tra cứu lại dùng UUID mới.
Lỗi/clarification của tool điểm cũng không replay để tránh dùng lại ngữ cảnh cá nhân cũ.

Tests, fixtures, mocks và runner chỉ giữ trên máy ngoài repo tại
`../kiem-thu/be/grades/`, không commit/push. Build backend trước, rồi từ workspace
chạy `node kiem-thu/be/grades/run-tests.mjs`. Không thêm script CI phụ thuộc test
local. Để rollback: tắt hai tool qua management và đặt lại `CHAT_GRADES_ENABLED=false`.

Các bài kiểm thử tự động và script kiểm thử API thật đã được chuyển sang
`../kiem-thu/be`, giữ nguyên nội dung để tham khảo hoặc khôi phục khi cần.
Các lệnh `test:*` tương ứng đã được bỏ khỏi `package.json`.

## Đăng nhập demo và bảo vệ điểm cá nhân

Đây là tài khoản demo do người vận hành cấp, không phải đăng nhập Microsoft/HUST.
Chỉ cấu hình mapping tới MSSV được ban tổ chức cho phép. Không có đăng ký công khai
hoặc mật khẩu mặc định. Chạy backend một tiến trình trong giai đoạn demo.

1. Giữ `DEMO_AUTH_ENABLED=false` trong lúc triển khai.
2. Build backend rồi chạy CLI trong thư mục `be`:

   ```powershell
   pnpm.cmd build
   node dist/auth/create-demo-account.js
   ```

   CLI đọc `.env`, hỏi username/MSSV được phép và nhận mật khẩu ẩn (tối thiểu 12 ký
   tự). Không truyền mật khẩu qua command line. Tài khoản được ghi vào
   `.local/demo-auth/accounts.json`, hoặc `DEMO_ACCOUNTS_FILE`. File này phải ở
   ngoài Git; giới hạn quyền đọc file cho người vận hành/backend.
   Record có `accountId`, `username`, `passwordHash` scrypt-v1, `studentId` dạng
   string 8/9 chữ số, `enabled`, `displayName` tùy chọn. Username trim/lowercase,
   accountId/username không được trùng. Mapping cùng MSSV chỉ dùng khi được cấp rõ.

3. Đặt `DEMO_AUTH_ENABLED=true`, `CHAT_GRADES_ENABLED=true`; giữ
   `DEMO_SESSION_TTL_MS=3600000` (hỗ trợ 1 phút–24 giờ). Cấu hình MongoDB và HUST,
   bật tool điểm qua management rồi restart.
4. Mở trang chat trực tiếp, đăng nhập tài khoản demo và hỏi “xem điểm của tôi”.
   `API_ORIGIN=http://localhost:4000`, `WEB_ORIGIN=http://localhost:3000` và URL
   frontend phải thống nhất hostname `localhost`; không trộn `127.0.0.1`.

| Endpoint                        | Hợp đồng                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/demo/login`  | JSON strict `{username,password}`, trả accountId/studentId/displayName/expiresAt/mode |
| `GET /api/v1/auth/demo/me`      | Thông tin phiên tối thiểu hoặc 401                                                    |
| `POST /api/v1/auth/demo/logout` | JSON `{}`, revoke session và xóa cookie, 204; gọi lại an toàn                         |

Mutation auth bắt buộc Origin khớp WEB_ORIGIN/API_ORIGIN và Content-Type JSON.
CORS credentials chỉ cho WEB_ORIGIN cụ thể. Cookie `hustva_demo` là HttpOnly,
host-only, SameSite=Lax, Path=/api/v1; Secure tự bật khi API_ORIGIN dùng HTTPS.
Client chỉ nhận MSSV của chính tài khoản đã xác thực để hiển thị trong chat;
không nhận auth token/passwordHash trong JSON. Login giới hạn theo
IP và username với bucket có TTL và giới hạn số lượng; lỗi sai username/password
dùng cùng thông báo. Rate limit hiện theo tiến trình.

Mongo collection `demo_auth_sessions` chỉ giữ hash token, accountId, config
version và thời điểm tạo/hết hạn; có TTL index và kiểm tra expiry trên từng lần
xác thực. Logout thu hồi ngay phiên tương ứng. Sửa mapping/password/enabled
trong file rồi restart để nạp lại; mọi phiên cũ bị vô hiệu sau restart. Đổi
mapping không tự chuyển hội thoại sang tài khoản khác. Nhiều instance cần cơ chế
version/limiter dùng chung trước khi triển khai; bản này dành cho demo một instance.

Conversation mới sau login có ownerAccountId. Đọc history/request, gửi message,
replay và delete cần cả capability bearer đúng lẫn owner đúng. Hội thoại guest cũ
không tự nhận vào tài khoản mới; hãy tạo hội thoại mới sau đăng nhập. Giữ token
hội thoại cũng không vượt được owner check. Có thể giữ collection/context cũ;
không migration tự gán chủ sở hữu cho dữ liệu legacy.

Tool điểm kiểm tra mapping và phiên ngay trước dispatch, sau khi upstream trả về
và trước phản hồi chat. Logout/expiry trong khi HUST đang chạy loại bỏ kết quả
cá nhân; không thể thu hồi lời gọi đã tới HUST. Management giữ quyền vận hành
riêng, chỉ adapter đã kiểm tra management bearer mới tạo trusted context.
Không đưa principal/role/source/verified vào JSON để cấp quyền.

Rollback an toàn: tắt `CHAT_GRADES_ENABLED` và `DEMO_AUTH_ENABLED`, restart, giữ
gate tool mới; không rollback sang bản cho phép tra điểm bằng MSSV tự khai.
Không commit file tài khoản, `.env`, test, fixture hoặc kết quả test. Test local ở
`../kiem-thu/be/demo-auth`, `../kiem-thu/be/grades`, `../kiem-thu/be/gemini`;
build lại `dist` trước khi chạy. Kiểm thử bằng dữ liệu giả lập không chứng minh
HUST thật, Microsoft SSO hoặc hạ tầng Mongo đang hoạt động.

## Tra cứu lịch thi cá nhân

Tool `get_exams` gọi Partner `/exams`, dùng MSSV từ tài khoản demo đã đăng nhập.
Đầu vào thực thi là JSON strict `{"semester":"20261"}`; không nhận `studentId`
do người dùng truyền. Management dùng MSSV thử nghiệm đã cấu hình trong
`DEMO_STUDENT_ID` (8 hoặc 9 chữ số); chat luôn dùng mapping của principal.
Không cần key hoặc API HUST mới ngoài cấu hình Partner hiện có.

Để bật thử, giữ cấu hình đăng nhập demo hợp lệ, thêm `CHAT_EXAMS_ENABLED=true`
vào `.env`, restart backend và bật `get_exams` trên trang quản trị tools hoặc
`PATCH /api/v1/tools/get_exams` với body `{"enabled":true}` và management bearer.
Không dùng token quản trị ở frontend chat. Tool và cờ chat đều tắt mặc định;
`CHAT_EXAMS_ENABLED` độc lập với `CHAT_GRADES_ENABLED`. `.env.example` chỉ có
giá trị mẫu, không ghi đè `.env` hiện có khi cập nhật cấu hình.

- “Lịch thi của tôi kỳ 20261”: một lần gọi tool lịch thi.
- “Lịch thi kỳ này”: resolve qua `get_semesters`, sau đó `get_exams`; cần bật
  semesters và `CHAT_MAX_TOOL_CALLS`, `CHAT_MAX_TOOL_ROUNDS` đều ít nhất 2.
  Đây là ngân sách tool logic; retry HTTP vẫn hữu hạn trong deadline chung.
- “Xem lịch thi của tôi”: hỏi kỳ, không bắt nhập lại MSSV. Câu tiếp chỉ có mã
  kỳ có thể tiếp tục yêu cầu; “kỳ đó” chỉ dùng metadata backend còn hạn.
- “Kỳ trước/kỳ tới” chưa có mã: hỏi mã cụ thể, không suy ra quy tắc kỳ hè.
- “Sắp tới tôi có thi gì không”: model chọn `semester="upcoming"`; backend lấy
  kỳ hiện tại từ HUST và lọc những buổi bắt đầu từ thời điểm xử lý. Không dùng
  kỳ đã nhắc trước làm mặc định cho câu này. Phạm vi chỉ trong học kỳ hiện tại,
  chưa gộp mọi học kỳ tương lai. Buổi thiếu timestamp vẫn hiển thị kèm cảnh báo
  chưa xác định thời gian; không tự coi là đã qua hoặc sắp thi. Khi chỉ có buổi
  đã qua, bot báo chưa thấy buổi từ hiện tại trong dữ liệu kỳ đó, không kết luận
  sinh viên không còn kỳ thi nào.

Lịch thi trả bảng Markdown, giờ `Asia/Ho_Chi_Minh`, giữ các ca thi riêng biệt.
Tối đa 30 buổi/khoảng 9.000 ký tự; báo rõ khi chưa hiển thị hết. Timestamp dùng
milliseconds; chuỗi ngày nguồn được giữ nguyên, không parse ngày tự do. Đối
chiếu mâu thuẫn hỗ trợ `dd/MM/yyyy` hoặc `yyyy-MM-dd`, tùy chọn giờ `HH:mm[:ss]`
không có timezone; chuỗi khác chỉ hiển thị nguồn để người dùng đối chiếu.
Text nguồn có control character, URL/email hoặc dạng secret bị từ chối; response
sai cấu trúc báo `HUST_EXAMS_DATA_INVALID`, không bỏ lén hàng lỗi.

Kỳ hè trả giới hạn API thay vì gọi `/exams`; null/mảng rỗng nghĩa là HUST chưa
trả dữ liệu, không kết luận không phải thi. Timeout/error không thay bằng lịch
cũ hoặc số liệu do model tạo. Tra quy chế thi vẫn dùng luồng kiến thức.

Quyền tài khoản được kiểm tra trước/sau upstream và trước phản hồi. Lịch thi
không gửi Gemini, không vào log/history/request replay; history chỉ giữ
placeholder. Metadata nội bộ chỉ gồm mã kỳ và hạn sử dụng tối đa 30 phút,
thuộc đúng conversation/owner, tìm trong 10 lượt gần nhất; không xuất metadata
qua API history và không dùng public context do client gửi để cấp quyền.
Logout/hết hạn giữa lượt loại kết quả muộn; không thu hồi được lời gọi đã gửi HUST.

Rollback: tắt `CHAT_EXAMS_ENABLED`, restart và tắt `get_exams` qua management;
không mở tra cứu lịch thi cho guest. Không cần migration bắt buộc: trường routing
metadata mới là tùy chọn trên request record. Không thay đổi layout frontend.

Test/fixture/runner/kết quả chỉ giữ local ở `../kiem-thu/be/exams/`; build backend
rồi chạy `node ../kiem-thu/be/exams/run-tests.mjs` từ repo backend hoặc
`node kiem-thu/be/exams/run-tests.mjs` từ workspace root. Runner cũng cần các bộ
hồi quy local và dependencies frontend để kiểm tra Markdown/auth transport;
không thiết lập CI phụ thuộc các file ngoài repo. Kiểm thử mock không thay thế
xác minh API HUST, Gemini thật hoặc kiểm tra trực quan trên trình duyệt.

## Tra cứu đề tài giảng viên và công ty

Hai tool `get_teacher_research_topics` (`teacher/research-topic`, input strict
`{"teacherId":"<ID>"}`) và `get_company_research_topics`
(`company/research-topic`, `{"companyId":"<ID>"}`) lấy dữ liệu công bố dùng chung,
không cần MSSV hoặc demo login. Credential Partner vẫn chỉ nằm ở backend.
Management endpoints cần bearer vận hành như các tool khác. ID là string opaque;
ID số nguyên an toàn từ search được chuyển sang string, giữ số 0 đầu của ID string.

Để bật thử: thêm `CHAT_TOPICS_ENABLED=true` vào `.env`, restart backend, bật
từng tool đề tài qua trang tools hoặc `PATCH /api/v1/tools/<tool-id>` với
`{"enabled":true}` và management bearer. Hai tool và cờ chat mặc định tắt.
Giữ `search_teachers`/`search_companies` bật; hỏi theo tên cần ít nhất 2
`CHAT_MAX_TOOL_CALLS` và 2 `CHAT_MAX_TOOL_ROUNDS`. Cờ này độc lập grades/exams;
không phải cờ xác thực sinh viên. Không đưa management token vào chat frontend.

- Hỏi “đề tài của thầy …” hoặc “đề tài thực tập công ty …”: LLM chọn ý định/tên,
  backend gọi search rồi lấy ID từ response, tối đa hai tool calls logic.
- Search nhiều kết quả: hỏi chọn từ danh sách (tối đa 10), không chọn dòng đầu.
  “Người thứ 2”/“thứ hai” chọn đúng batch đang hiển thị; “thầy đó/công ty đó”
  chỉ tiếp nối đối tượng đã chọn. Chọn từ context cần một tool call topics.
  Có thể chọn bằng tên trường/đơn vị trong danh sách nếu khớp duy nhất một
  candidate, kể cả viết không dấu. Nếu nhiều người cùng đơn vị thì hỏi số
  thứ tự; không mặc định dùng selectedRef cũ trái với đơn vị vừa được chọn.
- Đơn vị giảng viên nêu trong câu được kiểm tra với `schoolName` bằng so khớp
  text chuẩn hóa; không tự diễn giải tên viết tắt thành tên trường/khoa. Nếu
  không đối chiếu được thì hỏi lại; không áp bộ lọc này cho công ty.
- Thiếu tên, yêu cầu tìm đề tài toàn trường theo lĩnh vực hoặc đăng ký đề tài:
  chưa hỗ trợ. Không dùng đề tài công khai để suy ra sinh viên đang làm đề tài gì.

Model schema dùng tên hoặc opaque target ref, không nhận source ID. Context
`chat_research_targets` chỉ lưu batch/selected target, ID nguồn, nhãn và expiry;
TTL tối đa 10 phút và không vượt hạn conversation. Context được kiểm tra
capability/owner trước đọc/ghi, lease trước save; TTL kiểm tra cả khi đọc và
được dọn bằng Mongo TTL index. Xóa conversation xóa context. Ref sai phiên,
hết hạn, khác loại hoặc không khớp lựa chọn phải chọn lại. Không chấp nhận
lookup state từ public context của client. Không lưu mô tả đề tài trong context.

Kết quả trả Markdown với tiêu đề/mô tả ngắn và các field theo nguồn, không
gọi model để viết lại. Tối đa 10 đề tài/khoảng 9.000 ký tự; cắt mô tả có nhãn
rút gọn và luôn nêu số đang hiển thị/tổng số. Description cho phép multiline,
HTML được chuyển thành text; script/style bị bỏ, markup được escape. Link/email
trong prose được thay bằng nhãn nguồn/liên hệ, không tạo link đăng ký. Không
diễn giải mã trạng thái thành đang tuyển/đã đóng hoặc số sinh viên thành chỗ trống.
Tool turns không đưa vào model history; response công khai đã normalize giữ
replay theo cơ chế public tool hiện có. Log không ghi tên/ID/args/payload.

Schema teacher/company được tách riêng. Theo lần kiểm tra ngày 27/11/2026,
search thật trả ID number. Đã xác minh một response teacher có 13 đề tài:
`programIds` có thể là mảng ID số nguyên nội bộ, không chỉ string. Giữ cả
hai dạng, không tự đổi ID số thành mã ngành IT1/IT2; UI ghi “Chương trình theo nguồn”.
Company mới xác minh được response rỗng và chưa có mô tả field item chính thức
trong tài liệu được cấp. Adapter company hiện nhận field hiển thị tương ứng
`title/description/studentNum/departmentName/programIds/types/topicType/internType/status`;
biến thể khác trả `HUST_TOPICS_DATA_INVALID`, không đoán hoặc trả raw payload.
`null`/`[]` chỉ là HUST chưa trả đề tài, không kết luận đơn vị không nhận sinh viên.

Các bộ test/fixture/probe chỉ giữ local ngoài repo, không đưa vào CI/commit.
Build backend rồi chạy `node ../kiem-thu/be/research-topics/run-tests.mjs` từ
repo backend hoặc `node kiem-thu/be/research-topics/run-tests.mjs` từ workspace.
Runner cần các bộ hồi quy local và dependencies frontend để kiểm tra SSR/auth.
Không cần thay layout frontend hoặc đăng nhập lại để dùng dữ liệu công khai.

Rollback: tắt `CHAT_TOPICS_ENABLED`, restart và disable hai topic tool qua
management; search và tool cá nhân giữ cấu hình riêng. Collection context mới
có TTL, không cần migration bắt buộc cho conversation cũ.

## Trace và kiểm tra code

### Định dạng câu trả lời

`answer` hỗ trợ Markdown. Prompt ưu tiên trả lời bằng đoạn văn ngắn, chỉ dùng
danh sách cho các bước/mục song song và bảng khi dữ liệu phù hợp. Backend vẫn
kiểm chứng evidenceIds của từng claim rồi ghép các đoạn bằng dòng trống, gắn
số trích dẫn `[1]`, `[2]`. Nguồn nằm trong `citations`, không lặp thêm mục Nguồn
trong chuỗi answer; client cần render danh sách citations riêng. Tool điểm trả
bảng Markdown theo học kỳ, vẫn giữ giới hạn 30 dòng, 9000 ký tự và không lưu điểm.

Backend ghi log JSON ra terminal. Đặt `LOG_LEVEL=debug` trong `.env` rồi restart để xem thêm các bước xử lý. Lấy header `X-Trace-Id` trong response Postman để tìm log; lượt chat có thêm `requestId`/`runId` và thời gian xử lý. Logger không ghi body chat, prompt, token, API key hoặc payload lỗi thô.

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd build
```

Có thể kiểm tra chức năng qua các endpoint Postman ở trên.

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
