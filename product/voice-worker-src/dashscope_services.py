"""DashScope (Qwen) realtime ASR/TTS adapters for Pipecat.

Frozen protocol facts (verified 2026-10-23 against the live API):
- Base URL: wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<model>
- Auth: Authorization: Bearer $DASHSCOPE_API_KEY
- ASR model: qwen3-asr-flash-realtime
    * manual turn mode: session.update with turn_detection=None
    * client events: input_audio_buffer.append {audio: base64 pcm s16le mono 16k},
      input_audio_buffer.commit, session.finish
    * server events: session.updated,
      conversation.item.input_audio_transcription.text   (partial: text + stash),
      conversation.item.input_audio_transcription.completed {transcript}
- TTS model: qwen3-tts-flash-realtime
    * session.update {voice, response_format: 'pcm', sample_rate: 24000}
      (Qwen3-TTS supports 24000 only; default voice Cherry)
    * client events: input_text_buffer.append {text}, input_text_buffer.commit,
      session.finish
    * server events: session.updated, response.audio.delta {delta: base64 pcm},
      response.audio.done, response.done
Both protocols are separate: no shared session/event state machine.

The adapters subclass Pipecat's WebsocketSTTService / WebsocketTTSService so
frames, lifecycle, cancellation and error reporting stay in Pipecat's hands.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import uuid
from collections.abc import AsyncGenerator

from loguru import logger

from capture_policy import CapturePolicy
from voice_errors import VoiceProviderError, report as report_voice_error
from websockets.protocol import State

from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    EndFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.services.stt_service import WebsocketSTTService
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.tts_service import WebsocketTTSService
from pipecat.utils.time import time_now_iso8601
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter


class SpeechTextFilter(MarkdownTextFilter):
    """Markdown filter plus TTS-safe whitespace.

    Pipecat's Markdown filter removes markup but leaves newlines from
    headings/lists, which makes Qwen TTS pause in the middle of a sentence.
    Keep one space between words and turn line breaks into a spoken comma.
    """

    async def filter(self, text: str) -> str:
        spoken = await super().filter(text)
        spoken = re.sub(r"[ \t]*\n+[ \t]*", "，", spoken)
        spoken = re.sub(r"[ \t]{2,}", " ", spoken)
        return spoken

_TTS_EDGE_PUNCT = "，、。！？!?：:；;…—–-·・ "
_TTS_INLINE_MARKDOWN = (
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
)


def tts_safe_text(text: str) -> str:
    """Return text the speech provider can actually synthesize, or ``""``.

    Streaming sentence splitting can hand the TTS one punctuation-only fragment
    (a Markdown image turns into "!") or a fragment that merely starts with a
    comma. The provider answers those with a ``response.done`` carrying no audio,
    which used to leave a silent hole in the reply. Strip remaining inline markup
    and leading/trailing punctuation; return "" when nothing speakable remains.
    """
    spoken = str(text or "")
    for pattern, replacement in _TTS_INLINE_MARKDOWN:
        spoken = pattern.sub(replacement, spoken)
    spoken = re.sub(r"[`*>#]+", "", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip()
    # Provider returns audio for sentences that start like a sentence; a leading comma
    # (streaming split artifact) or markdown residue is what produced empty replies.
    spoken = spoken.lstrip(_TTS_EDGE_PUNCT)
    spoken = spoken.rstrip("，、, ")
    spoken = re.sub(r"\s+", " ", spoken).strip()
    if not re.search(r"[0-9A-Za-z\u4e00-\u9fff]", spoken):
        return ""
    return spoken


def probe_log(message):
    if os.environ.get("DSH_VOICE_DEBUG_PROBES") == "1":
        logger.info(message)


DASHSCOPE_REALTIME_URL = os.getenv("DASHSCOPE_REALTIME_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime")


def _event_id() -> str:
    return "event_" + uuid.uuid4().hex


def _now_ms() -> float:
    return time.monotonic() * 1000.0


class DashScopeASRService(WebsocketSTTService):
    """Qwen3-ASR-Realtime in manual turn mode; Pipecat owns VAD/turn boundaries."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "qwen3-asr-flash-realtime",
        url: str = DASHSCOPE_REALTIME_URL,
        sample_rate: int = 16000,
        language: str = "zh",
        **kwargs,
    ):
        super().__init__(
            sample_rate=sample_rate,
            settings=STTSettings(model=model, language=None),
            **kwargs,
        )
        self.capture = CapturePolicy(os.environ.get("DSH_CAPTURE_CONTROL") == "1")
        self._utterance_seq = 0
        self._receive_task = None
        self._api_key = api_key
        self._model = model
        self._url = url
        self._language = language
        self._commit_at_ms: float | None = None
        self._debug_transcripts = os.environ.get("SPIKE_DEBUG_TRANSCRIPTS") == "1"
        self._test_dropped_socket = False
        # Cleanup/cancel can run before the websocket handshake completes; the
        # disconnect path clears this event, so it must exist from construction.
        self._socket_ready = asyncio.Event()
        self.metrics: dict = {"partial": 0, "final": 0, "errors": 0, "first_partial_ms": None, "final_ms": None, "final_ms_samples": []}

    async def setup(self, setup):
        await super().setup(setup)
        await self._connect()

    async def _connect(self):
        await super()._connect()
        await self._connect_websocket()
        if self._websocket and not self._receive_task:
            self._receive_task = self.create_task(self._receive_task_handler(self._report_error))

    async def _disconnect(self):
        await super()._disconnect()
        if self._receive_task:
            await self.cancel_task(self._receive_task)
            self._receive_task = None
        await self._disconnect_websocket()

    async def _connect_websocket(self):
        if os.environ.get("WG_TEST_ASR_FAIL_HANDSHAKE") == "1":
            raise RuntimeError("TEST injected ASR handshake failure")
        try:
            await self._connect_websocket_locked()
        except Exception as exc:
            payload = await report_voice_error(exc, source="asr")
            raise VoiceProviderError(payload, cause=exc) from exc

    async def _connect_websocket_locked(self):
        uri = f"{self._url}?model={self._model}"
        self._websocket = await self._websocket_connect(
            uri,
            additional_headers={"Authorization": f"Bearer {self._api_key}"},
            max_size=20 * 1024 * 1024,
            open_timeout=15,
            # Provider voice is a direct connection by product decision: websockets
            # >=16 otherwise auto-adopts the macOS system proxy and fails on SOCKS.
            proxy=None,
        )
        first = json.loads(await self._websocket.recv())
        if first.get("type") != "session.created":
            raise RuntimeError(f"ASR unexpected first event: {first.get('type')}")
        await self._websocket.send(json.dumps({
            "event_id": _event_id(),
            "type": "session.update",
            "session": {
                "input_audio_format": "pcm",
                "sample_rate": 16000,
                "input_audio_transcription": {"language": self._language},
                "turn_detection": None,
            },
        }))
        while True:
            msg = json.loads(await self._websocket.recv())
            if msg.get("type") == "session.updated":
                return
            if msg.get("type") == "error":
                raise RuntimeError(f"ASR session.update failed: {msg.get('error')}")

    async def _disconnect_websocket(self):
        self._socket_ready.clear()
        ws = self._websocket
        self._websocket = None
        if ws is None:
            return
        try:
            if ws.state is State.OPEN:
                await ws.send(json.dumps({"event_id": _event_id(), "type": "session.finish"}))
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass

    async def _handle_provider_error(self, ws, error) -> None:
        """Provider error/timeout must not leave run_tts blocked forever.
        Unblock the waiter, close the socket, and return to the base receive loop,
        which reconnects with backoff. A later TTS request then uses the new socket.
        """
        self.metrics["errors"] += 1
        self._socket_ready.clear()
        logger.warning(f"[dashscope-tts] provider error -> reconnect: {error}")
        self._response_done.set()
        self._reply = None
        try:
            await ws.close()
        except Exception:
            pass
        self._websocket = None

    async def _receive_messages(self):
        while True:
            ws = self._websocket
            if ws is None:
                return
            try:
                raw = await ws.recv()
            except Exception:
                return
            msg = json.loads(raw)
            event = msg.get("type")
            if event == "conversation.item.input_audio_transcription.text":
                partial = (msg.get("text") or "") + (msg.get("stash") or "")
                capture_id = self.capture.transcript(msg.get("item_id"))
                if partial and capture_id:
                    if self.metrics["first_partial_ms"] is None and self._commit_at_ms is not None:
                        self.metrics["first_partial_ms"] = round(_now_ms() - self._commit_at_ms, 1)
                    self.metrics["partial"] += 1
                    if self._debug_transcripts:
                        self.metrics["last_partial"] = partial
                        if self.metrics["partial"] % 10 == 1:
                            logger.info(f"[dashscope-asr] partial: {partial}")
                    frame = InterimTranscriptionFrame(partial, self._user_id, time_now_iso8601())
                    frame.metadata["capture_id"] = capture_id
                    frame.metadata["input_mode"] = self.capture.modes.get(capture_id, 'always') if self.capture.required else 'hold'
                    frame.metadata["utterance_id"] = msg.get("item_id") or f"{capture_id}:{self._utterance_seq}"
                    frame.metadata["provider_item_id"] = msg.get("item_id")
                    # Confidence is a nullable provider field: pass through only
                    # when the provider actually supplied a number.
                    confidence = msg.get("confidence")
                    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
                        frame.metadata["confidence"] = float(confidence)
                    await self.push_frame(frame)
            elif event == "conversation.item.input_audio_transcription.completed":
                self.confirm_finalize()
                transcript = msg.get("transcript") or ""
                capture_id = self.capture.transcript(msg.get("item_id"), final=True)
                utterance_id = msg.get("item_id") or f"{capture_id}:{self._utterance_seq}"
                self._utterance_seq += 1
                if self._commit_at_ms is not None:
                    self.metrics["final_ms"] = round(_now_ms() - self._commit_at_ms, 1)
                    self.metrics["final_ms_samples"].append(self.metrics["final_ms"])
                    self.metrics["final_ms_samples"] = self.metrics["final_ms_samples"][-200:]
                    self._commit_at_ms = None
                if transcript and os.environ.get("WG_TEST_ASR_SUPPRESS_FINAL") == "1":
                    logger.warning("[dashscope-asr] TEST injected suppression of final transcript")
                    continue
                if transcript and capture_id:
                    self.metrics["final"] += 1
                    if self._debug_transcripts:
                        self.metrics.setdefault("transcripts", []).append(transcript)
                        logger.info(f"[dashscope-asr] final: {transcript}")
                    frame = TranscriptionFrame(transcript, self._user_id, time_now_iso8601())
                    frame.metadata["capture_id"] = capture_id
                    frame.metadata["input_mode"] = self.capture.modes.get(capture_id, 'always') if self.capture.required else 'hold'
                    frame.metadata["utterance_id"] = utterance_id
                    frame.metadata["provider_item_id"] = msg.get("item_id")
                    confidence = msg.get("confidence")
                    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
                        frame.metadata["confidence"] = float(confidence)
                    await self.push_frame(frame)
            elif event == "error":
                self.metrics["errors"] += 1
                await self.push_error_frame(ErrorFrame(error=f"DashScope ASR error: {msg.get('error')}"))
            elif event == "session.finished":
                return

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        if not self.capture.append():
            yield None
            return
        ws = self._websocket
        if ws is None or ws.state is not State.OPEN:
            yield ErrorFrame(error="DashScope ASR websocket is not connected")
            return
        try:
            await ws.send(json.dumps({
                "event_id": _event_id(),
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(audio).decode(),
            }))
            if os.environ.get("WG_TEST_ASR_DROP_DURING") == "1" and not self._test_dropped_socket:
                self._test_dropped_socket = True
                self.metrics["errors"] += 1
                logger.warning("[dashscope-asr] TEST injected drop during recognition")
                try: await ws.close()
                except Exception: pass
        except Exception as exc:
            self.metrics["errors"] += 1
            yield ErrorFrame(error=f"DashScope ASR send failed: {exc}")
            return
        yield None

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStoppedSpeakingFrame) and self.capture.commit():
            self.request_finalize()
            self._commit_at_ms = _now_ms()
            ws = self._websocket
            if ws is not None and ws.state is State.OPEN:
                try:
                    await ws.send(json.dumps({"event_id": _event_id(), "type": "input_audio_buffer.commit"}))
                except Exception as exc:
                    self.metrics["errors"] += 1
                    logger.warning(f"DashScope ASR commit failed: {exc}")


