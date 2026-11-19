# Embedding service

Service Python nhỏ chạy mô hình [`dangvantuan/vietnamese-document-embedding`](https://huggingface.co/dangvantuan/vietnamese-document-embedding) (768 chiều, vector đã chuẩn hóa). API TypeScript gọi service này qua HTTP; service chỉ mở ở `127.0.0.1:8001`.

## Chạy lần đầu

Tại thư mục `services/embedding`:

```powershell
python -m venv .venv
# Máy không có GPU NVIDIA: bản CPU (nhẹ, ~200 MB)
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
# Hoặc có GPU NVIDIA: thay cu128 bằng bản CUDA phù hợp với driver
# .venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

Lần đầu tải mô hình (~1,2 GB) vào cache Hugging Face nên mất vài phút. Khi thấy `Embedding model ready` là dùng được.

## API

- `GET /info` → `{ model, revision, dimension, maxSeqLength, device }`
- `POST /embed` với `{ "texts": ["..."] }` (tối đa 64) → `{ vectors, model, revision, dimension }`

Câu hỏi và đoạn văn embed giống nhau, không cần tiền tố, không cần tách từ.

## Lưu ý

- Mô hình chạy code tùy biến (`trust_remote_code`). Repo trọng số và repo chứa code (`dangvantuan/Vietnamese_impl`) đều được khóa theo commit trong `app.py`. Đổi revision thì đọc lại code trước.
- Phải dùng `transformers` 4.x. Trên 5.x code của mô hình chạy sai (buffer vị trí không được khởi tạo, thiếu `get_extended_attention_mask`).
- `EMBEDDING_MAX_SEQ_LENGTH` mặc định 1024 token; chunk của ingestion nhỏ hơn nhiều.
- Biến môi trường: `EMBEDDING_PORT`, `EMBEDDING_DEVICE` (`cpu`/`cuda`), `EMBEDDING_BATCH_SIZE`, `EMBEDDING_MODEL_REVISION`, `EMBEDDING_CODE_REVISION`.
- Đổi mô hình hoặc revision thì phía API tự embed lại toàn bộ ở lượt reconcile kế tiếp, vì tên mô hình kèm revision được lưu trong trạng thái index.
