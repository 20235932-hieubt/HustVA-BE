# HustVA Backend

API crawl nội dung công khai HUST từ HTML và PDF. Gọi API với nguồn cần lấy, API thực hiện crawl và trả đầy đủ nội dung sau khi hoàn tất. Không có app Worker hoặc lịch tự động.

Backend là một ứng dụng với một `package.json`. `src/app.ts` cấu hình Express, `src/server.ts` mở API và `src/crawler/` chứa toàn bộ logic crawl. Luồng xử lý: request chọn nguồn → tải HTML/PDF → trích xuất → lưu → trả JSON.

Tại thư mục `be`, dùng Node.js 22 và pnpm 10.33.0:

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd dev
```

Nếu chưa có pnpm trên PATH, thay `pnpm.cmd` bằng `npm.cmd exec --yes --package=pnpm@10.33.0 -- pnpm`.

Trong Postman gọi:

```http
POST http://localhost:4000/api/v1/crawler/crawl?sourceId=library
```

Không cần body. Response `200` chứa `{ run, documents }`, trong đó `documents` là toàn bộ nội dung trích xuất được. API đọc hết các bài, phân trang và PDF phát hiện được trong phạm vi nguồn đã định nghĩa. Xem các nguồn bằng `GET /api/v1/crawler/sources`.

Một lượt có thể chạy lâu; đặt Request timeout của Postman thành `0` để chờ. Nếu có lượt khác đang crawl, API trả `409`. Không crawl tự động khi khởi động API.

Console in tiến trình; nội dung và bản gốc lưu trong `.local/crawler`. Các file `exports/latest.txt` và `latest.jsonl` được cập nhật sau mỗi lượt. PDF scan/hình ảnh chưa có OCR; kết quả có cảnh báo khi cần đối chiếu.

- [Cách gọi bằng Postman](docs/development/crawler-local.md)
- [Collection Postman](docs/postman/HustVA-Crawler.postman_collection.json)
- [Phân tích nguồn và logic](docs/crawler-analysis.md)
- [Kết luận khảo sát nguồn](docs/crawl-sources.md)
- [Kế hoạch ReAct agent dùng MongoDB Atlas](docs/development/react-agent-plan.md)
- [Setup MongoDB Atlas cho dữ liệu và Vector Search](docs/development/cloud-databases.md)

Kho tri thức và agent dùng một MongoDB Atlas cluster, bao gồm Vector Search. Điền `.env` theo hướng dẫn rồi chạy `pnpm.cmd db:check` để kiểm tra kết nối, `pnpm.cmd db:setup` để chuẩn bị collections/index cần thiết. Vector index chỉ được tạo khi có `EMBEDDING_DIMENSION`. Chưa cần khởi động Docker hoặc dịch vụ DB khác. Crawler vẫn lưu file độc lập; các lệnh setup không tự import dữ liệu crawl.

## Embedding

Crawler lưu xong một tài liệu mới hoặc đã đổi nội dung thì phát event `document.saved`; tài liệu được chunk và embed ngay trong nền, không làm chậm hay hỏng lượt crawl. Code nằm ở `src/embedding/`, mô hình chạy ở service Python `services/embedding/` ([cách chạy](services/embedding/README.md)). Vector và trạng thái lưu local trong `.local/embedding`.

```
crawler saveDocument ─(saved)─► publisher ─► hàng đợi ─► đọc tài liệu → chunk → embed → lưu vector
                                         reconcile (lúc khởi động + mỗi 5 phút) ─┘
```

- Chunk theo cấu trúc: tiêu đề, Chương/Mục, Điều, Phụ lục; Điều dài cắt theo Khoản; bảng giữ nguyên hàng, bảng dài tách theo hàng và lặp hàng tiêu đề. Mỗi chunk giữ URL, trang PDF, tiêu đề cha, khóa (`cohorts`), nguồn.
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

Khi chuyển sang MongoDB/RabbitMQ/Qdrant chỉ cần thay phần cài đặt trong `src/embedding/service.ts`: `DocumentReader` (đọc tài liệu), `DocumentEventPublisher` (hàng đợi), `VectorStore` (vector), `IndexStateStore` (`index_status`). Chunk id đã có dạng UUID để dùng làm point id của Qdrant.

Kiểm tra code bằng `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build`. Kiểm thử chức năng crawler do bạn thực hiện qua Postman. Không cần Docker để chạy crawler.
