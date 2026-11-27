# System One service

Service Python nhỏ chạy encoder cổ điển của
[`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual)
(mmBERT-base + decision head, 322M). Model chỉ trả lời câu hỏi dạng `noul` /
`choice` kèm xác suất, không sinh văn bản. API TypeScript gọi service này qua
HTTP (`src/system-one/client.ts`); service chỉ mở ở `127.0.0.1:8002`.

## Chạy lần đầu (Mac Apple Silicon)

Dùng **venv riêng** với Python 3.12: laya cần `transformers` 5.x, còn
`services/embedding` ghim 4.x. Tại thư mục `services/system-one`:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python app.py
```

Lần đầu tải checkpoint (~650 MB) vào cache Hugging Face. Khi thấy
`System One model ready` là dùng được (nạp + warm-up ~10 s trên M4).

## API

- `GET /info` → `{ model, revision, device, maxLen }`
- `POST /v1/systemone` với `{ state, questions }` (cùng dạng System One của
  Jev):
  - `state`: object chuỗi, ví dụ `{ "message": "..." }`.
  - `questions`: tối đa 8 câu; id và nhãn dạng `^[a-z][a-z0-9_]{0,39}$`.
    - `{ "type": "noul", "instructions": "..." }`
    - `{ "type": "choice", "instructions": "...", "criteria": { "nhan": "mô tả", ... } }`
      (2–20 lựa chọn)
  - Trả về:

```json
{
  "model": "laya-multilingual@e4e9ddf",
  "answers": {
    "loai": {
      "type": "choice",
      "choice": "academic",
      "probabilities": { "academic": 0.58, "out_of_scope": 0.3, "social": 0.11 }
    },
    "tan_cong": { "type": "noul", "noul": 0.93 }
  },
  "usage": { "input_tokens": 77, "truncated": false },
  "latencyMs": 19.3
}
```

`noul` luôn là P(true). `score` không được hỗ trợ (model yếu nhất ở dạng này).

Lỗi: 422 câu hỏi sai dạng (body chỉ có vị trí + loại lỗi, không lặp lại
input), 413 quá 8 câu hỏi, 503 model đang nạp, 500 lỗi suy luận.

## Lưu ý

- Gọi `laya.Agent(<checkpoint>, vegaml=False)`: nêu tên checkpoint là chọn
  encoder cổ điển, không dùng engine "vega" mặc định của laya ≥ 0.5.
- Checkpoint khóa theo commit `e4e9ddf…` (trùng `laya.PINNED_REVISIONS` của
  laya 0.5.0). laya cũng nạp được qua repo bundle `convaiinnovations/laya` +
  `subfolder="multilingual"`, nhưng pin trên là của repo riêng
  `laya-multilingual` nên service dùng repo riêng.
- Không in state/questions ra stdout. Access log của uvicorn chỉ có path +
  status. Lỗi suy luận chỉ in tên lớp exception.
- Xác suất **chưa hiệu chỉnh** (model card: ECE 0,314). Chỉ hành động khi
  xác suất rất cao.
- Biến môi trường: `SYSTEM_ONE_MODEL_ID`, `SYSTEM_ONE_MODEL_REVISION`,
  `SYSTEM_ONE_DEVICE` (`mps`/`cpu`/`cuda`, mặc định `mps` nếu có),
  `SYSTEM_ONE_MAX_LEN` (1024), `SYSTEM_ONE_MAX_QUESTIONS` (8),
  `SYSTEM_ONE_HOST` (127.0.0.1), `SYSTEM_ONE_PORT` (8002).
