"""Send example cases to a running System One service and print the answers.

  python examples/run.py                       # examples/cases.json -> http://127.0.0.1:8002
  python examples/run.py my-cases.json --url http://127.0.0.1:8002

Standard library only. A cases file holds shared `questions` and a list of `cases`,
each `{name, state, questions?, expect?}`; `expect` maps a question id to a label
(choice) or a bound like ">0.8" / "<0.5" (noul). Do not put real student data in
files committed to git.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_FILE = Path(__file__).with_name("cases.json")


def post(url: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{url}/v1/systemone",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def describe(answer: dict) -> tuple[str, float]:
    if answer["type"] == "noul":
        return f"{answer['noul']:.2f}", answer["noul"]
    label = answer["choice"]
    return f"{label} ({answer['probabilities'][label]:.2f})", answer["probabilities"][label]


def check(answer: dict, expected: str) -> bool:
    if answer["type"] == "choice":
        return answer["choice"] == expected
    bound = float(expected[1:])
    return answer["noul"] > bound if expected[0] == ">" else answer["noul"] < bound


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", nargs="?", type=Path, default=DEFAULT_FILE)
    parser.add_argument("--url", default="http://127.0.0.1:8002")
    args = parser.parse_args()

    data = json.loads(args.file.read_text(encoding="utf-8"))
    try:
        print("service:", json.dumps(json.load(urllib.request.urlopen(f"{args.url}/info"))))
    except urllib.error.URLError:
        print(f"Không gọi được {args.url}. Chạy service trước: .venv/bin/python app.py")
        return 1

    passed = total = 0
    for case in data["cases"]:
        body = {"state": case["state"], "questions": case.get("questions", data["questions"])}
        started = time.perf_counter()
        try:
            result = post(args.url, body)
        except urllib.error.HTTPError as error:
            print(f"\n[{case['name']}] HTTP {error.code}: {error.read().decode()}")
            continue
        round_trip = (time.perf_counter() - started) * 1000
        print(f"\n[{case['name']}] {round_trip:.0f} ms, truncated={result['usage']['truncated']}")
        for qid, answer in result["answers"].items():
            text, _ = describe(answer)
            expected = case.get("expect", {}).get(qid)
            mark = ""
            if expected is not None:
                ok = check(answer, expected)
                passed, total = passed + ok, total + 1
                mark = f"  {'OK ' if ok else 'SAI'} (mong đợi {expected})"
            print(f"  {qid:<16} {text}{mark}")
    if total:
        print(f"\nKhớp kỳ vọng: {passed}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
