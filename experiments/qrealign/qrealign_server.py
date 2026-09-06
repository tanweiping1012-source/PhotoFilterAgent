#!/usr/bin/env python3
"""Local-only JSONL scoring server for the frozen Q-ReAlign experiment."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import platform
import sys
from pathlib import Path
from typing import Any

import PIL
import torch
import transformers
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor


LEVELS = ["excellent", "good", "fair", "poor", "bad"]
WEIGHTS = [1.0, 0.75, 0.5, 0.25, 0.0]
TASKS = {
    "aesthetics": (
        "How would you rate the aesthetics of this image?",
        "The aesthetics of the image is",
    ),
    "quality": (
        "How would you rate the quality of this image?",
        "The quality of the image is",
    ),
}
PROTOCOL_VERSION = "qrealign-jsonl-v1"


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--task", choices=sorted(TASKS), default="aesthetics")
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    parser.add_argument("--dtype", choices=["auto", "float32"], default="auto")
    parser.add_argument("--preflight-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model_dir = Path(args.model_dir).resolve(strict=True)
    if not model_dir.is_dir():
        raise ValueError("model-dir must be a local directory")
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS was requested but is unavailable; no device fallback was used")
    if args.preflight_only:
        emit({"type": "preflight", "device": args.device, "available": True})
        return 0

    torch.set_grad_enabled(False)
    torch.use_deterministic_algorithms(True)
    prompt, stem = TASKS[args.task]
    prompt_hash = hashlib.sha256(f"{prompt}\0{stem}".encode()).hexdigest()
    processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
    dtype: str | torch.dtype = "auto" if args.dtype == "auto" else torch.float32
    model = AutoModelForImageTextToText.from_pretrained(
        model_dir,
        dtype=dtype,
        local_files_only=True,
    ).to(args.device).eval()
    messages = [{
        "role": "user",
        "content": [
            {"type": "image"},
            {"type": "text", "text": prompt},
        ],
    }]
    text = processor.apply_chat_template(messages, add_generation_prompt=True) + stem
    level_ids = [
        processor.tokenizer(" " + word, add_special_tokens=False).input_ids[0]
        for word in LEVELS
    ]
    weights = torch.tensor(WEIGHTS, device=args.device)
    identity = {
        "protocol": PROTOCOL_VERSION,
        "model_revision": args.model_revision,
        "task": args.task,
        "prompt_hash": prompt_hash,
        "device": args.device,
        "dtype": args.dtype,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "pillow": PIL.__version__,
    }
    emit({"type": "ready", "identity": identity})

    for line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(line)
            photo_id = request["id"]
            encoded = request["jpeg_base64"]
            if not isinstance(photo_id, str) or not photo_id:
                raise ValueError("id must be a non-empty string")
            if not isinstance(encoded, str) or not encoded:
                raise ValueError("jpeg_base64 must be a non-empty string")
            image = Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))).convert("RGB")
            inputs = processor(text=[text], images=[image], return_tensors="pt").to(args.device)
            with torch.inference_mode():
                logits = model(**inputs).logits[0, -1, level_ids]
                probabilities = logits.float().softmax(-1)
                score = float((probabilities * weights).sum().item())
            emit({
                "type": "score",
                "id": photo_id,
                "score": round(score, 8),
                "level_probabilities": [round(float(value), 8) for value in probabilities],
            })
        except Exception as error:  # Fail one anonymous item without leaking pixels or paths.
            emit({
                "type": "error",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": type(error).__name__,
                "message": str(error)[:240],
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
