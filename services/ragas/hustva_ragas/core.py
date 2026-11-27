"""Contracts and local reports. No provider calls or student data collection here."""
import csv
import hashlib
import html
import json
import math
from collections import Counter
from pathlib import Path

BEHAVIORS = {"answer", "correct_premise", "answer_with_caveat", "refuse", "clarify"}
ANSWERABLE = {"answer", "correct_premise", "answer_with_caveat"}
METRICS = {"correctness", "faithfulness", "context_precision", "context_recall", "behavior"}


def load_dataset(path: Path) -> tuple[dict, list[dict], str]:
    raw = path.read_bytes()
    data = json.loads(raw)
    rows = data.get("questions") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise ValueError("Dataset phải có questions không rỗng.")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or row["id"] in seen:
            raise ValueError("Mỗi câu cần id duy nhất.")
        seen.add(row["id"])
        if not isinstance(row.get("question"), str) or not 1 <= len(row["question"]) <= 4000:
            raise ValueError(f"Câu {row['id']}: question không hợp lệ.")
        if row.get("expected_behavior") not in BEHAVIORS:
            raise ValueError(f"Câu {row['id']}: expected_behavior không hợp lệ.")
        if not isinstance(row.get("reference"), str) or not row["reference"].strip():
            raise ValueError(f"Câu {row['id']}: thiếu reference.")
        answers = row.get("answers", [])
        if not isinstance(answers, list) or any(not isinstance(a, str) for a in answers):
            raise ValueError(f"Câu {row['id']}: answers phải là mảng string.")
    return data if isinstance(data, dict) else {}, rows, hashlib.sha256(raw).hexdigest()


def load_responses(path: Path) -> dict:
    text = path.read_text(encoding="utf-8-sig")
    records = json.loads(text) if text.lstrip().startswith("[") else [json.loads(line) for line in text.splitlines() if line.strip()]
    result = {}
    for row in records:
        key = row.get("id")
        if not isinstance(key, str) or key in result or not isinstance(row.get("response"), str):
            raise ValueError("Responses cần id duy nhất và response dạng string.")
        contexts = row.get("retrieved_contexts", [])
        if not isinstance(contexts, list) or any(not isinstance(c, str) for c in contexts):
            raise ValueError(f"Responses {key}: retrieved_contexts phải là mảng string.")
        if sum(map(len, contexts)) > 100000:
            raise ValueError(f"Responses {key}: context quá lớn; không cắt ngầm dữ liệu.")
        result[key] = row
    return result


def finite_score(value) -> float:
    score = float(value)
    if not math.isfinite(score):
        raise ValueError("METRIC_NON_FINITE")
    return score


def summarize(rows: list[dict], metrics: list[str], thresholds: dict) -> dict:
    result = {"cases": len(rows), "case_errors": sum(bool(r.get("error")) for r in rows), "metrics": {}}
    positive = [r for r in rows if r['expected_behavior'] in ANSWERABLE]
    result['answerable_cases'] = len(positive)
    result['answerable_with_response'] = sum(bool(r.get('response')) for r in positive)
    result['answerable_with_context'] = sum(bool(r.get('retrieved_contexts')) for r in positive)
    result['status_counts'] = dict(Counter(r.get('status', 'unknown') for r in rows))
    quality_fail = False
    for metric in metrics:
        values = [r["scores"][metric] for r in rows if metric in r.get("scores", {})]
        errors = sum(metric in r.get("metric_errors", {}) for r in rows)
        na = sum(metric in r.get("not_applicable", {}) for r in rows)
        mean = sum(values) / len(values) if values else None
        result["metrics"][metric] = {"mean": mean, "scored": len(values), "errors": errors,
                                     "not_applicable": na, "total": len(rows)}
        if metric in thresholds and (mean is None or mean < thresholds[metric]):
            quality_fail = True
    incomplete = result["case_errors"] or any(v["errors"] for v in result["metrics"].values())
    result["status"] = "incomplete" if incomplete else "quality_fail" if quality_fail else "completed"
    result["thresholds"] = thresholds
    result["note"] = "completed nghĩa là chấm xong, không phải mọi câu trả lời đều đúng. Ngưỡng chỉ áp dụng khi được chỉ định."
    return result


def write_reports(folder: Path, rows: list[dict], summary: dict, manifest: dict):
    for name, value in [("manifest.json", manifest), ("summary.json", summary)]:
        (folder / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    with (folder / "cases.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        names = list(summary["metrics"])
        writer.writerow(["id", "topic", "expected_behavior", "status", *names, "errors"])
        for row in rows:
            writer.writerow([row["id"], row.get("topic", ""), row["expected_behavior"], row.get("status", ""),
                             *[row.get("scores", {}).get(n, "") for n in names],
                             row.get("error") or json.dumps(row.get("metric_errors", {}))])
    esc = lambda value: html.escape(str(value))
    sections = []
    for row in rows:
        sections.append(f'<article><h2>{esc(row["id"])} — {esc(row["question"])}</h2>'
                        f'<p><b>Kỳ vọng:</b> {esc(row["expected_behavior"])}</p>'
                        f'<h3>HustVA trả lời</h3><pre>{esc(row.get("response", ""))}</pre>'
                        f'<h3>Đáp án chuẩn</h3><pre>{esc(row["reference"])}</pre>'
                        f'<pre>{esc(json.dumps({k: row.get(k) for k in ["scores", "behavior_reason", "metric_errors", "not_applicable", "error"]}, ensure_ascii=False, indent=2))}</pre>'
                        f'<details><summary>Context thực nhận</summary><pre>{esc(chr(10).join(row.get("retrieved_contexts", [])))}</pre></details></article>')
    document = '<!doctype html><html lang="vi"><meta charset="utf-8"><title>HustVA — Ragas</title><style>body{font:16px/1.6 system-ui;max-width:1000px;margin:32px auto;padding:0 20px;color:#222}h1{color:#ae192e}article{border-top:1px solid #ddd;margin-top:24px;padding-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f7;padding:16px;border-radius:8px}summary{cursor:pointer}</style><h1>Đánh giá HustVA bằng Ragas</h1>'
    document += f'<pre>{esc(json.dumps(summary, ensure_ascii=False, indent=2))}</pre>' + ''.join(sections) + '</html>'
    (folder / "report.html").write_text(document, encoding="utf-8")
    lines = ["BÁO CÁO ĐÁNH GIÁ HUSTVA / RAGAS", f"Trạng thái: {summary['status']}", f"Số câu: {len(rows)}", summary["note"]]
    for name, metric in summary["metrics"].items():
        mean = "N/A" if metric["mean"] is None else f"{metric['mean']:.4f}"
        lines.append(f"{name}: {mean}; scored={metric['scored']}; errors={metric['errors']}; N/A={metric['not_applicable']}")
    lines += ["", "Dataset draft chưa thay thế việc duyệt đáp án bởi người phụ trách nội dung.",
              "Ragas judge có thể sai; cần xem từng case. Không có điểm Ragas trước khi chạy judge thật.",
              "Chi tiết: report.html, cases.csv, results.jsonl, generations.jsonl, manifest.json."]
    (folder / "report.txt").write_text('\n'.join(lines), encoding="utf-8")
