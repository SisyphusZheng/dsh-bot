"""Host Integration v2 client: envelope, receipt, epoch-retry and SSE contract."""
import asyncio
import json
import tempfile
import unittest
import uuid
from collections import deque

from aiohttp import web

import host_client_v2
from host_client_v2 import (
    HostClientV2,
    HostProtocolError,
    HostRejected,
    HostResyncRequired,
    HostUnavailable,
    PROTOCOL_VERSION,
    SSEParser,
    decode_event,
)
from testsupport import ISO_AT, write_descriptor

TOKEN = "fixture-token"


class LoopbackHost:
    """Real loopback HTTP double for the v2 protocol (no external network)."""

    def __init__(self):
        self.snapshot_seq = 41
        self.host_epochs = ["epoch-1", "epoch-2", "epoch-3"]
        self.handshake_calls = 0
        self.command_calls = 0
        self.command_bodies: list[dict] = []
        self.command_queue: deque = deque()
        self.stream_events: list[dict] = []
        self.stream_status = 200
        self.stream_body: dict = {}
        self.stream_after: list[int] = []
        self.auth_headers: list[str] = []
        self.unauthorized = False
        self.runner = None
        self.site = None
        self.descriptor_dir = tempfile.TemporaryDirectory()

    async def start(self) -> str:
        app = web.Application()
        app.router.add_get("/v2/snapshot", self._snapshot)
        app.router.add_post("/v2/command", self._command)
        app.router.add_get("/v2/stream", self._stream)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.runner.addresses[0][1]
        return write_descriptor(self.descriptor_dir.name, port, TOKEN)

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None
        self.descriptor_dir.cleanup()

    def _authorized(self, request) -> bool:
        header = request.headers.get("Authorization", "")
        self.auth_headers.append(header)
        return not self.unauthorized and header == f"Bearer {TOKEN}"

    def receipt(self, command_id, status="accepted", result=None, error=None):
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "commandId": command_id,
            "hostEpoch": self.host_epochs[0],
            "status": status,
            "result": result or {},
            "error": error,
            "at": ISO_AT,
        }

    async def _snapshot(self, request):
        self.handshake_calls += 1
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        index = min(self.handshake_calls - 1, len(self.host_epochs) - 1)
        return web.json_response({
            "protocolVersion": PROTOCOL_VERSION,
            "schema": "snapshot@1",
            "hostEpoch": self.host_epochs[index],
            "snapshotSeq": self.snapshot_seq,
            "generatedAt": ISO_AT,
            "identity": {"sessionId": "session-1"},
        })

    async def _command(self, request):
        self.command_calls += 1
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        body = await request.json()
        self.command_bodies.append(body)
        if self.command_queue:
            status, payload = self.command_queue.popleft()
            if isinstance(payload, dict) and payload.get("commandId") in (None, "__echo__"):
                payload = {**payload, "commandId": body.get("commandId")}
            return web.json_response(payload, status=status)
        return web.json_response(self.receipt(body.get("commandId")))

    async def _stream(self, request):
        self.stream_after.append(int(request.query.get("after", 0)))
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        if self.stream_status != 200:
            return web.json_response(self.stream_body, status=self.stream_status)
        response = web.StreamResponse(status=200, headers={"content-type": "text/event-stream"})
        await response.prepare(request)
        for event in self.stream_events:
            await response.write(("data: " + json.dumps(event) + "\n\n").encode())
        await response.write_eof()
        return response


def envelope(seq: int, *, epoch: str = "epoch-1", event_type: str = "command",
             data: dict | None = None) -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "eventId": f"event-{seq}",
        "hostEpoch": epoch,
        "seq": seq,
        "type": event_type,
        "source": "host",
        "at": ISO_AT,
        "data": data or {},
    }


class HostClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.host = LoopbackHost()
        self.descriptor = await self.host.start()
        self.client = HostClientV2(self.descriptor, connection_id="worker-unit-1")

    async def asyncTearDown(self):
        await self.client.close()
        await self.host.stop()

    async def test_handshake_adopts_host_epoch_and_session(self):
        snapshot = await self.client.handshake()
        self.assertEqual(self.client.host_epoch, "epoch-1")
        self.assertEqual(self.client.session_id, "session-1")
        self.assertEqual(self.client.snapshot_seq, 41)
        self.assertEqual(snapshot["schema"], "snapshot@1")
        self.assertEqual(self.host.auth_headers[-1], f"Bearer {TOKEN}")

    async def test_command_envelope_is_protocol_exact(self):
        await self.client.handshake()
        receipt = await self.client.send_command("voice.facts", {"connectionId": "worker-unit-1"})
        self.assertEqual(receipt["status"], "accepted")
        body = self.host.command_bodies[-1]
        self.assertEqual(body["protocolVersion"], PROTOCOL_VERSION)
        uuid.UUID(body["commandId"])  # real UUID, never fabricated upstream id
        self.assertEqual(body["hostEpoch"], "epoch-1")
        self.assertEqual(body["sourceConnectionId"], "worker-unit-1")
        self.assertEqual(body["sessionId"], "session-1")
        self.assertEqual(body["type"], "voice.facts")
        self.assertEqual(body["payload"], {"connectionId": "worker-unit-1"})
        self.assertNotIn("requestId", json.dumps(body))
        self.assertNotIn("turnId", json.dumps(body))
        self.assertEqual(self.host.auth_headers[-1], f"Bearer {TOKEN}")

    async def test_command_ids_are_unique_per_command(self):
        await self.client.handshake()
        await self.client.send_command("voice.session", {"connectionId": "c"})
        await self.client.send_command("voice.session", {"connectionId": "c"})
        first, second = self.host.command_bodies[-2:]
        self.assertNotEqual(first["commandId"], second["commandId"])

    async def test_stale_epoch_resyncs_snapshot_and_retries_once(self):
        await self.client.handshake()
        self.host.command_queue.append((
            409, {"error": {"code": "STALE_HOST_EPOCH", "message": "host restarted"}}))
        receipt = await self.client.send_command("voice.facts", {"items": []})
        self.assertEqual(receipt["status"], "accepted")
        self.assertEqual(self.client.host_epoch, "epoch-2")
        self.assertEqual(self.host.handshake_calls, 2)
        self.assertEqual(len(self.host.command_bodies), 2)
        self.assertEqual(self.host.command_bodies[0]["commandId"],
                         self.host.command_bodies[1]["commandId"])
        self.assertEqual(self.host.command_bodies[1]["hostEpoch"], "epoch-2")

    async def test_stale_epoch_twice_is_classified_not_looped(self):
        await self.client.handshake()
        self.host.command_queue.append((
            409, {"error": {"code": "STALE_HOST_EPOCH", "message": "old"}}))
        self.host.command_queue.append((
            409, {"error": {"code": "STALE_HOST_EPOCH", "message": "still old"}}))
        with self.assertRaises(HostUnavailable):
            await self.client.send_command("voice.facts", {"items": []})
        self.assertEqual(self.host.command_calls, 2)

    async def test_rejected_receipt_raises_and_is_not_success(self):
        await self.client.handshake()
        self.host.command_queue.append((200, self.host.receipt(
            "__echo__", status="rejected",
            error={"code": "IDEMPOTENCY_CONFLICT", "message": "conflict"})))
        # The receipt must echo the actual commandId, so patch it after the call.
        with self.assertRaises(HostRejected) as caught:
            await self.client.send_command("voice.facts", {"items": []})
        self.assertEqual(caught.exception.kind, "rejected")

    async def test_unknown_receipt_is_returned_without_retry(self):
        await self.client.handshake()
        self.host.command_queue.append((200, {
            "protocolVersion": PROTOCOL_VERSION,
            "commandId": "__echo__",
            "hostEpoch": "epoch-1",
            "status": "unknown",
            "result": {},
            "error": None,
            "at": ISO_AT,
        }))
        receipt = await self.client.send_command("voice.facts", {"items": []})
        self.assertEqual(receipt["status"], "unknown")
        self.assertEqual(len(self.host.command_bodies), 1)

    async def test_stream_replays_after_snapshot_seq_and_parses_events(self):
        await self.client.handshake()
        self.host.stream_events = [
            envelope(42, data={"commandId": "c1", "type": "notice.show", "payload": {}}),
            envelope(43, event_type="playback.changed", data={}),
        ]
        seen = []
        async for event in self.client.events(after=self.client.snapshot_seq):
            seen.append(event)
        self.assertEqual([event["seq"] for event in seen], [42, 43])
        self.assertEqual(self.host.stream_after, [41])
        self.assertEqual(self.host.auth_headers[-1], f"Bearer {TOKEN}")

    async def test_stream_resync_required_is_classified(self):
        await self.client.handshake()
        self.host.stream_status = 409
        self.host.stream_body = {"error": "resync-required", "snapshotSeq": 7}
        with self.assertRaises(HostResyncRequired) as caught:
            async for _event in self.client.events(after=0):
                pass
        self.assertEqual(caught.exception.snapshot_seq, 7)

    async def test_unauthorized_is_classified_as_auth_not_success(self):
        self.host.unauthorized = True
        with self.assertRaises(HostUnavailable) as caught:
            await self.client.handshake()
        self.assertEqual(caught.exception.kind, "auth")


