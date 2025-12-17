from __future__ import annotations

import json
import mimetypes
import os
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT_DIR = Path(__file__).resolve().parent
STATIC_DIR = ROOT_DIR / "static"
DATA_DIR = ROOT_DIR / "data"
DOC_PATH = DATA_DIR / "doc.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _write_json_atomic(path: Path, data: Any) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp_path, path)


def _ensure_seed_doc() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if DOC_PATH.exists():
        return

    seed = {
        "revision": 0,
        "updatedAt": _utc_now_iso(),
        "doc": {
            "tasks": [
                {
                    "id": "t1",
                    "title": "Example task 2025-12-16 3d",
                    "done": False,
                    "collapsed": False,
                    "parentId": None,
                    "order": 0,
                    "start": None,
                    "end": None,
                },
                {
                    "id": "t2",
                    "title": "Subtask 2025-12-18",
                    "done": False,
                    "collapsed": False,
                    "parentId": "t1",
                    "order": 0,
                    "start": None,
                    "end": None,
                },
            ]
        },
    }

    _write_json_atomic(DOC_PATH, seed)


@dataclass(frozen=True)
class ApiError(Exception):
    status: int
    message: str


class Handler(BaseHTTPRequestHandler):
    server_version = "LineCookHTTP/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep logs minimal and readable.
        super().log_message(format, *args)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body_json(self) -> Any:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            raise ApiError(400, "Missing request body")
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON")

    def _serve_static_file(self, relative_path: str) -> None:
        safe_path = Path(relative_path).as_posix().lstrip("/")
        full_path = (STATIC_DIR / safe_path).resolve()
        if not str(full_path).startswith(str(STATIC_DIR.resolve())):
            raise ApiError(400, "Invalid path")

        if full_path.is_dir():
            full_path = full_path / "index.html"

        if not full_path.exists() or not full_path.is_file():
            raise ApiError(404, "Not found")

        content_type, _ = mimetypes.guess_type(str(full_path))
        if not content_type:
            content_type = "application/octet-stream"

        data = full_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _handle_get_doc(self) -> None:
        _ensure_seed_doc()
        payload = _read_json(DOC_PATH)
        self._send_json(200, payload)

    def _handle_put_doc(self) -> None:
        _ensure_seed_doc()
        current = _read_json(DOC_PATH)

        body = self._read_body_json()
        base_revision = body.get("baseRevision")
        incoming_doc = body.get("doc")

        if not isinstance(base_revision, int):
            raise ApiError(400, "baseRevision must be an integer")
        if not isinstance(incoming_doc, dict):
            raise ApiError(400, "doc must be an object")

        current_rev = int(current.get("revision", 0))
        if base_revision != current_rev:
            self._send_json(409, {"error": "conflict", "current": current})
            return

        next_payload = {
            "revision": current_rev + 1,
            "updatedAt": _utc_now_iso(),
            "doc": incoming_doc,
        }
        _write_json_atomic(DOC_PATH, next_payload)
        self._send_json(200, next_payload)

    def _handle_get_inprogress(self) -> None:
        _ensure_seed_doc()
        payload = _read_json(DOC_PATH)
        tasks = payload.get("doc", {}).get("tasks", [])
        inprogress = [t for t in tasks if not t.get("done")]
        self._send_json(200, inprogress)

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)

            if path == "/api/health":
                self._send_json(200, {"ok": True})
                return

            if path == "/api/doc":
                self._handle_get_doc()
                return

            if path == "/api/tasks/inprogress":
                self._handle_get_inprogress()
                return

            if path == "/":
                self._serve_static_file("index.html")
                return

            if path.startswith("/static/"):
                self._serve_static_file(path[len("/static/") :])
                return

            # Allow direct /app.js etc for convenience.
            if path.startswith("/") and len(path) > 1 and "/" not in path[1:]:
                self._serve_static_file(path[1:])
                return

            raise ApiError(404, "Not found")
        except ApiError as e:
            if e.status >= 500:
                self._send_text(500, "Server error")
            else:
                self._send_json(e.status, {"error": e.message})
        except Exception:
            self._send_text(500, "Server error")

    def do_PUT(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)

            if path == "/api/doc":
                self._handle_put_doc()
                return

            raise ApiError(404, "Not found")
        except ApiError as e:
            if e.status >= 500:
                self._send_text(500, "Server error")
            else:
                self._send_json(e.status, {"error": e.message})
        except Exception:
            self._send_text(500, "Server error")


def main() -> None:
    _ensure_seed_doc()
    port = int(os.environ.get("PORT", "8000"))

    # Get hostname for display
    hostname = socket.gethostname()
    fqdn = socket.getfqdn()

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"LineCook running at:")
    print(f"  http://localhost:{port}")
    print(f"  http://{hostname}:{port}")
    print(f"  http://{fqdn}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
