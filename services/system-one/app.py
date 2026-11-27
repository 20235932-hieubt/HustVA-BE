"""HustVA System One service.

Wraps the classic Laya encoder (convaiinnovations/laya-multilingual) behind a small HTTP API
with the same request/response shape as the Jev System One API. Binds to 127.0.0.1 only.

  GET  /info          -> { model, revision, device, maxLen }
  POST /v1/systemone  { "state": {...}, "questions": {...} }
                      -> { model, answers, usage: { input_tokens, truncated }, latencyMs }

The state and the questions carry student messages: they are never printed or logged. Errors
return a fixed message, never the request body or an exception message.
"""

from __future__ import annotations

import os

# Set before huggingface_hub is imported (through laya) so it is read at import time.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import threading
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal, Union

import laya
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

MODEL_ID = os.getenv("SYSTEM_ONE_MODEL_ID", "convaiinnovations/laya-multilingual")
# Reviewed commit of the checkpoint; equals laya.PINNED_REVISIONS for laya==0.5.0.
REVISION = os.getenv("SYSTEM_ONE_MODEL_REVISION", "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67")
DEVICE = os.getenv("SYSTEM_ONE_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
MAX_LEN = int(os.getenv("SYSTEM_ONE_MAX_LEN", "1024"))
MAX_QUESTIONS = int(os.getenv("SYSTEM_ONE_MAX_QUESTIONS", "8"))
# The model card advises at most ~20 options per choice question.
MAX_OPTIONS = 20
MAX_STATE_CHARS = 20_000
MAX_TEXT_CHARS = 2_000

Key = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
Text = Annotated[str, StringConstraints(min_length=1, max_length=MAX_TEXT_CHARS)]
StateValue = Annotated[str, StringConstraints(max_length=MAX_STATE_CHARS)]

state: dict[str, Any] = {}
lock = threading.Lock()


class NoulQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["noul"]
    instructions: Text


class ChoiceQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["choice"]
    instructions: Text
    criteria: Annotated[dict[Key, Text], Field(min_length=2, max_length=MAX_OPTIONS)]


Question = Annotated[Union[NoulQuestion, ChoiceQuestion], Field(discriminator="type")]


class DecideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Annotated[dict[Key, StateValue], Field(min_length=1)]
    questions: Annotated[dict[Key, Question], Field(min_length=1)]


def load_agent() -> Any:
    # Naming a checkpoint plus vegaml=False selects the classic encoder, not the "vega" engine
    # that laya>=0.5 uses for a bare laya.Agent().
    return laya.Agent(MODEL_ID, device=DEVICE, revision=REVISION, vegaml=False)


def warm_up(agent: Any) -> None:
    # The first forward pass on MPS costs ~0.5 s (kernel setup); pay it before serving.
    questions = {
        "warm": {"type": "choice", "instructions": "warm up", "criteria": {"a": "a", "b": "b"}},
        "warm_noul": {"type": "noul", "instructions": "warm up"},
    }
    with lock, torch.inference_mode():
        agent.system_one({"message": "warm up"}, questions, max_len=MAX_LEN)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["agent"] = load_agent()
    warm_up(state["agent"])
    print(f"System One model ready: {model_name()} on {DEVICE}", flush=True)
    yield
    state.clear()


app = FastAPI(title="HustVA System One", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # FastAPI's default body echoes the offending input; return only where and why.
    errors = [{"loc": list(e.get("loc", ())), "type": e.get("type")} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors})


def model_name() -> str:
    return f"{MODEL_ID.rsplit('/', 1)[-1]}@{REVISION[:7]}"


def agent_or_503() -> Any:
    agent = state.get("agent")
    if agent is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return agent


def normalise_answer(question: NoulQuestion | ChoiceQuestion, raw: dict) -> dict:
    if isinstance(question, NoulQuestion):
        return {"type": "noul", "noul": float(raw["noul"])}
    return {
        "type": "choice",
        "choice": str(raw["choice"]),
        "probabilities": {k: float(v) for k, v in raw["probabilities"].items()},
    }


@app.get("/info")
def info() -> dict:
    agent_or_503()
    return {"model": model_name(), "revision": REVISION, "device": DEVICE, "maxLen": MAX_LEN}


@app.post("/v1/systemone")
def decide(request: DecideRequest) -> dict:
    agent = agent_or_503()
    if len(request.questions) > MAX_QUESTIONS:
        raise HTTPException(
            status_code=413, detail=f"At most {MAX_QUESTIONS} questions per request"
        )
    questions = {qid: q.model_dump() for qid, q in request.questions.items()}
    started = time.perf_counter()
    try:
        # One forward pass at a time: concurrent calls would only fight over the same GPU.
        with lock, torch.inference_mode():
            raw = agent.system_one(request.state, questions, max_len=MAX_LEN)
        answers = {
            qid: normalise_answer(q, raw["answers"][qid]) for qid, q in request.questions.items()
        }
        usage = raw.get("usage", {})
    except ValueError:
        # laya refuses questions it cannot fit (e.g. options past max_len) with ValueError.
        raise HTTPException(status_code=422, detail="Questions rejected by the model") from None
    except Exception as error:
        # Only the class name: laya messages may quote question ids or option text.
        print(f"System One inference failed: {type(error).__name__}", flush=True)
        raise HTTPException(status_code=500, detail="Inference failed") from None
    return {
        "model": model_name(),
        "answers": answers,
        "usage": {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "truncated": bool(usage.get("truncated", False)),
        },
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("SYSTEM_ONE_HOST", "127.0.0.1"),
        port=int(os.getenv("SYSTEM_ONE_PORT", "8002")),
    )