class DescriptorTests(unittest.TestCase):
    def test_missing_or_invalid_descriptor_is_classified(self):
        client = HostClientV2("/nonexistent/bridge.json")
        with self.assertRaises(HostUnavailable) as caught:
            client.load_descriptor()
        self.assertEqual(caught.exception.kind, "descriptor")

        directory = tempfile.TemporaryDirectory()
        try:
            for payload in ({"port": "nope", "token": "t"}, {"port": 1}, {"token": "t"}):
                path = write_descriptor(directory.name, 1, "t")
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle)
                with self.assertRaises(HostUnavailable):
                    HostClientV2(path).load_descriptor()
        finally:
            directory.cleanup()


class SSEParserTests(unittest.TestCase):
    def test_split_chunks_comments_and_multiline_data(self):
        parser = SSEParser(expected_epoch="epoch-1")
        first = envelope(1)
        second = envelope(2)
        raw = (": connected\n\n"
               "data: " + json.dumps(first) + "\n\n"
               "data: " + json.dumps(second)[:20])
        events = parser.feed(raw.encode())
        self.assertEqual([event["seq"] for event in events], [1])
        events = parser.feed((json.dumps(second)[20:] + "\n\n").encode())
        self.assertEqual([event["seq"] for event in events], [2])

    def test_epoch_change_raises_resync_instead_of_applying_old_event(self):
        parser = SSEParser(expected_epoch="epoch-1")
        with self.assertRaises(HostResyncRequired):
            parser.feed(("data: " + json.dumps(envelope(3, epoch="epoch-2")) + "\n\n").encode())

    def test_invalid_payloads_are_protocol_errors(self):
        with self.assertRaises(HostProtocolError):
            decode_event("{not json")
        with self.assertRaises(HostProtocolError):
            decode_event(json.dumps({**envelope(1), "protocolVersion": "dsh-bot-v0"}))
        with self.assertRaises(HostProtocolError):
            decode_event(json.dumps({**envelope(1), "seq": 0}))
        with self.assertRaises(HostProtocolError):
            decode_event(json.dumps({**envelope(1), "hostEpoch": ""}))
        self.assertEqual(decode_event(json.dumps(envelope(5)))["seq"], 5)


if __name__ == "__main__":
    unittest.main()
