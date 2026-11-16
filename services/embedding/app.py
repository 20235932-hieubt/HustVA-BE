"""HustVA embedding service.

Wraps dangvantuan/vietnamese-document-embedding behind a small HTTP API that the
TypeScript ingestion worker calls. Binds to 127.0.0.1 only.

  GET  /info   -> { model, revision, dimension, maxSeqLength, device }
  POST /embed  { "texts": [...] } -> { vectors: [[...]], model, revision, dimension }
"""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "dangvantuan/vietnamese-document-embedding")
# The model runs remote code (trust_remote_code), so both the weights repo and the repo
# holding the modelling code are pinned to reviewed commits.
REVISION = os.getenv("EMBEDDING_MODEL_REVISION", "6fa4e2f8ed2d33120b0f4442cc81f8f973c3f56b")
CODE_REVISION = os.getenv("EMBEDDING_CODE_REVISION", "e3bd16116a297480feef8047b8f411f7b9142c50")
DEVICE = os.getenv("EMBEDDING_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
# The model accepts ~8k tokens, but chunks are small; a lower cap keeps memory and latency bounded.
MAX_SEQ_LENGTH = int(os.getenv("EMBEDDING_MAX_SEQ_LENGTH", "1024"))
MAX_TEXTS = int(os.getenv("EMBEDDING_MAX_TEXTS", "64"))
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "8"))

state: dict[str, SentenceTransformer] = {}
lock = threading.Lock()


def load_model() -> SentenceTransformer:
    # Needs transformers 4.x (see requirements.txt). On 5.x the model's remote code breaks:
    # its position/RoPE buffers are left uninitialised and get_extended_attention_mask is gone.
    model = SentenceTransformer(
        MODEL_ID,
        revision=REVISION,
        trust_remote_code=True,
        device=DEVICE,
        config_kwargs={"code_revision": CODE_REVISION},
        model_kwargs={"code_revision": CODE_REVISION},
    )
    model.max_seq_length = MAX_SEQ_LENGTH
    return model


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["model"] = load_model()
    print(f"Embedding model ready: {MODEL_ID}@{REVISION[:7]} on {DEVICE}", flush=True)
    yield
    state.clear()


app = FastAPI(title="HustVA embedding", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)


def model_or_503() -> SentenceTransformer:
    model = state.get("model")
    if model is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return model


def info_of(model: SentenceTransformer) -> dict:
    return {
        "model": MODEL_ID,
        "revision": REVISION,
        "dimension": model.get_sentence_embedding_dimension(),
        "maxSeqLength": model.max_seq_length,
        "device": DEVICE,
    }


@app.get("/info")
def info() -> dict:
    return info_of(model_or_503())


@app.post("/embed")
def embed(request: EmbedRequest) -> dict:
    model = model_or_503()
    if len(request.texts) > MAX_TEXTS:
        raise HTTPException(status_code=413, detail=f"At most {MAX_TEXTS} texts per request")
    if any(not text.strip() for text in request.texts):
        raise HTTPException(status_code=422, detail="Texts must not be empty")
    # One encode at a time: concurrent calls would only fight over the same CPU/GPU.
    with lock, torch.inference_mode():
        vectors = model.encode(
            request.texts,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    return {**info_of(model), "vectors": vectors.tolist()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("EMBEDDING_HOST", "127.0.0.1"),
        port=int(os.getenv("EMBEDDING_PORT", "8001")),
    )
