#!/usr/bin/env python3
"""Sequentially transcribe pending TrailStack audio with faster-whisper."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from faster_whisper import WhisperModel
from supabase import Client, create_client


BUCKET = "trail-audio"
MODEL_NAME = "large-v3"
INITIAL_PROMPT = (
    "Travel log narration mixing Hindi and English (Hinglish), with Icelandic "
    "and Danish place names such as Reykjavik, Fjadrargljufur, Seydisfjordur, "
    "Kirkjufell, Jokulsarlon, Copenhagen, Nyhavn."
)


def load_client() -> Client:
    load_dotenv(Path(__file__).with_name(".env"))
    url = os.getenv("SUPABASE_URL")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not service_key:
        raise RuntimeError(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in transcribe/.env"
        )

    return create_client(url, service_key)


def pending_entries(client: Client) -> list[dict]:
    response = (
        client.table("entries")
        .select("client_id,ts,title,audio_path")
        .eq("transcript_status", "pending")
        .order("ts")
        .execute()
    )
    return response.data or []


def mark_failed(client: Client, client_id: str) -> None:
    try:
        (
            client.table("entries")
            .update({"transcript_status": "failed"})
            .eq("client_id", client_id)
            .execute()
        )
    except Exception as update_error:  # Continue even if status reporting fails.
        print(f"  Could not mark {client_id} failed: {update_error}", file=sys.stderr)


def transcribe_entry(
    client: Client,
    model: WhisperModel,
    entry: dict,
) -> str:
    audio_path = entry.get("audio_path")
    if not audio_path:
        raise ValueError("entry has no audio_path")

    audio_bytes = client.storage.from_(BUCKET).download(audio_path)
    suffix = Path(audio_path).suffix or ".audio"
    temporary_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as audio_file:
            audio_file.write(audio_bytes)
            temporary_path = audio_file.name

        segments, info = model.transcribe(
            temporary_path,
            language=None,
            vad_filter=True,
            initial_prompt=INITIAL_PROMPT,
        )
        transcript = " ".join(
            segment.text.strip() for segment in segments if segment.text.strip()
        ).strip()
        if not transcript:
            raise RuntimeError("transcription returned no text")

        language = info.language or "unknown"
        probability = getattr(info, "language_probability", 0.0)
        print(f"  Detected language: {language} ({probability:.0%})")
        return transcript
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


def main() -> int:
    try:
        client = load_client()
        entries = pending_entries(client)
    except Exception as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1

    if not entries:
        print("No pending TrailStack recordings.")
        return 0

    print(f"Loading faster-whisper {MODEL_NAME} on CPU (int8)…")
    try:
        model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    except Exception as error:
        print(f"Could not load model: {error}", file=sys.stderr)
        return 1

    print(f"Found {len(entries)} pending recording(s). Processing sequentially.")
    completed = 0
    failed = 0

    for position, entry in enumerate(entries, start=1):
        client_id = entry["client_id"]
        label = entry.get("title") or client_id
        print(f"[{position}/{len(entries)}] {label}")

        try:
            transcript = transcribe_entry(client, model, entry)
            (
                client.table("entries")
                .update(
                    {
                        "transcript": transcript,
                        "transcript_status": "done",
                    }
                )
                .eq("client_id", client_id)
                .execute()
            )
            completed += 1
            print(f"  Done ({len(transcript)} characters).")
        except Exception as error:
            failed += 1
            print(f"  Failed: {error}", file=sys.stderr)
            mark_failed(client, client_id)

    print(f"Finished: {completed} done, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
