"""PyInstaller entry point for the Pipecat voice worker (packaged product mode)."""
import os
import uvicorn
from server import app

if __name__ == "__main__":
    port = int(os.environ.get("NISSE_VOICE_WORKER_PORT", os.environ.get("PORT", "8765")))
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
    server = uvicorn.Server(config)
    server.run()
