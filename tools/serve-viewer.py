#!/usr/bin/env python
"""Local viewer server.

The viewer uses ES modules and fetches .glb files, so it needs a real HTTP
origin — opening viewer/index.html via file:// will fail.

Serves the repository root so both /viewer/ and /viewer/models/ resolve:

    /viewer/index.html        the viewer
    /viewer/models/*.glb      models, when downloaded for offline use

Usage:
    python tools/serve-viewer.py [port]
"""
import http.server
import socketserver
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webp": "image/webp",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args) or "500" in (fmt % args):
            sys.stderr.write("  ! " + (fmt % args) + "\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    model_dir = ROOT / "viewer" / "models"
    local = sorted(model_dir.glob("*.glb")) if model_dir.exists() else []
    total = sum(f.stat().st_size for f in local) / 1048576 if local else 0
    with Server(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT))) as httpd:
        print("\n  三角洲行动 3D 地图模型 · 查看器")
        print(f"  →  http://127.0.0.1:{PORT}/viewer/index.html")
        print(f"  仓库根目录: {ROOT}")
        if local:
            print(f"  本地模型: {len(local)} 个 / {total:.0f} MB（离线可用）")
        else:
            print("  本地模型: 无 —— 将从 GitHub Release 在线拉取")
            print("            离线使用请先跑: node tools/fetch-models.mjs")
        print("\n  Ctrl+C 停止\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  已停止")
