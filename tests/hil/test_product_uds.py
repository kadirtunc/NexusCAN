"""
D-003 product tests: the NexusCAN UDS client as a BLACK BOX.

Driven exclusively through the `nexus_bridge` HTTP API (`POST /api/invoke/cmd_diag_*`, the same
command names / argument shapes as `DiagCommandMap` in src/types/udsClient.ts), against an
independent virtual ECU (ecusim, iso14229 + kernel ISO-TP) on vcan0. No product code is imported.

Isolation from other users of the shared vcan0 (contract D-003 section 5):
  * own bridge instance per test on NEXUS_TEST_BRIDGE_ADDR (default 127.0.0.1:14298),
  * own ECU ids: classic 0x7E6/0x7EE (functional 0x7DC), CAN-FD 0x7E7/0x7EF (functional 0x7DA),
  * every process started here is stopped in fixture teardown (only our own PIDs).

Two-sided verification: product output (DTOs, error codes, conversation log) is cross-checked
with what the ECU logged (`rx`/`tx` events) and with a neutral `candump` observer.

Env: NEXUS_BRIDGE_BIN (default <repo>/target/release/nexus_bridge), NEXUS_TEST_BRIDGE_ADDR.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest

from conftest import HIL_DIR, IFACE, Candump, EcuProcess, assert_clean_exit

REPO = HIL_DIR.parent.parent
CONFIGS = HIL_DIR / "configs"
PRODUCT_CFG = CONFIGS / "product_classic.json"
SLOW_FC_CFG = CONFIGS / "product_slow_fc.json"
BRIDGE_BIN = Path(os.environ.get("NEXUS_BRIDGE_BIN", str(REPO / "target" / "release" / "nexus_bridge")))
BRIDGE_ADDR = os.environ.get("NEXUS_TEST_BRIDGE_ADDR", "127.0.0.1:14298")

P_REQ, P_RESP, P_FUNC = 0x7E6, 0x7EE, 0x7DC
FD_REQ, FD_RESP, FD_FUNC = 0x7E7, 0x7EF, 0x7DA

VIN = "WNX0ECUSIM0000017"
SEED_L1 = [0x11, 0x22, 0x33, 0x44]
KEY_L1 = [0xB4, 0x87, 0x96, 0xE1]          # seed ^ A5A5A5A5 (ecusim xor_const)
BAD_KEY = [0x00, 0x00, 0x00, 0x00]
ECU_P2_MS, ECU_P2_STAR_MS = 50, 2000       # configs/product_classic.json timing

DIAG_ERR_RE = re.compile(r"^\[diag:([a-z_0-9]+)\]\s*(.*)$", re.S)


def cfg(**over) -> Dict[str, Any]:
    c = {"busId": 0, "requestId": P_REQ, "responseId": P_RESP, "isExtendedId": False,
         "protocol": "uds", "functionalId": P_FUNC}
    c.update(over)
    return c


FD_CFG = cfg(requestId=FD_REQ, responseId=FD_RESP, functionalId=FD_FUNC, useFd=True)


# --------------------------------------------------------------------------------------------
# bridge process + HTTP client
# --------------------------------------------------------------------------------------------
class DiagFailure(Exception):
    def __init__(self, code: str, message: str, raw: str):
        super().__init__(raw)
        self.code, self.message, self.raw = code, message, raw


class Bridge:
    def __init__(self, workdir: Path):
        self.base = f"http://{BRIDGE_ADDR}"
        self.log_path = workdir / "nexus_bridge.log"
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> "Bridge":
        if not BRIDGE_BIN.exists():
            raise RuntimeError(f"{BRIDGE_BIN} missing - cargo build --release -p nexus-hal --bin nexus_bridge")
        if self._health(0.2):
            raise RuntimeError(f"{BRIDGE_ADDR} is already served by another process; refusing to share it")
        env = dict(os.environ, NEXUS_BRIDGE_ADDR=BRIDGE_ADDR)
        self._log = self.log_path.open("w")
        self.proc = subprocess.Popen([str(BRIDGE_BIN)], stdout=self._log, stderr=subprocess.STDOUT,
                                     env=env, cwd=str(REPO))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"nexus_bridge exited rc={self.proc.returncode}: {self.log_path.read_text()}")
            if self._health(0.3):
                return self
            time.sleep(0.05)
        raise RuntimeError("nexus_bridge did not become healthy within 15 s")

    def _health(self, timeout: float) -> bool:
        try:
            with urllib.request.urlopen(f"{self.base}/api/health", timeout=timeout) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError):
            return False

    def stop(self) -> None:
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)  # graceful shutdown hook of nexus_bridge
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self._log.close()

    # ---- raw invoke ------------------------------------------------------------------------
    def invoke(self, cmd: str, args: Optional[dict] = None, timeout: float = 30.0) -> Tuple[int, Any]:
        body = json.dumps(args if args is not None else {}).encode()
        req = urllib.request.Request(f"{self.base}/api/invoke/{cmd}", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def ok(self, cmd: str, args: Optional[dict] = None, timeout: float = 30.0) -> Any:
        st, v = self.invoke(cmd, args, timeout)
        if st != 200:
            raw = v.get("error") if isinstance(v, dict) else str(v)
            m = DIAG_ERR_RE.match(raw or "")
            if m:
                raise DiagFailure(m.group(1), m.group(2), raw)
            raise AssertionError(f"{cmd} -> HTTP {st}: {v}")
        return v

    def diag_err(self, cmd: str, args: dict, timeout: float = 30.0) -> DiagFailure:
        """Expects a 400 with the `[diag:<code>] msg` wire format."""
        st, v = self.invoke(cmd, args, timeout)
        assert st == 400, f"{cmd}: expected HTTP 400 diag error, got {st}: {v}"
        raw = v["error"]
        m = DIAG_ERR_RE.match(raw)
        assert m, f"{cmd}: error is not in '[diag:<code>] msg' format: {raw!r}"
        return DiagFailure(m.group(1), m.group(2), raw)

    # ---- bus helpers -----------------------------------------------------------------------
    def connect(self, listen_only: bool = False, arm: bool = True) -> None:
        self.ok("cmd_connect_bus", {"deviceId": f"socketcan:{IFACE}", "config": {
            "busId": 0, "bitrate": 500000, "dataBitrate": 2000000, "enableFd": True,
            "listenOnly": listen_only}})
        if arm:
            self.ok("cmd_arm_active_bus", {"busId": 0, "armed": True})

    # ---- diag helpers ----------------------------------------------------------------------
    def uds(self, c: dict, sid: int, sub: Optional[int] = None, data: Optional[List[int]] = None,
            options: Optional[dict] = None) -> dict:
        args = {"config": c, "sid": sid, "subFunction": sub, "data": data or []}
        if options is not None:
            args["options"] = options
        return self.ok("cmd_diag_send_uds", args)

    def info(self, c: dict) -> dict:
        return self.ok("cmd_diag_session_info", {"config": c})

    def conversation(self, c: dict, since: int = 0, max_: Optional[int] = None) -> dict:
        args: dict = {"config": c, "sinceSeq": since}
        if max_ is not None:
            args["max"] = max_
        return self.ok("cmd_diag_get_conversation", args)

    def all_events(self, c: dict) -> List[dict]:
        out, since = [], 0
        while True:
            p = self.conversation(c, since, 500)
            out.extend(p["events"])
            if not p["events"]:
                return out
            since = p["lastSeq"]


@pytest.fixture
def bridge(tmp_path) -> Iterator[Bridge]:
    b = Bridge(tmp_path).start()
    try:
        yield b
    finally:
        b.stop()


def _start_ecu(tmp_path: Path, name: str, cfg_src: Path, req: int, resp: int, func: int,
               fd: bool = False) -> EcuProcess:
    return EcuProcess(tmp_path, name, cfg_src=cfg_src, req=req, resp=resp, func=func, fd=fd).start()


@pytest.fixture
def pecu(tmp_path) -> Iterator[EcuProcess]:
    """Product-test ECU, classic CAN, 0x7E6/0x7EE/0x7DC, configs/product_classic.json."""
    e = _start_ecu(tmp_path, "pecu", PRODUCT_CFG, P_REQ, P_RESP, P_FUNC)
    yield e
    assert_clean_exit(*e.stop())


@pytest.fixture
def pecu_slow_fc(tmp_path) -> Iterator[EcuProcess]:
    e = _start_ecu(tmp_path, "pecu_slowfc", SLOW_FC_CFG, P_REQ, P_RESP, P_FUNC)
    yield e
    assert_clean_exit(*e.stop())


@pytest.fixture
def pecu_fd(tmp_path) -> Iterator[EcuProcess]:
    e = _start_ecu(tmp_path, "pecu_fd", PRODUCT_CFG, FD_REQ, FD_RESP, FD_FUNC, fd=True)
    yield e
    assert_clean_exit(*e.stop())


@pytest.fixture
def armed(bridge: Bridge, pecu: EcuProcess) -> Bridge:
    bridge.connect()
    return bridge


def ecu_rx(ecu: EcuProcess, since: int = 0) -> List[dict]:
    return [e for e in ecu.log.since(since) if e.get("ev") == "rx"]


def ecu_tx(ecu: EcuProcess, since: int = 0) -> List[dict]:
    return [e for e in ecu.log.since(since) if e.get("ev") == "tx"]


def candump_lines(cap: Candump) -> List[Tuple[float, str, str]]:
    """(timestamp, id, data-with-flags) from `candump -L` lines."""
    out = []
    for ln in cap.path.read_text().splitlines():
        p = ln.split()
        if len(p) >= 3:
            cid, _, data = p[2].partition("#")
            out.append((float(p[0].strip("()")), cid.upper(), data.upper()))
    return out


def hexs(b: List[int]) -> str:
    return bytes(b).hex().upper()


# ============================================================================================
# 1. Gate: bus_not_connected / listen_only / disarmed / panic_latched + automatic reopen
# ============================================================================================
def test_gate_bus_not_connected(bridge, pecu):
    m = pecu.log.mark()
    e = bridge.diag_err("cmd_diag_open_session", {"config": cfg()})
    assert e.code == "bus_not_connected", e.raw
    e = bridge.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x10, "subFunction": 0x01, "data": []})
    assert e.code == "bus_not_connected", e.raw
    e = bridge.diag_err("cmd_diag_read_did", {"config": cfg(), "did": 0xF190})
    assert e.code == "bus_not_connected", e.raw
    info = bridge.info(cfg())
    assert info["open"] is False
    time.sleep(0.2)
    assert ecu_rx(pecu, m) == []


def test_gate_listen_only(bridge, pecu, tmp_path):
    bridge.connect(listen_only=True, arm=False)
    m = pecu.log.mark()
    with Candump(tmp_path / "lo.candump", filt=f"{P_REQ:X}:7FF,{P_FUNC:X}:7FF") as cap:
        e = bridge.diag_err("cmd_diag_open_session", {"config": cfg()})
        assert e.code == "listen_only", e.raw
        e = bridge.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x3E, "subFunction": 0x00, "data": []})
        assert e.code == "listen_only", e.raw
        e = bridge.diag_err("cmd_diag_read_stored_dtcs", {"config": cfg()})
        assert e.code == "listen_only", e.raw
        # Arming a Listen-Only channel is refused by the HAL (not a diag command).
        st, _ = bridge.invoke("cmd_arm_active_bus", {"busId": 0, "armed": True})
        assert st == 400
        e = bridge.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x3E, "subFunction": 0x00, "data": []})
        assert e.code == "listen_only", e.raw
    assert candump_lines(cap) == [], "Listen-Only bus must not emit any tester frame"
    assert ecu_rx(pecu, m) == []


def test_gate_disarmed_and_disarm_closes_session(bridge, pecu, tmp_path):
    bridge.connect(arm=False)
    e = bridge.diag_err("cmd_diag_open_session", {"config": cfg()})
    assert e.code == "disarmed", e.raw
    e = bridge.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x10, "subFunction": 0x01, "data": []})
    assert e.code == "disarmed", e.raw

    bridge.ok("cmd_arm_active_bus", {"busId": 0, "armed": True})
    info = bridge.ok("cmd_diag_open_session", {"config": cfg()})
    assert info["open"] is True
    assert bridge.uds(cfg(), 0x10, 0x03)["positive"] is True

    bridge.ok("cmd_arm_active_bus", {"busId": 0, "armed": False})
    assert bridge.info(cfg())["open"] is False, "disarm must close the diag session"
    m = pecu.log.mark()
    with Candump(tmp_path / "dis.candump", filt=f"{P_REQ:X}:7FF") as cap:
        e = bridge.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x3E, "subFunction": 0x00, "data": []})
        assert e.code == "disarmed", e.raw
    assert candump_lines(cap) == []
    assert ecu_rx(pecu, m) == []


def test_gate_panic_latched_then_rearm_reopens(armed, pecu, tmp_path):
    b = armed
    assert b.uds(cfg(), 0x10, 0x03)["positive"] is True
    assert b.info(cfg())["open"] is True

    with Candump(tmp_path / "panic.candump", filt=f"{P_REQ:X}:7FF,{P_FUNC:X}:7FF") as cap:
        b.ok("cmd_panic_stop_tx", {})
        t_latched = time.time()
        info = b.info(cfg())
        assert info["open"] is False, "Panic Stop must close the diag session"
        assert info["testerPresentEnabled"] is False
        time.sleep(0.2)                       # pump thread notices the closed tap (50 ms poll)
        # the log of the invalidated session stays readable and records the close
        before = b.all_events(cfg())
        assert "session_closed" in [ev["kind"] for ev in before], before
        m = pecu.log.mark()
        for cmd, args in (
            ("cmd_diag_send_uds", {"config": cfg(), "sid": 0x22, "subFunction": None, "data": [0xF1, 0x90]}),
            ("cmd_diag_read_did", {"config": cfg(), "did": 0xF190}),
            ("cmd_diag_open_session", {"config": cfg()}),
            ("cmd_diag_set_tester_present", {"config": cfg(), "enabled": True}),
        ):
            e = b.diag_err(cmd, args)
            assert e.code == "panic_latched", f"{cmd}: {e.raw}"
        # diag_session.rs module doc: read-only commands keep working on an invalidated session
        # "so the HMI can still inspect the log after a Panic Stop" - also after a refused retry.
        after = b.all_events(cfg())
        assert after == before, (f"conversation log lost after gated commands were refused: "
                                 f"{len(before)} events before, {len(after)} after")
        assert b.info(cfg())["lastSeq"] == before[-1]["seq"]
    late = [f for f in candump_lines(cap) if f[0] >= t_latched]
    assert late == [], f"frames on the bus after Panic Stop latched: {late}"
    assert ecu_rx(pecu, m) == []

    # re-arm clears the latch; the next command reopens the session automatically
    b.ok("cmd_arm_active_bus", {"busId": 0, "armed": True})
    r = b.uds(cfg(), 0x10, 0x01)
    assert r["positive"] is True and r["raw"][:2] == [0x50, 0x01]
    info = b.info(cfg())
    assert info["open"] is True and info["activeSession"] == 1
    pecu.log.wait_for(lambda e: e.get("ev") == "rx" and e.get("data") == "1001", since=m)


# ============================================================================================
# 2. Session control + ECU-reported P2 / P2*
# ============================================================================================
def test_session_control_and_timing(armed, pecu):
    b = armed
    info = b.ok("cmd_diag_open_session", {"config": cfg()})
    assert info["open"] is True and info["activeSession"] == 1
    assert info["p2ServerMs"] is None and info["p2StarServerMs"] is None

    r = b.uds(cfg(), 0x10, 0x03)
    assert r["positive"] and r["raw"] == [0x50, 0x03, 0x00, 0x32, 0x00, 0xC8]
    info = b.info(cfg())
    assert info["activeSession"] == 3
    assert info["p2ServerMs"] == ECU_P2_MS and info["p2StarServerMs"] == ECU_P2_STAR_MS

    r = b.uds(cfg(), 0x10, 0x02)      # programming only from extended (config "from": [2, 3])
    assert r["positive"] and r["raw"][:2] == [0x50, 0x02]
    assert b.info(cfg())["activeSession"] == 2

    r = b.uds(cfg(), 0x10, 0x01)
    assert r["positive"] and r["raw"][:2] == [0x50, 0x01]
    assert b.info(cfg())["activeSession"] == 1

    r = b.uds(cfg(), 0x10, 0x02)      # default -> programming is not allowed -> 0x22
    assert r["positive"] is False and r["nrc"] == 0x22 and r["raw"] == [0x7F, 0x10, 0x22]
    assert r["nrcName"]
    assert b.info(cfg())["activeSession"] == 1, "a negative 0x10 must not change activeSession"

    sess = [(e["from"], e["to"]) for e in pecu.log.entries() if e.get("ev") == "session"]
    assert sess == [(1, 3), (3, 2), (2, 1)], sess


# ============================================================================================
# 3. SecurityAccess: unlock, 0x35, 0x36, 0x37
# ============================================================================================
def test_security_unlock_level1(armed, pecu):
    b = armed
    assert b.uds(cfg(), 0x10, 0x03)["positive"]
    r = b.uds(cfg(), 0x27, 0x01)
    assert r["positive"] and r["raw"] == [0x67, 0x01] + SEED_L1
    assert b.info(cfg())["unlockedLevel"] is None
    r = b.uds(cfg(), 0x27, 0x02, KEY_L1)
    assert r["positive"] and r["raw"] == [0x67, 0x02]
    assert b.info(cfg())["unlockedLevel"] == 1
    pecu.log.wait_for(lambda e: e.get("ev") == "security_unlocked")
    # unlocked: protected DID 0x0101 (read_security 1) is now readable
    assert b.ok("cmd_diag_read_did", {"config": cfg(), "did": 0x0101})["raw"] == [0xCA, 0xFE, 0xBA, 0xBE]
    # any session change re-locks
    assert b.uds(cfg(), 0x10, 0x03)["positive"]
    assert b.info(cfg())["unlockedLevel"] is None


def test_security_invalid_key_attempt_limit_and_delay(armed, pecu):
    b = armed
    assert b.uds(cfg(), 0x10, 0x03)["positive"]
    for expected in (0x35, 0x35, 0x36):
        assert b.uds(cfg(), 0x27, 0x01)["positive"]
        r = b.uds(cfg(), 0x27, 0x02, BAD_KEY)     # NRC = successful transport result
        assert r["positive"] is False and r["nrc"] == expected, r
        assert r["raw"] == [0x7F, 0x27, expected] and r["nrcName"]
        assert b.info(cfg())["unlockedLevel"] is None
    r = b.uds(cfg(), 0x27, 0x01)                   # lockout running -> requiredTimeDelayNotExpired
    assert r["positive"] is False and r["nrc"] == 0x37, r
    r = b.uds(cfg(), 0x27, 0x02, KEY_L1)
    assert r["positive"] is False and r["nrc"] == 0x37, r
    assert b.info(cfg())["unlockedLevel"] is None
    ev = [e["ev"] for e in pecu.log.entries()]
    assert ev.count("security_invalid_key") >= 2 and "security_lockout" in ev
    assert b.info(cfg())["activeSession"] == 3


# ============================================================================================
# 4. ReadDataByIdentifier helper vs raw request
# ============================================================================================
def test_read_did_vin_multiframe_and_unsupported(armed, pecu):
    b = armed
    m = pecu.log.mark()
    r = b.ok("cmd_diag_read_did", {"config": cfg(), "did": 0xF190})
    assert r["did"] == 0xF190
    assert r["decoded"] == VIN
    assert r["raw"] == list(VIN.encode()), "raw must be the data record only (no 0x62 / DID bytes)"
    tx = ecu_tx(pecu, m)
    assert tx and tx[-1]["data"] == "62F190" + VIN.encode().hex().upper()

    e = b.diag_err("cmd_diag_read_did", {"config": cfg(), "did": 0x1234})
    assert e.code == "negative_response", e.raw
    assert "0x31" in e.message.lower(), e.raw

    r = b.uds(cfg(), 0x22, None, [0x12, 0x34])
    assert r["positive"] is False and r["nrc"] == 0x31 and r["raw"] == [0x7F, 0x22, 0x31]
    assert r["nrcName"] and r["suppressed"] is False


# ============================================================================================
# 5. DTCs: 0x19 0x02 + 0x14 clear
# ============================================================================================
def test_read_and_clear_dtcs(armed, pecu):
    b = armed
    dtcs = b.ok("cmd_diag_read_stored_dtcs", {"config": cfg()})
    by_raw = {d["raw"]: d for d in dtcs}
    # configs/product_classic.json: 0x012345 status 0x2F, 0x9A0B00 status 0x08, 0x400100 status 0x00
    assert set(by_raw) == {0x012345, 0x9A0B00}, dtcs
    a, c = by_raw[0x012345], by_raw[0x9A0B00]
    assert a["code"] == "P0123-45" and a["statusByte"] == 0x2F
    assert a["isPending"] is True and a["isConfirmed"] is True and a["isMilOn"] is False
    assert c["code"] == "B1A0B-00" and c["statusByte"] == 0x08
    assert c["isPending"] is False and c["isConfirmed"] is True and c["isMilOn"] is False
    assert pecu.log.wait_for(lambda e: e.get("ev") == "rx" and e.get("data") == "1902FF")

    only_pending = b.ok("cmd_diag_read_stored_dtcs", {"config": cfg(), "statusMask": 0x04})
    assert [d["raw"] for d in only_pending] == [0x012345]

    r = b.uds(cfg(), 0x14, None, [0xFF, 0xFF, 0xFF])
    assert r["positive"] and r["raw"] == [0x54]
    pecu.log.wait_for(lambda e: e.get("ev") == "dtc_cleared")
    assert b.ok("cmd_diag_read_stored_dtcs", {"config": cfg()}) == []


# ============================================================================================
# 6. 0x78 responsePending and P2 timeout
# ============================================================================================
def test_response_pending_count(armed, pecu):
    b = armed
    m = pecu.log.mark()
    r = b.uds(cfg(), 0x22, None, [0xFA, 0x07])     # fault: pending 3
    assert r["positive"] is True and r["raw"] == [0x62, 0xFA, 0x07, 0x07], r
    assert r["responsePendingCount"] == 3
    pend = [e for e in ecu_tx(pecu, m) if e["data"] == "7F2278"]
    assert len(pend) == 3
    # first 0x78 immediately, then every 0.3 * P2* = 600 ms; final answer right after the 3rd
    t = [e["t"] for e in pecu.log.since(m) if e.get("ev") == "tx"]
    assert len(t) == 4
    assert r["elapsedUs"] >= (t[-1] - t[0]) * 1000 * 0.9 >= 2 * 0.3 * ECU_P2_STAR_MS * 1000 * 0.9
    evs = [e for e in b.all_events(cfg()) if e["requestSeq"] == r["transactionSeq"]]
    kinds = [e["kind"] for e in evs]
    assert kinds == ["response_pending"] * 3 + ["response"], kinds
    assert all(e["nrc"] == 0x78 for e in evs[:3])


def test_p2_timeout_and_late_response_dropped(armed, pecu):
    b = armed
    # no 0x10 yet -> P2client = default 50 ms + p2MarginMs 100 ms
    e = b.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x22, "subFunction": None, "data": [0xFA, 0x04]})
    assert e.code == "timeout_p2", e.raw                      # fault: no_response
    e = b.diag_err("cmd_diag_send_uds", {"config": cfg(), "sid": 0x22, "subFunction": None, "data": [0xFA, 0x03]})
    assert e.code == "timeout_p2", e.raw                      # fault: delay 400 ms
    time.sleep(0.5)                                           # late answer arrives meanwhile
    r = b.uds(cfg(), 0x22, None, [0xF1, 0x8C])
    assert r["positive"] and bytes(r["raw"][3:]) == b"SN0000000042", "late PDU must not be taken as this answer"
    evs = b.all_events(cfg())
    timeouts = [x for x in evs if x["kind"] == "timeout"]
    assert len(timeouts) == 2 and all(x["detail"] == "p2" for x in timeouts), timeouts
    stale = [x for x in evs if x["kind"] == "stale_response_dropped"]
    assert any(x["bytes"] == [0x62, 0xFA, 0x03, 0x03] for x in stale), stale


# ============================================================================================
# 7. S3 server timeout vs background TesterPresent
# ============================================================================================
@pytest.mark.slow
def test_s3_timeout_without_tester_present(armed, pecu):
    b = armed
    assert b.uds(cfg(), 0x10, 0x03)["positive"]
    assert b.info(cfg())["testerPresentEnabled"] is False
    m = pecu.log.mark()
    time.sleep(4.0)                                        # S3server = 3000 ms
    pecu.log.wait_for(lambda e: e.get("ev") == "s3_timeout", since=m, timeout=0.1)
    assert not [e for e in ecu_rx(pecu, m)], "no keepalive expected with TesterPresent off"
    r = b.uds(cfg(), 0x27, 0x01)
    assert r["positive"] is False and r["nrc"] == 0x7F, r   # 0x27 only in sessions 2/3
    assert b.info(cfg())["activeSession"] == 1, "S3 loss (0x7F after silence) should reset activeSession"


@pytest.mark.slow
def test_tester_present_keeps_session(armed, pecu):
    b = armed
    assert b.uds(cfg(), 0x10, 0x03)["positive"]
    info = b.ok("cmd_diag_set_tester_present", {"config": cfg(), "enabled": True})
    assert info["testerPresentEnabled"] is True and info["testerPresentIntervalMs"] == 2000
    m = pecu.log.mark()
    time.sleep(5.0)
    assert not [e for e in pecu.log.since(m) if e.get("ev") == "s3_timeout"]
    tp = [e for e in ecu_rx(pecu, m) if e["data"] == "3E80"]
    assert len(tp) >= 2, f"ECU saw {len(tp)} x 3E80 in 5 s"
    r = b.uds(cfg(), 0x27, 0x01)
    assert r["positive"] is True and r["raw"] == [0x67, 0x01] + SEED_L1, r
    assert b.info(cfg())["activeSession"] == 3
    ka = [e for e in b.all_events(cfg()) if e["kind"] == "keepalive_sent"]
    assert len(ka) >= 2 and all(e["bytes"] == [0x3E, 0x80] for e in ka), ka
    info = b.ok("cmd_diag_set_tester_present", {"config": cfg(), "enabled": False})
    assert info["testerPresentEnabled"] is False


# ============================================================================================
# 8. Conversation log paging
# ============================================================================================
def test_conversation_paging_and_pairing(armed, pecu):
    b = armed
    reqs = [(0x10, 0x03, []), (0x22, None, [0xF1, 0x90]), (0x22, None, [0x12, 0x34]),
            (0x19, 0x02, [0xFF]), (0x3E, 0x00, [])]
    seqs = [b.uds(cfg(), sid, sub, data)["transactionSeq"] for sid, sub, data in reqs]

    p = b.conversation(cfg(), 0, 3)
    assert [e["seq"] for e in p["events"]] == [1, 2, 3]
    assert p["lastSeq"] == 3 and p["truncated"] is False
    p2 = b.conversation(cfg(), p["lastSeq"], 500)
    assert p2["events"][0]["seq"] == 4
    evs = p["events"] + p2["events"]
    assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))
    assert b.conversation(cfg(), p2["lastSeq"])["events"] == []

    ts = [e["timestampUs"] for e in evs]
    assert ts == sorted(ts), f"timestampUs not monotonic: {ts}"

    by_seq = {e["seq"]: e for e in evs}
    for (sid, sub, data), s in zip(reqs, seqs):
        rq = by_seq[s]
        assert rq["kind"] == "request" and rq["sid"] == sid
        assert rq["bytes"] == [sid] + ([sub] if sub is not None else []) + data
        rs = [e for e in evs if e["kind"] == "response" and e["requestSeq"] == s]
        assert len(rs) == 1, f"request seq {s}: {rs}"
        assert rs[0]["sid"] == sid and rs[0]["timestampUs"] >= rq["timestampUs"]
        assert rs[0]["elapsedUs"] is not None and rs[0]["elapsedUs"] >= 0
    neg = [e for e in evs if e["kind"] == "response" and e["requestSeq"] == seqs[2]][0]
    assert neg["nrc"] == 0x31 and neg["bytes"] == [0x7F, 0x22, 0x31]
    assert b.info(cfg())["lastSeq"] == evs[-1]["seq"]


# ============================================================================================
# 9. CAN-FD
# ============================================================================================
def test_canfd_vin_and_200_byte_did(bridge, pecu_fd, tmp_path):
    bridge.connect()
    with Candump(tmp_path / "fd.candump", filt=f"{FD_REQ:X}:7FF,{FD_RESP:X}:7FF") as cap:
        r = bridge.ok("cmd_diag_read_did", {"config": FD_CFG, "did": 0xF190})
        assert r["decoded"] == VIN and r["raw"] == list(VIN.encode())
        r = bridge.ok("cmd_diag_read_did", {"config": FD_CFG, "did": 0xF1F1})
        assert len(r["raw"]) == 200
        assert bytes(r["raw"]).startswith(b"The quick brown fox")
    frames = candump_lines(cap)
    tester = [f for f in frames if f[1] == f"{FD_REQ:03X}"]
    ecu = [f for f in frames if f[1] == f"{FD_RESP:03X}"]
    assert tester and ecu
    not_fd = [f for f in frames if not f[2].startswith("#")]
    assert not_fd == [], f"classic frames on the FD session: {not_fd}"
    # candump -L: ID##<flags><data>, flags bit0 = BRS
    no_brs = [f for f in frames if not (int(f[2][1], 16) & 0x1)]
    assert no_brs == [], f"FD frames without BRS: {no_brs}"
    # 200-byte record = FF + CF(s) of up to 64 bytes from the ECU, FC from the tester
    assert any(f[2][2:].startswith("1") for f in ecu), "expected an FD first frame from the ECU"
    assert any(f[2][2:].startswith("30") for f in tester), "expected a flow control from NexusCAN"
    assert max(len(f[2]) - 2 for f in ecu) // 2 == 64


# ============================================================================================
# 10. Functional addressing (OBD-II mode 01 PID 0x0C)
# ============================================================================================
def test_functional_obd_mode01(armed, pecu, tmp_path):
    b = armed
    m = pecu.log.mark()
    with Candump(tmp_path / "func.candump", filt=f"{P_FUNC:X}:7FF,{P_REQ:X}:7FF") as cap:
        r = b.uds(cfg(), 0x01, None, [0x0C], {"addressing": "functional"})
    assert r["positive"] is True and r["raw"] == [0x41, 0x0C, 0x1A, 0xF8], r
    frames = candump_lines(cap)
    assert [f[1] for f in frames] == [f"{P_FUNC:03X}"], frames
    assert frames[0][2].startswith("02010C")
    rx = ecu_rx(pecu, m)
    assert len(rx) == 1 and rx[0]["ta"] == "func" and rx[0]["data"] == "010C"
    ev = [e for e in b.all_events(cfg()) if e["seq"] == r["transactionSeq"]][0]
    assert ev["addressing"] == "functional"


# ============================================================================================
# 11. Panic Stop in the middle of a multi-frame request
# ============================================================================================
def test_panic_stop_mid_multiframe_request(bridge, pecu_slow_fc, tmp_path):
    bridge.connect()
    pecu = pecu_slow_fc
    assert bridge.uds(cfg(), 0x10, 0x03)["positive"]
    payload = [0xF1, 0xF1] + [0x41] * 200     # 203-byte 0x2E PDU, ECU FC STmin 100 ms -> ~3 s
    result: Dict[str, Any] = {}

    def worker() -> None:
        result["resp"] = bridge.invoke("cmd_diag_send_uds", {"config": cfg(), "sid": 0x2E,
                                                             "subFunction": None, "data": payload})

    m = pecu.log.mark()
    with Candump(tmp_path / "mid.candump", filt=f"{P_REQ:X}:7FF,{P_RESP:X}:7FF") as cap:
        th = threading.Thread(target=worker)
        th.start()
        time.sleep(0.8)
        t_before = time.time()
        bridge.ok("cmd_panic_stop_tx", {})
        t_latched = time.time()
        th.join(timeout=10)
        assert not th.is_alive(), "send_uds did not return after Panic Stop"
        time.sleep(1.5)                       # would have been ~15 more CFs
    st, v = result["resp"]
    assert st == 400, f"request must fail after Panic Stop, got {st}: {v}"
    mm = DIAG_ERR_RE.match(v["error"])
    print("panic mid-request error:", v["error"])
    assert mm and mm.group(1) in ("panic_latched", "session_closed"), v
    frames = candump_lines(cap)
    tester = [f for f in frames if f[1] == f"{P_REQ:03X}"]
    before = [f for f in tester if f[0] < t_before]
    assert before and before[0][2].startswith("10CB2EF1F1"), "first frame of the 203-byte request"
    assert len(tester) < 1 + 29, "the request must not complete"
    late = [f for f in tester if f[0] >= t_latched]
    assert late == [], f"tester frames after Panic Stop latched: {late}"
    assert not [e for e in ecu_rx(pecu, m) if e["data"].startswith("2EF1F1")], "ECU must not get the full PDU"
    assert bridge.info(cfg())["open"] is False


# ============================================================================================
# 12. Session key: same ids, different padding -> old session closed, single Flow Control
# ============================================================================================
def test_session_key_padding_change_single_flow_control(armed, pecu, tmp_path):
    b = armed
    a_cfg, n_cfg = cfg(padding=0xAA), cfg(padding=None)
    with Candump(tmp_path / "key.candump", filt=f"{P_REQ:X}:7FF,{P_RESP:X}:7FF") as cap:
        assert b.ok("cmd_diag_read_did", {"config": a_cfg, "did": 0xF190})["decoded"] == VIN
        assert b.info(a_cfg)["open"] is True
        assert b.ok("cmd_diag_read_did", {"config": n_cfg, "did": 0xF190})["decoded"] == VIN
        assert b.info(n_cfg)["open"] is True
        assert b.info(a_cfg)["open"] is False, "old session on the same ids must be closed"
        assert b.ok("cmd_diag_read_did", {"config": n_cfg, "did": 0xF1F0})["raw"][:4] == list(b"0123")
    frames = candump_lines(cap)
    ffs = [f for f in frames if f[1] == f"{P_RESP:03X}" and f[2][0] == "1"]
    fcs = [f for f in frames if f[1] == f"{P_REQ:03X}" and f[2].startswith("3")]
    assert len(ffs) == 3, frames
    assert len(fcs) == len(ffs), f"{len(fcs)} flow controls for {len(ffs)} first frames: {fcs}"
    # FC after each FF exactly once, padded per session config
    assert fcs[0][2] == "300000AAAAAAAAAA", fcs[0]
    assert fcs[1][2] == "300000" and fcs[2][2] == "300000", fcs
    for ff in ffs:
        nxt = [f for f in frames if f[0] > ff[0]]
        k = 0
        for f in nxt:
            if f[1] == f"{P_RESP:03X}" and f[2][0] == "1":
                break
            if f[1] == f"{P_REQ:03X}" and f[2].startswith("3"):
                k += 1
        assert k == 1, f"FF at {ff[0]} got {k} flow controls"
