"""Per-WebRTC capture identity; muting finishes input, discarding never cancels DSH."""
from collections import deque


class CapturePolicy:
    def __init__(self, required=False):
        self.required = required
        self.current = ""
        self.enabled = not required
        self.revoked = set()
        self.commits = deque()
        self.items = {}
        self.audio_capture = ""
        self.dirty = False

    def control(self, action, capture_id):
        if action not in ("start", "finish", "discard") or not isinstance(capture_id, str) or not 0 < len(capture_id) <= 100:
            return False
        if action == "start":
            if capture_id in self.revoked:
                return False
            self.current = capture_id
            self.enabled = True
        else:
            if action == "discard":
                self.revoked.add(capture_id)
            if capture_id == self.current:
                self.enabled = False
        return True

    def append(self):
        if not self.enabled:
            return False
        self.audio_capture = self.current
        self.dirty = True
        return True

    def commit(self):
        if not self.dirty:
            return False
        self.commits.append(self.audio_capture)
        self.dirty = False
        return True

    def transcript(self, item_id, final=False):
        if not self.required:
            return "legacy"
        capture = self.items.get(item_id) if item_id else None
        if capture is None:
            capture = self.commits[0] if self.commits else self.audio_capture
            if item_id:
                self.items[item_id] = capture
        if final:
            if self.commits:
                self.commits.popleft()
            # Bound metadata; provider item ids must never outlive this transport.
            if len(self.items) > 256:
                self.items = dict(list(self.items.items())[-128:])
        return capture if capture and capture not in self.revoked else None