class DashScopeTTSService(WebsocketTTSService):
    """Qwen3-TTS-Realtime streaming PCM (24 kHz mono)."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "qwen3-tts-flash-realtime",
        url: str = DASHSCOPE_REALTIME_URL,
        voice: str = "Cherry",
        sample_rate: int = 24000,
        **kwargs,
    ):
        super().__init__(
            sample_rate=sample_rate,
            settings=TTSSettings(model=model, voice=voice, language=None),
            text_filters=kwargs.pop("text_filters", [SpeechTextFilter()]),
            **kwargs,
        )
        self._receive_task = None
        self._api_key = api_key
        self._model = model
        self._url = url
        self._voice = voice
        self._context_id: str | None = None
        self._sent_at_ms: float | None = None
        self._reply: dict | None = None
        self._reply_index = 0
        self._debug_transcripts = os.environ.get("SPIKE_DEBUG_TRANSCRIPTS") == "1"
        self._test_dropped_socket = False
        self._capture_path = os.environ.get("G1_CAPTURE_WAV", "")
        self._capture_pcm = bytearray()
        self._test_dropped_once = False
        self._response_done = asyncio.Event()
        self._response_done.set()
        self._socket_ready = asyncio.Event()
        self._test_provider_error_once = False
        self.metrics: dict = {
            "responses": 0,
            "chunks": 0, "audio_bytes": 0, "errors": 0,
            "first_chunk_ms": None, "done_ms": None,
            "last_first_chunk_ms": None, "last_done_ms": None,
            "replies": [],
        }

    async def setup(self, setup):
        await super().setup(setup)
        self._output_sample_rate = self.sample_rate
        await self._connect()

    async def _connect(self):
        await super()._connect()
        await self._connect_websocket()
        if self._websocket and not self._receive_task:
            self._receive_task = self.create_task(self._receive_task_handler(self._report_error))

    async def _disconnect(self):
        await super()._disconnect()
        if self._receive_task:
            await self.cancel_task(self._receive_task)
            self._receive_task = None
        await self._disconnect_websocket()

    async def _connect_websocket(self):
        if os.environ.get("WG_TEST_TTS_FAIL_HANDSHAKE") == "1":
            raise RuntimeError("TEST injected TTS handshake failure")
        try:
            await self._connect_websocket_locked()
        except Exception as exc:
            payload = await report_voice_error(exc, source="tts")
            raise VoiceProviderError(payload, cause=exc) from exc

    async def _connect_websocket_locked(self):
        uri = f"{self._url}?model={self._model}"
        self._websocket = await self._websocket_connect(
            uri,
            additional_headers={"Authorization": f"Bearer {self._api_key}"},
            max_size=20 * 1024 * 1024,
            open_timeout=15,
            # Same direct-connection policy as ASR; see above.
            proxy=None,
        )
        first = json.loads(await self._websocket.recv())
        logger.info(f"[dashscope-tts] connected: {first.get('type')}")
        if first.get("type") != "session.created":
            raise RuntimeError(f"TTS unexpected first event: {first.get('type')}")
        await self._websocket.send(json.dumps({
            "event_id": _event_id(),
            "type": "session.update",
            "session": {
                "voice": self._voice,
                "response_format": "pcm",
                "sample_rate": 24000,
            },
        }))
        while True:
            msg = json.loads(await self._websocket.recv())
            if msg.get("type") == "session.updated":
                session = msg.get("session") or {}
                logger.info(f"[dashscope-tts] session updated voice={session.get('voice')} rate={session.get('sample_rate')}")
                if session.get("sample_rate") != 24000:
                    logger.warning(f"DashScope TTS sample_rate={session.get('sample_rate')} (expected 24000)")
                self._socket_ready.set()
                return
            if msg.get("type") == "error":
                raise RuntimeError(f"TTS session.update failed: {msg.get('error')}")

    async def _disconnect_websocket(self):
        self._socket_ready.clear()
        ws = self._websocket
        self._websocket = None
        if ws is None:
            return
        try:
            if ws.state is State.OPEN:
                await ws.send(json.dumps({"event_id": _event_id(), "type": "session.finish"}))
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass

    async def _handle_provider_error(self, ws, error) -> None:
        """Provider error/timeout must not leave run_tts blocked forever.
        Unblock the waiter, close the socket, and return to the base receive loop,
        which reconnects with backoff. A later TTS request then uses the new socket.
        """
        self.metrics["errors"] += 1
        self._socket_ready.clear()
        logger.warning(f"[dashscope-tts] provider error -> reconnect: {error}")
        self._response_done.set()
        self._reply = None
        try:
            await ws.close()
        except Exception:
            pass
        self._websocket = None

    async def _receive_messages(self):
        while True:
            ws = self._websocket
            if ws is None:
                return
            try:
                raw = await ws.recv()
            except Exception:
                return
            msg = json.loads(raw)
            event = msg.get("type")
            context_id = self._context_id
            if event == "response.audio.delta":
                if os.environ.get("WG_TEST_TTS_PROVIDER_ERROR_ONCE") == "1" and not self._test_provider_error_once:
                    self._test_provider_error_once = True
                    await self._handle_provider_error(ws, {"code": "TEST", "message": "injected provider error"})
                    return
                if context_id is None:
                    continue
                audio = base64.b64decode(msg.get("delta") or "")
                drop_after_forward = (os.environ.get("WG_TEST_TTS_DROP_AFTER_FORWARD") == "1" or (os.environ.get("WG_TEST_TTS_DROP_ONCE") == "1" and not self._test_dropped_once)) and self.metrics["chunks"] == 0
                if os.environ.get("WG_TEST_TTS_DROP_AFTER_FIRST_CHUNK") == "1" and self.metrics["chunks"] == 0:
                    self.metrics["errors"] += 1
                    logger.warning("[dashscope-tts] TEST injected drop after first chunk")
                    try: await ws.close()
                    except Exception: pass
                    return
                if self._reply is not None:
                    if self._reply["first_chunk_ms"] is None and self._reply["start_ms"] is not None:
                        self._reply["first_chunk_ms"] = round(_now_ms() - self._reply["start_ms"], 1)
                        probe_log(f"[g3-probe] tts_first_chunk reply#{self._reply.get('index')} epoch_ms={round(time.time()*1000)} mono={time.monotonic():.3f}")
                    self._reply["chunks"] += 1
                    self._reply["audio_bytes"] += len(audio)
                self.metrics["first_chunk_ms"] = self.metrics["first_chunk_ms"] or (self._reply or {}).get("first_chunk_ms")
                self.metrics["chunks"] += 1
                self.metrics["audio_bytes"] += len(audio)
                if self._capture_path:
                    self._capture_pcm.extend(audio)
                await self.append_to_audio_context(
                    context_id,
                    TTSAudioRawFrame(
                        audio=audio,
                        sample_rate=24000,
                        num_channels=1,
                        context_id=context_id,
                    ),
                )
                if drop_after_forward:
                    self._test_dropped_once = True
                    self.metrics["errors"] += 1
                    logger.warning("[dashscope-tts] TEST injected drop after forwarding first chunk")
                    try: await ws.close()
                    except Exception: pass
                    # Product rule (MVP): a fatal TTS failure ends the voice pipeline;
                    # the supervisor rebuilds it. Agent state stays owned by DSH.
                    await self.push_error_frame(ErrorFrame(error="TTS pipeline failure: rebuild required"))
                    await self.push_frame(EndFrame())
                    return
            elif event in ("response.audio.done", "response.done"):
                if self._reply is not None and self._reply.get("done_ms") is None:
                    self._reply["done_ms"] = round(_now_ms() - self._reply["start_ms"], 1)
                    self._reply["audio_seconds"] = round(self._reply["audio_bytes"] / (24000 * 2), 3)
                    self.metrics["last_first_chunk_ms"] = self._reply["first_chunk_ms"]
                    self.metrics["last_done_ms"] = self._reply["done_ms"]
                    self.metrics["responses"] += 1
                    reply = dict(self._reply)
                    if not self._debug_transcripts:
                        reply["chars"] = len(reply.pop("text", ""))
                    self.metrics["replies"].append(reply)
                    print(
                        f"[dashscope-tts] reply#{self._reply_index} "
                        + (f"text={self._reply['text']!r} " if self._debug_transcripts else f"chars={len(self._reply['text'])} ")
                        + f"chunks={self._reply['chunks']} bytes={self._reply['audio_bytes']} "
                        f"audio_s={self._reply['audio_seconds']} first_chunk_ms={self._reply['first_chunk_ms']} done_ms={self._reply['done_ms']}",
                        flush=True,
                    )
                    if self._capture_path and len(self.metrics["replies"]) == 1:
                        import wave
                        with wave.open(self._capture_path, "wb") as w:
                            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
                            w.writeframes(bytes(self._capture_pcm))
                        print(f"[dashscope-tts] captured first reply to {self._capture_path}", flush=True)
                    self._reply = None
                    self._response_done.set()
                if self._sent_at_ms is not None and self.metrics["done_ms"] is None:
                    self.metrics["done_ms"] = round(_now_ms() - self._sent_at_ms, 1)
                # Keep the Pipecat audio context open across multiple text chunks of the
                # same logical reply; closing it per DashScope response caused
                # recreate/no-audio races. The context is finished by the TTS pipeline
                # when the LLM response end is processed.
                self._sent_at_ms = None
            elif event == "error":
                await self._handle_provider_error(ws, msg.get("error"))
                return

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        text = tts_safe_text(text)
        if not text:
            logger.debug("[dashscope-tts] skipping punctuation-only fragment")
            return
        try:
            await asyncio.wait_for(self._socket_ready.wait(), timeout=10)
        except asyncio.TimeoutError:
            yield ErrorFrame(error="DashScope TTS reconnect timeout")
            return
        ws = self._websocket
        if ws is None or ws.state is not State.OPEN:
            yield ErrorFrame(error="DashScope TTS websocket is not connected")
            return
        # Serialize synthesis responses so audio chunks are attributed to the
        # correct context and played in sentence order (DSH streaming may enqueue
        # several sentence texts quickly).
        await self._response_done.wait()
        self._response_done.clear()
        self._context_id = context_id
        self._sent_at_ms = _now_ms()
        self._reply_index += 1
        self._reply = {
            "index": self._reply_index,
            "text": text,
            "chunks": 0,
            "audio_bytes": 0,
            "first_chunk_ms": None,
            "start_ms": _now_ms(),
            "done_ms": None,
            "audio_seconds": None,
        }
        logger.info(f"[dashscope-tts] run_tts reply#{self._reply_index} chars={len(text)} context={context_id}")
        try:
            await self.start_tts_usage_metrics(text)
            await self.send_with_retry(json.dumps({
                "event_id": _event_id(),
                "type": "input_text_buffer.append",
                "text": text,
            }), self._report_error)
            await self.send_with_retry(
                json.dumps({"event_id": _event_id(), "type": "input_text_buffer.commit"}),
                self._report_error,
            )
            if self._websocket is None or self._websocket.state is not State.OPEN:
                self.metrics["errors"] += 1
                yield ErrorFrame(error="DashScope TTS send failed after reconnect")
                return
        except Exception as exc:
            self.metrics["errors"] += 1
            yield ErrorFrame(error=f"DashScope TTS send failed: {exc}")
            return
        yield None
