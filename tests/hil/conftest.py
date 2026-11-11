"""
Shared fixtures for the NexusCAN HIL test bench.

The virtual ECU (ecusim, C, iso14229 + kernel ISO-TP) runs as a separate process.
Everything here talks to it only through the CAN interface (kernel ISO-TP sockets) and its
JSON-lines event log; no NexusCAN product code is imported.

Environment overrides:
  ECUSIM_IFACE   CAN interface               (default vcan0)
  ECUSIM_BIN     ecusim binary               (default ecusim/build/ecusim; run.sh --asan
                                              points this at ecusim/build/asan/ecusim)
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Callable, Iterator, List, Optional

import isotp
import pytest
import udsoncan
from udsoncan.client import Client
from udsoncan.connections import IsoTPSocketConnection

HIL_DIR = Path(__file__).resolve().parent
ECUSIM_DIR = HIL_DIR / "ecusim"
DEFAULT_CFG = ECUSIM_DIR / "config" / "default.json"
IFACE = os.environ.get("ECUSIM_IFACE", "vcan0")
ECUSIM_BIN = Path(os.environ.get("ECUSIM_BIN", str(ECUSIM_DIR / "build" / "ecusim")))

# Addressing of the classic-CAN instance (session fixture) and the CAN-FD instance.
# ECUSIM_REQ / ECUSIM_RESP / ECUSIM_FUNC move the classic instance off 0x7E0/0x7E8/0x7DF when
# another ECU already answers there on the shared bus (e.g. a manually started ecusim). The
# golden capture maps the ids back to the canonical 0x7E0/0x7E8 before comparing.
REQ = int(os.environ.get("ECUSIM_REQ", "0x7E0"), 0)
RESP = int(os.environ.get("ECUSIM_RESP", "0x7E8"), 0)
FUNC = int(os.environ.get("ECUSIM_FUNC", "0x7DF"), 0)
CANON_REQ, CANON_RESP = 0x7E0, 0x7E8
FD_REQ, FD_RESP, FD_FUNC = 0x7E1, 0x7E9, 0x7DE

logging.getLogger("udsoncan").setLevel(logging.WARNING)
logging.getLogger("Connection").setLevel(logging.WARNING)


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: waits for session / lockout timers")


# --------------------------------------------------------------------------------------------
# ECU process + event log
# --------------------------------------------------------------------------------------------
class EcuLog:
    def __init__(self, path: Path):
        self.path = path

    def entries(self) -> List[dict]:
        if not self.path.exists():
            return []
        out = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def mark(self) -> int:
        return len(self.entries())

    def since(self, mark: int) -> List[dict]:
        return self.entries()[mark:]

    def wait_for(self, pred: Callable[[dict], bool], since: int = 0, timeout: float = 3.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for e in self.since(since):
                if pred(e):
                    return e
            time.sleep(0.01)
        raise AssertionError(f"ECU log: expected event not seen within {timeout}s "
                             f"(last entries: {self.since(since)[-8:]})")


class EcuProcess:
    def __init__(self, workdir: Path, name: str, cfg_src: Path = DEFAULT_CFG,
                 req: int = REQ, resp: int = RESP, func: int = FUNC, fd: bool = False):
        if not ECUSIM_BIN.exists():
            raise RuntimeError(f"{ECUSIM_BIN} missing - build with `make -C {ECUSIM_DIR}`")
        self.workdir = workdir
        self.cfg_path = workdir / f"{name}.json"
        shutil.copyfile(cfg_src, self.cfg_path)
        self.log = EcuLog(workdir / f"{name}.events.jsonl")
        self.stderr_path = workdir / f"{name}.stderr.txt"
        self.req, self.resp, self.func, self.fd = req, resp, func, fd
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> "EcuProcess":
        args = [str(ECUSIM_BIN), "-i", IFACE, "-c", str(self.cfg_path),
                "--req", hex(self.req), "--resp", hex(self.resp), "--func", hex(self.func),
                "-l", str(self.log.path)]
        if self.fd:
            args.append("--fd")
        env = dict(os.environ)
        env.setdefault("ASAN_OPTIONS", "detect_leaks=1:halt_on_error=1:abort_on_error=0")
        env.setdefault("UBSAN_OPTIONS", "halt_on_error=1:print_stacktrace=1")
        self._stderr = self.stderr_path.open("w")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=self._stderr, env=env)
        self.log.wait_for(lambda e: e.get("ev") == "ready", timeout=5.0)
        return self

    def signal_and_wait(self, sig: int, ev: str, timeout: float = 3.0) -> dict:
        m = self.log.mark()
        assert self.proc is not None and self.proc.poll() is None, "ecusim is not running"
        self.proc.send_signal(sig)
        return self.log.wait_for(lambda e: e.get("ev") == ev, since=m, timeout=timeout)

    def reset_state(self) -> None:
        self.signal_and_wait(signal.SIGUSR1, "state_reset")

    def reload(self) -> dict:
        return self.signal_and_wait(signal.SIGHUP, "reloaded")

    def stop(self) -> tuple[int, str]:
        assert self.proc is not None
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self._stderr.close()
        return self.proc.returncode, self.stderr_path.read_text()


def assert_clean_exit(rc: int, stderr: str) -> None:
    bad = [m for m in ("AddressSanitizer", "LeakSanitizer", "runtime error:", "UndefinedBehavior")
           if m in stderr]
    assert rc == 0 and not bad, f"ecusim exit rc={rc}, sanitizer findings={bad}\n{stderr}"


@pytest.fixture(scope="session")
def ecu_proc(tmp_path_factory) -> Iterator[EcuProcess]:
    wd = tmp_path_factory.mktemp("ecusim")
    p = EcuProcess(wd, "classic").start()
    yield p
    rc, err = p.stop()
    assert_clean_exit(rc, err)


@pytest.fixture
def ecu(ecu_proc: EcuProcess) -> EcuProcess:
    """Session ECU, reset to the configured initial state before every test."""
    ecu_proc.reset_state()
    return ecu_proc


@pytest.fixture
def ecu_fd(tmp_path) -> Iterator[EcuProcess]:
    p = EcuProcess(tmp_path, "fd", req=FD_REQ, resp=FD_RESP, func=FD_FUNC, fd=True).start()
    yield p
    rc, err = p.stop()
    assert_clean_exit(rc, err)


# --------------------------------------------------------------------------------------------
# udsoncan client
# --------------------------------------------------------------------------------------------
class Raw(udsoncan.DidCodec):
    """Fixed-length opaque byte codec."""

    def __init__(self, n: int):
        self.n = n

    def encode(self, v) -> bytes:  # type: ignore[override]
        v = bytes(v)
        if len(v) != self.n:
            raise ValueError(f"expected {self.n} bytes, got {len(v)}")
        return v

    def decode(self, payload: bytes) -> bytes:  # type: ignore[override]
        return bytes(payload)

    def __len__(self) -> int:
        return self.n


DID_CODECS = {
    0xF186: Raw(1),
    0xF187: udsoncan.AsciiCodec(15),
    0xF188: udsoncan.AsciiCodec(7),
    0xF189: udsoncan.AsciiCodec(8),
    0xF18A: udsoncan.AsciiCodec(13),
    0xF18B: Raw(3),
    0xF18C: udsoncan.AsciiCodec(12),
    0xF190: udsoncan.AsciiCodec(17),
    0xF191: udsoncan.AsciiCodec(7),
    0xF192: udsoncan.AsciiCodec(9),
    0xF193: udsoncan.AsciiCodec(2),
    0xF194: udsoncan.AsciiCodec(9),
    0xF195: udsoncan.AsciiCodec(2),
    0xF1A0: Raw(4),
    0x0100: Raw(1),
    0x0101: Raw(4),
    0x0102: Raw(2),
    0xF1F0: Raw(62),
    0xF1F1: Raw(200),
    0xFA01: Raw(1),
    0xFA02: Raw(2),
    0xFA03: Raw(1),
    0xFA04: Raw(1),
    # snapshot record DIDs (0x19 0x04)
    0x1001: Raw(2),
    0x1002: Raw(1),
}


def client_config(**over) -> dict:
    cfg = dict(udsoncan.configs.default_client_config)
    cfg.update({
        "exception_on_negative_response": True,
        "exception_on_invalid_response": True,
        "exception_on_unexpected_response": True,
        "use_server_timing": False,
        "request_timeout": 6.0,
        "p2_timeout": 1.0,
        "p2_star_timeout": 3.0,
        "standard_version": 2020,
        "data_identifiers": DID_CODECS,
        "input_output": {0x0100: Raw(1)},
        "dtc_snapshot_did_size": 2,
        "server_address_format": 32,
        "server_memorysize_format": 32,
    })
    cfg.update(over)
    return cfg


def make_client(txid: int = REQ, rxid: int = RESP, fd: bool = False, **cfg_over) -> Client:
    tpsock = isotp.socket(timeout=0.1)
    if fd:
        tpsock.set_ll_opts(mtu=isotp.socket.LinkLayerProtocol.CAN_FD, tx_dl=64)
    addr = isotp.Address(isotp.AddressingMode.Normal_11bits, txid=txid, rxid=rxid)
    conn = IsoTPSocketConnection(IFACE, addr, tpsock=tpsock)
    return Client(conn, config=client_config(**cfg_over))


@pytest.fixture
def client(ecu: EcuProcess) -> Iterator[Client]:
    c = make_client()
    with c:
        yield c


# --------------------------------------------------------------------------------------------
# raw ISO-TP helper (kernel socket, independent of udsoncan)
# --------------------------------------------------------------------------------------------
class RawTp:
    def __init__(self, txid: int = REQ, rxid: int = RESP, fd: bool = False):
        self.s = isotp.socket()
        if fd:
            self.s.set_ll_opts(mtu=isotp.socket.LinkLayerProtocol.CAN_FD, tx_dl=64)
        self.s.bind(IFACE, isotp.Address(isotp.AddressingMode.Normal_11bits, txid=txid, rxid=rxid))

    def send(self, payload: bytes) -> float:
        t = time.monotonic()
        self.s.send(bytes(payload))
        return t

    def recv(self, timeout: float = 1.0) -> Optional[bytes]:
        self.s.settimeout(timeout)
        try:
            return self.s.recv()
        except (socket.timeout, TimeoutError):
            return None

    def request(self, payload: bytes, timeout: float = 1.0) -> Optional[bytes]:
        self.send(payload)
        return self.recv(timeout)

    def close(self) -> None:
        self.s.close()

    def __enter__(self) -> "RawTp":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class ConnTp:
    """Raw requests through the udsoncan client's own ISO-TP socket.

    Every kernel ISO-TP socket bound to rx id 0x7E8 receives a copy of each ECU response, so a
    second receiving socket next to the udsoncan client would inject stale responses into the
    client's queue. All raw traffic of a test therefore shares the client's connection;
    functional requests leave through a send-only socket (tx 0x7DF, rx bound to unused 0x5FF).
    """

    def __init__(self, conn, functional: bool = False):
        self.conn = conn
        self.functional = functional
        self.func = isotp.socket()
        self.func.bind(IFACE, isotp.Address(isotp.AddressingMode.Normal_11bits, txid=FUNC, rxid=0x5FF))

    def send(self, payload: bytes, functional: Optional[bool] = None) -> float:
        self.conn.empty_rxqueue()
        t = time.monotonic()
        if self.functional if functional is None else functional:
            self.func.send(bytes(payload))
        else:
            self.conn.send(bytes(payload))
        return t

    def recv(self, timeout: float = 1.0) -> Optional[bytes]:
        return self.conn.wait_frame(timeout=timeout, exception=False)

    def request(self, payload: bytes, timeout: float = 1.0,
                functional: Optional[bool] = None) -> Optional[bytes]:
        self.send(payload, functional)
        return self.recv(timeout)

    def close(self) -> None:
        self.func.close()


@pytest.fixture
def raw(client: Client) -> Iterator[ConnTp]:
    r = ConnTp(client.conn)
    yield r
    r.close()


@pytest.fixture
def raw_func(client: Client) -> Iterator[ConnTp]:
    """Functional requests on 0x7DF; responses read on the physical response id."""
    r = ConnTp(client.conn, functional=True)
    yield r
    r.close()


# --------------------------------------------------------------------------------------------
# neutral bus observer
# --------------------------------------------------------------------------------------------
class Candump:
    """candump -L restricted to an id/mask filter (independent observer process)."""

    def __init__(self, path: Path, filt: str = "7E0:7F0"):
        self.path = path
        self.filt = filt
        self.proc: Optional[subprocess.Popen] = None

    def __enter__(self) -> "Candump":
        self._f = self.path.open("w")
        self.proc = subprocess.Popen(["candump", "-L", f"{IFACE},{self.filt}"], stdout=self._f,
                                     stderr=subprocess.DEVNULL)
        time.sleep(0.3)  # let candump bind before traffic starts
        return self

    def __exit__(self, *exc) -> None:
        time.sleep(0.2)
        assert self.proc is not None
        self.proc.send_signal(signal.SIGINT)
        self.proc.wait(timeout=5)
        self._f.close()

    def frames(self) -> List[str]:
        """'ID#DATA' / 'ID##FDATA' tokens in capture order."""
        out = []
        for line in self.path.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                out.append(parts[2])
        return out


class IsoTpDump:
    """isotpdump -u (UDS-annotated, no timestamps) for one request/response id pair."""

    def __init__(self, path: Path, src: int = REQ, dst: int = RESP):
        self.path, self.src, self.dst = path, src, dst
        self.proc: Optional[subprocess.Popen] = None

    def __enter__(self) -> "IsoTpDump":
        self._f = self.path.open("w")
        self.proc = subprocess.Popen(["isotpdump", "-s", f"{self.src:X}", "-d", f"{self.dst:X}",
                                      "-u", "-a", IFACE], stdout=self._f, stderr=subprocess.DEVNULL)
        time.sleep(0.3)
        return self

    def __exit__(self, *exc) -> None:
        time.sleep(0.2)
        assert self.proc is not None
        self.proc.send_signal(signal.SIGINT)
        self.proc.wait(timeout=5)
        self._f.close()

    def lines(self) -> List[str]:
        return [ln.rstrip() for ln in self.path.read_text().splitlines() if ln.strip()]
