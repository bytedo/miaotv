"""An ephemeral loopback Redis protocol server with Lua execution via fakeredis.

Install test-only dependencies in a temporary directory with fakeredis[lua].
This emulator is intentionally separate from production Redis/Upstash settings.
"""
import json
import socketserver
import sys
import threading

from fakeredis import FakeRedis, FakeServer


database = FakeServer(version=(7, 4))


def encode(value):
    if value is None:
        return b"$-1\r\n"
    if value is True:
        return b"+OK\r\n"
    if isinstance(value, int):
        return b":" + str(value).encode() + b"\r\n"
    if isinstance(value, dict):
        value = [item for pair in value.items() for item in pair]
    if isinstance(value, (tuple, list)):
        return b"*" + str(len(value)).encode() + b"\r\n" + b"".join(encode(item) for item in value)
    if isinstance(value, str):
        value = value.encode()
    return b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n"


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        client = FakeRedis(server=database)
        while line := self.rfile.readline():
            assert line.startswith(b"*"), "Tests send RESP array commands only"
            command = []
            for _ in range(int(line[1:-2])):
                size = self.rfile.readline()
                assert size.startswith(b"$")
                command.append(self.rfile.read(int(size[1:-2])))
                assert self.rfile.read(2) == b"\r\n"
            try:
                result = encode(client.execute_command(*command))
            except Exception as error:
                result = b"-ERR " + str(error).replace("\r", " ").replace("\n", " ").encode() + b"\r\n"
            self.wfile.write(result)
            self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True


server = Server(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
print(json.dumps({"port": server.server_address[1]}), flush=True)
try:
    sys.stdin.read()
finally:
    server.shutdown()
    server.server_close()
