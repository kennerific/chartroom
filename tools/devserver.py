# -*- coding: utf-8 -*-
"""Static server for local development, with caching turned off.

python -m http.server is fine for a quick look, but browsers cache ES modules
hard, so an edit to assets/*.js can keep running the old code after a reload.
This sends no-store on everything.

    python tools/devserver.py [port]
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console readable; errors still surface through the browser.
        if not args or not str(args[0]).startswith("GET"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print("Chartroom dev server on http://localhost:%d  (no-store)" % port)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
