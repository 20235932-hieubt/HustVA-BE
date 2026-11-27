# Ragas evaluation service cho HustVA

Service chạy theo batch bằng một lệnh riêng sau mỗi lần sửa code. Không cần
khởi động HTTP server Ragas và không chèn bước chấm điểm vào chat sinh viên.

## Chạy nhanh

Cần Node/dependencies backend và [uv](https://docs.astral.sh/uv/). `uv` tự tạo
Python 3.12 và môi trường riêng trong `.local` của workspace ở lần chạy đầu.
Không dùng chung Python với service embedding.

Từ thư mục `be`:

```powershell
# Chỉ kiểm tra bộ dữ liệu, không gọi Gemini/embedding.
pnpm.cmd eval:ragas --check --limit 0

# Chạy nhanh 5 câu đầu: build code mới -> HustVA trả lời -> Ragas chấm -> report.
pnpm.cmd eval:ragas

# Chạy một câu cụ thể trước khi chạy cả bộ.
pnpm.cmd eval:ragas --case s02 --limit 1

# Chạy toàn bộ golden, tăng ngân sách có chủ đích.
pnpm.cmd eval:ragas --limit 0 --max-model-calls 1500
```

Có thể dùng `node services/ragas/run.mjs` thay `pnpm.cmd eval:ragas`.
Launcher tự build TypeScript trước khi lấy response, không dùng `dist` cũ.
`--check`/`--help` không build và không gọi provider.

**Dừng backend chat đang dùng chung Gemini trước khi chạy batch; giữ service
embedding hoạt động.** Evaluator dùng pool riêng trong một tiến trình Node
cho cả generation và judge, nên từ chối chạy khi thấy app tại
`API_ORIGIN/api/v1/health` đang hoạt động. Không được chạy chương trình khác
dùng cùng quota project trong lúc batch chạy. Việc kiểm tra health không thể
phát hiện mọi ứng dụng bên ngoài dùng cùng project.

Không đổi/rút hết API key hoặc nâng RPM để chạy eval. Chỉ cần cấu hình
Gemini, crawler/vector store và embedding giống app trong `be/.env`. Không
cần bật management tool hoặc đăng nhập tài khoản sinh viên.

## Bộ dữ liệu

Mặc định đọc `eval/golden-v1.json`. Nếu nhánh hiện tại không có file này,
runner tìm `.local/ragas/datasets/golden-v1.json`. Có thể chỉ định tường minh:

```powershell
pnpm.cmd eval:ragas --dataset D:/duong-dan/golden-v1.json --limit 5
```

Schema dùng trực tiếp bộ golden hiện có:

```json
{
  "version": "v1-draft",
  "questions": [
    {
      "id": "public-demo",
      "question": "Câu hỏi kiến thức công khai",
      "reference": "Đáp án chuẩn đã kiểm tra",
      "expected_behavior": "answer",
      "answers": ["Cụm căn cứ để đánh giá retrieval riêng"],
      "context": { "cohort": "K71" }
    }
  ]
}
```

`expected_behavior`: `answer`, `correct_premise`, `answer_with_caveat`, `refuse`
hoặc `clarify`. Reference chỉ đưa cho judge, không đưa cho HustVA lúc sinh
câu trả lời. `answers` của golden không được dùng giả làm retrieved context.
`v1-draft` vẫn là bản nháp: kiểm tra schema không xác nhận đáp án đúng hoặc
văn bản còn hiệu lực; cần người phụ trách nội dung duyệt.

Chỉ dùng câu hỏi, reference và response công khai/tổng hợp. Không nhập bảng
điểm, MSSV, lịch thi hoặc dữ liệu cá nhân từ API HUST vào service này.

## Metric và cách đọc kết quả

Mặc định:

- `correctness`: Ragas `FactualCorrectness`, so response với reference.
- `faithfulness`: Ragas `Faithfulness`, chấm dựa trên context model đã nhận.
- `behavior`: rubric judge riêng kiểm tra hành vi kỳ vọng, gồm hỏi lại/từ chối/
  sửa tiền đề/cảnh báo; đây không phải metric built-in của Ragas.

Có thể thêm metric retrieval có reference:

```powershell
pnpm.cmd eval:ragas --limit 3 --metrics correctness,faithfulness,context_precision,context_recall,behavior
```

Câu `refuse`/`clarify` chỉ chấm behavior, các metric RAG là N/A. Không có
context thì faithfulness/precision/recall là N/A có lý do; không bịa context.
Thống kê hiển thị số mẫu có response/context và denominator từng metric.
Không lấy trung bình phần chấm được rồi coi là toàn bộ bộ dữ liệu đã đạt.

Không có điểm số mặc định khi judge lỗi. Provider timeout, parse lỗi, NaN
hoặc quá budget được ghi riêng, toàn run là `incomplete`. Các metric judge
có thể dao động, không phải kết luận tuyệt đối về chất lượng bot.

Nếu muốn lệnh thất bại khi điểm dưới ngưỡng do bạn chọn:

```powershell
pnpm.cmd eval:ragas --limit 5 --min-correctness 0.8 --min-faithfulness 0.9
```

Các ngưỡng chỉ là ví dụ, cần hiệu chỉnh với dữ liệu tiếng Việt.
Exit code: `0` chấm xong, `1` dưới ngưỡng đã chọn, `2` lỗi/incomplete.
`completed` không có nghĩa mọi câu trả lời đúng 100%.

## Chấm lại response đã lưu

```powershell
pnpm.cmd eval:ragas --responses .local/ragas/runs/<run-id>/generations.jsonl --case s02 --limit 1
```

Mỗi dòng JSONL cần `id`, `response`, `retrieved_contexts` (mảng text); có thể
thêm `question`, `status`, `citations` và evidence metadata. `id` phải duy
nhất, question nếu có phải khớp dataset. Chỉ chọn các ID thực sự có trong
file nếu lần generation trước bị gián đoạn.

Chế độ này không chạy lại HustVA, nhưng vẫn gọi judge. Response không có
context có thể chấm correctness/behavior; faithfulness không áp dụng.
Không có chế độ mock được gắn nhãn thành kết quả chất lượng thật.

## Kết quả và ngân sách

Mỗi lần chạy tạo thư mục riêng, không ghi đè lần trước:

```text
be/.local/ragas/runs/<run-id>/
  generations.jsonl    # response + context thực nhận; chấm lại được
  results.jsonl        # điểm/lỗi/N/A theo case
  manifest.json       # commit, dataset hash, source hashes, model, quota
  summary.json
  cases.csv
  report.html         # mở bằng trình duyệt để xem từng câu
  report.txt          # nội dung phục vụ báo cáo
```

Mặc định 5 câu, 10 RPM và tối đa 150 model attempts; `--rpm` không vượt 15.
Generation, judge và retry dùng chung `EvaluationPool`. Một metric có thể
gọi judge nhiều lần, vì vậy 62 câu tốn nhiều hơn 62 model calls. Token usage
hiện chỉ có phần provider trả được; `usageComplete=false`, không suy ra
chi phí đầy đủ hoặc báo chi phí bằng 0 khi thiếu usage.

Lock `.local/ragas/evaluation.lock` ngăn hai batch chạy đồng thời. Nếu máy
bị tắt đột ngột, kiểm tra không còn job trước khi xóa lock cũ. Không có job
tự chạy nền sau khi sửa code: bạn gọi lệnh khi muốn đánh giá phiên bản mới.

## Phạm vi và cấu trúc

`worker.mjs` dùng graph RAG, prompt, model, retriever và privacy boundary
thật của HustVA. Không khởi tạo HTTP app, crawl/ingestion timer hoặc gọi API
sinh viên. Đây là đánh giá **RAG component**, không phải benchmark routing
của toàn bộ agent/HTTP/UI. Corpus chưa được đóng băng; `corpus_frozen=false`.

Python dùng Ragas collections API và adapter `InstructorBaseRagasLLM` gọi
Node qua stdio. Không mở endpoint judge public và không gửi key vào JSONL.
Dependency được pin và khóa bằng `uv.lock`; pin `langchain-community`
0.3.31 vì bản 0.4.2 đã bỏ module mà Ragas 0.4.3 còn import.

Service/launcher/lock dependency là mã công cụ có thể review. Dataset,
fixture/test và kết quả chạy local không được tự stage/push; giữ nguyên
những file golden mà bạn đã tự quản lý trên nhánh riêng.
