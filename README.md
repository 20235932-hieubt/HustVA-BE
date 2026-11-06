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

Kiểm tra code bằng `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build`. Kiểm thử chức năng crawler do bạn thực hiện qua Postman. Không cần Docker để chạy crawler.
