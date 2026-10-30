"""Shared fakes for the voice-worker unit tests (not shipped in the worker app)."""
from __future__ import annotations

import asyncio
import json
import tempfile
from collections import deque
from pathlib import Path
from unittest.mock import AsyncMock, patch

from dsh_bridge import VoiceMediaBridge
from host_client_v2 import PROTOCOL_VERSION
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

ISO_AT = "2026-10-30T14:00:00.000Z"


class FakeHost:
    """In-memory Host Integration v2 double: records commands, returns receipts."""

    def __init__(self, *, host_epoch: str = "epoch-1", session_id: str = "sess-1",
                 connection_id: str = "worker-test-1"):
        self.host_epoch = host_epoch
        self.session_id = session_id
        self.connection_id = connection_id
        self.commands: list[dict] = []
        self.receipts: deque = deque()
        self.default_status = "accepted"
        self.fail_with: BaseException | None = None
        self.handshake_count = 0
        self.closed = False

    async def handshake(self) -> dict:
        self.handshake_count += 1
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "schema": "snapshot@1",
            "hostEpoch": self.host_epoch,
            "snapshotSeq": 0,
            "identity": {"sessionId": self.session_id},
        }

    async def send_command(self, command_type: str, payload: dict | None = None, *,
                           command_id: str | None = None, session_id: str | None = None,
                           timeout: float | None = None) -> dict:
        self.commands.append({
            "type": command_type,
            "payload": payload or {},
            "command_id": command_id,
            "session_id": session_id,
        })
        if self.fail_with is not None:
            raise self.fail_with
        if self.receipts:
            return self.receipts.popleft()
        return self.receipt(command_id, self.default_status)

    def receipt(self, command_id: str | None, status: str = "accepted",
                result: dict | None = None, error: dict | None = None) -> dict:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "commandId": command_id,
            "hostEpoch": self.host_epoch,
            "status": status,
            "result": result or {},
            "error": error,
            "at": ISO_AT,
        }

    async def close(self) -> None:
        self.closed = True

    # -- inspection helpers --
    def typed(self, command_type: str) -> list[dict]:
        return [command for command in self.commands if command["type"] == command_type]

    def payloads(self, command_type: str) -> list[dict]:
        return [command["payload"] for command in self.typed(command_type)]

    def command_types(self) -> set[str]:
        return {command["type"] for command in self.commands}


def make_bridge(capture=None, host: FakeHost | None = None) -> tuple[VoiceMediaBridge, FakeHost]:
    fake = host or FakeHost()
    bridge = VoiceMediaBridge("/unused", capture=capture, host=fake)
    bridge.push_frame = AsyncMock()
    bridge.broadcast_interruption = AsyncMock()
    return bridge, fake


def frame(text: str, *, final: bool = True, capture_id: str = "cap-1",
          utterance_id: str = "utt-1", provider_item_id: str | None = "item-1",
          mode: str = "toggle", confidence=None) -> object:
    cls = TranscriptionFrame if final else InterimTranscriptionFrame
    value = cls(text, "test-user", "now")
    metadata = {"capture_id": capture_id, "utterance_id": utterance_id, "input_mode": mode}
    if provider_item_id is not None:
        metadata["provider_item_id"] = provider_item_id
    if confidence is not None:
        metadata["confidence"] = confidence
    metadata.update(value.metadata or {})
    value.metadata.update(metadata)
    return value


async def feed(bridge: VoiceMediaBridge, frame_value) -> None:
    with patch.object(FrameProcessor, "process_frame", new=AsyncMock()):
        await bridge.process_frame(frame_value, FrameDirection.DOWNSTREAM)


async def host_command(bridge: VoiceMediaBridge, seq: int, command_type: str,
                       payload: dict, *, command_id: str | None = None,
                       epoch: str | None = None) -> None:
    await bridge._handle_host_event({
        "protocolVersion": PROTOCOL_VERSION,
        "eventId": f"evt-{seq}",
        "hostEpoch": epoch or bridge._host_epoch,
        "seq": seq,
        "type": "command",
        "data": {
            "commandId": command_id or f"host-cmd-{seq}",
            "type": command_type,
            "payload": payload,
        },
    })


def pushed(bridge: VoiceMediaBridge, cls) -> list:
    return [call.args[0] for call in bridge.push_frame.call_args_list
            if isinstance(call.args[0], cls)]


def rtvi(bridge: VoiceMediaBridge, message_type: str) -> list[dict]:
    out = []
    for call in bridge.push_frame.call_args_list:
        value = call.args[0]
        data = getattr(value, "message", None)
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            if data["data"].get("type") == message_type:
                out.append(data["data"])
    return out


async def teardown_bridge(bridge: VoiceMediaBridge) -> None:
    timer = bridge._barge_timeout_task
    bridge._cancel_barge_timeout()
    if timer is not None:
        await asyncio.gather(timer, return_exceptions=True)
    await asyncio.sleep(0)
    await bridge._host.close()


def write_descriptor(directory: str, port: int, token: str = "fixture-token") -> str:
    path = Path(directory) / "bridge.json"
    path.write_text(json.dumps({"port": port, "token": token}), encoding="utf-8")
    return str(path)


def temp_descriptor(**payload) -> tuple[tempfile.TemporaryDirectory, str]:
    directory = tempfile.TemporaryDirectory()
    path = Path(directory.name) / "bridge.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return directory, str(path)
