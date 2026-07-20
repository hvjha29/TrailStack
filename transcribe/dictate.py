#!/usr/bin/env python3
"""Hold F5 to dictate locally with faster-whisper; release to paste.

Uses the TrailStack transcribe venv. First run:

  cd transcribe
  source .venv/bin/activate
  python -m pip install -r requirements.txt
  python dictate.py

macOS permissions required:
  - Microphone (for recording)
  - Accessibility (for global F5 + Cmd+V paste)

Optional env:
  DICTATE_MODEL=small          # default; use large-v3 for max accuracy
  DICTATE_LANGUAGE=            # empty = auto-detect
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from pynput import keyboard

# Keep in sync with batch_transcribe.py so place names stay biased the same way.
INITIAL_PROMPT = (
    "Travel log narration mixing Hindi and English (Hinglish), with Icelandic "
    "and Danish place names such as Reykjavík, Fjaðrárgljúfur, Seyðisfjörður, "
    "Kirkjufell, Jökulsárlón, Copenhagen, Nyhavn. "
    "Icelandic place vocabulary often appears in names: "
    "foss waterfall; fljót, -á river; jökull glacier; sandur, fjara sand beach; "
    "fjörður, vík, vogur fjord cove bay; fjall, fell mountain; tindur peak; "
    "vellir, völlur, akur, tún grassy fields; hraun lava field; dalur valley; "
    "eyja, ey, hólmur island; skógur forest; heiði heath; mýri mire bog; "
    "laugar, laug, hver hot spring; lón lagoon; vatn lake; haf ocean; "
    "nes, höfði peninsula cape; skarð pass gap; hellir cave; "
    "gljúfur, gjá canyon; berg cliff; "
    "vegur road; bílastæði parking; braut, gata street; leið trail path; "
    "löggæslumyndavél speed camera; kirkja church; tjaldsvæði campsite; "
    "borg city; bær town; staðir place; húsið, húsa house; heim home; "
    "brú bridge; þjóðgarður national park; útsýni viewpoint; viti lighthouse; "
    "hlið gate; einka private; breið wide; djúp deep; fagur beautiful; "
    "opið open; lokað closed."
)

SAMPLE_RATE = 16_000
CHANNELS = 1
HOTKEY = keyboard.Key.f5
MIN_SECONDS = 0.35
MODEL_NAME = os.getenv("DICTATE_MODEL", "small")
LANGUAGE = os.getenv("DICTATE_LANGUAGE") or None

_lock = threading.Lock()
_recording = False
_frames: list[np.ndarray] = []
_stream: sd.InputStream | None = None
_busy = False
_model: WhisperModel | None = None


def log(message: str) -> None:
    print(message, flush=True)


def audio_callback(indata, _frames, _time, status) -> None:
    if status:
        log(f"Audio warning: {status}")
    with _lock:
        if _recording:
            _frames.append(indata.copy())


def start_recording() -> None:
    global _recording, _frames, _stream, _busy
    with _lock:
        if _recording or _busy:
            return
        _frames = []
        _recording = True
        if _stream is None:
            _stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="float32",
                callback=audio_callback,
            )
            _stream.start()
    log("● Recording… (release F5 to stop)")


def stop_recording_and_transcribe() -> None:
    global _recording, _busy
    with _lock:
        if not _recording:
            return
        _recording = False
        chunks = list(_frames)
        _frames.clear()
        _busy = True

    if not chunks:
        with _lock:
            _busy = False
        log("No audio captured.")
        return

    audio = np.concatenate(chunks, axis=0).reshape(-1)
    duration = audio.shape[0] / SAMPLE_RATE
    if duration < MIN_SECONDS:
        with _lock:
            _busy = False
        log(f"Too short ({duration:.2f}s). Hold F5 a bit longer.")
        return

    log(f"Transcribing {duration:.1f}s with {MODEL_NAME}…")
    threading.Thread(target=_transcribe_and_paste, args=(audio,), daemon=True).start()


def _write_wav(path: Path, audio: np.ndarray) -> None:
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())


def _transcribe_and_paste(audio: np.ndarray) -> None:
    global _busy, _model
    temporary_path: str | None = None
    try:
        if _model is None:
            raise RuntimeError("Whisper model is not loaded.")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temporary_path = handle.name
        _write_wav(Path(temporary_path), audio)

        segments, info = _model.transcribe(
            temporary_path,
            language=LANGUAGE,
            vad_filter=True,
            initial_prompt=INITIAL_PROMPT,
        )
        text = " ".join(
            segment.text.strip() for segment in segments if segment.text.strip()
        ).strip()
        if not text:
            log("Heard nothing useful.")
            return

        language = info.language or "?"
        log(f"→ [{language}] {text}")
        paste_text(text)
    except Exception as error:  # Keep the hotkey loop alive on failures.
        log(f"Dictate failed: {error}")
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
        with _lock:
            _busy = False


def paste_text(text: str) -> None:
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
    # Small delay so the focused app is ready after F5 release.
    time.sleep(0.08)
    script = 'tell application "System Events" to keystroke "v" using command down'
    completed = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip()
            or "Paste failed. Grant Accessibility to Terminal/iTerm in "
            "System Settings → Privacy & Security → Accessibility."
        )
    log("Pasted.")


def on_press(key) -> None:
    if key == HOTKEY:
        start_recording()


def on_release(key) -> None:
    if key == HOTKEY:
        stop_recording_and_transcribe()


def main() -> int:
    global _model

    log(f"Loading faster-whisper {MODEL_NAME} (cpu/int8)…")
    try:
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    except Exception as error:
        log(f"Could not load model: {error}")
        return 1

    log("Ready. Hold F5 to dictate, release to paste. Ctrl+C to quit.")
    log("Grant Microphone + Accessibility permissions if macOS prompts.")

    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        try:
            listener.join()
        except KeyboardInterrupt:
            log("Stopped.")
        finally:
            global _stream, _recording
            with _lock:
                _recording = False
            if _stream is not None:
                _stream.stop()
                _stream.close()
                _stream = None
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
