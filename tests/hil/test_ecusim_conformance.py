"""
Conformance tests of the virtual ECU (tests/hil/ecusim) against an independent UDS client
(udsoncan + kernel ISO-TP sockets). Expected values come from ecusim/config/default.json.

These tests verify the *test ECU itself*; NexusCAN product tests will be added on top of the
same bench later (see README.md).
"""
from __future__ import annotations

import json
import os
import time
import zlib

import pytest
import udsoncan
from udsoncan import MemoryLocation
from udsoncan.exceptions import NegativeResponseException, TimeoutException
from udsoncan.services import CommunicationControl, ECUReset, InputOutputControlByIdentifier

from conftest import (CANON_REQ, CANON_RESP, DEFAULT_CFG, FD_REQ, FD_RESP, HIL_DIR, REQ, RESP,
                      Candump, IsoTpDump, RawTp, make_client)

VIN = "WNX0ECUSIM0000017"
SEED_L1 = bytes.fromhex("11223344")
KEY_L1 = bytes(b ^ k for b, k in zip(SEED_L1, bytes.fromhex("A5A5A5A5")))  # B4 87 96 E1
P2_MS, P2_STAR_MS, S3_MS = 50, 2000, 3000
GOLDEN = HIL_DIR / "golden" / "uds_session_security_vin.candump"
GOLDEN_ISOTP = HIL_DIR / "golden" / "uds_session_security_vin.isotpdump"


def nrc_of(excinfo) -> int:
    return excinfo.value.response.code


def unlock_l1(client) -> None:
    client.change_session(3)
    seed = client.request_seed(1).service_data.seed
    assert seed == SEED_L1
    client.send_key(2, KEY_L1)


def enter_programming_unlocked(client) -> None:
    client.change_session(3)
    client.change_session(2)
    seed = client.request_seed(0x11).service_data.seed
    assert len(seed) == 4
    client.send_key(0x12, bytes(b ^ 0xFF for b in seed))


# ============================================================================================
# 0x10 DiagnosticSessionControl / S3
# ============================================================================================
def test_session_transitions_and_timing_parameters(client):
    r = client.change_session(3)
    # server must report its own P2/P2* (iso14229 would report the client defaults)
    assert r.service_data.p2_server_max == pytest.approx(P2_MS / 1000)
    assert r.service_data.p2_star_server_max == pytest.approx(P2_STAR_MS / 1000)
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x03"

    client.change_session(2)  # programming only reachable from extended / programming
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x02"

    client.change_session(1)
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x01"


def test_session_nrcs(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.change_session(2)  # default -> programming not allowed
    assert nrc_of(ei) == 0x22
    with pytest.raises(NegativeResponseException) as ei:
        client.change_session(5)  # not configured
    assert nrc_of(ei) == 0x12


def test_session_change_relocks_security(client):
    unlock_l1(client)
    assert client.read_data_by_identifier(0x0101).service_data.values[0x0101] == bytes.fromhex("CAFEBABE")
    client.change_session(3)  # extended -> extended: security re-locked
    with pytest.raises(NegativeResponseException) as ei:
        client.read_data_by_identifier(0x0101)
    assert nrc_of(ei) == 0x33


@pytest.mark.slow
def test_s3_timeout_returns_to_default(client, ecu):
    unlock_l1(client)
    m = ecu.log.mark()
    time.sleep((S3_MS + 600) / 1000)
    ev = ecu.log.wait_for(lambda e: e["ev"] == "s3_timeout", since=m, timeout=0.1)
    assert ev["session"] == 3
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x01"
    with pytest.raises(NegativeResponseException) as ei:  # security lost with the session
        client.read_data_by_identifier(0x0101)
    assert nrc_of(ei) == 0x33


@pytest.mark.slow
def test_s3_kept_alive_by_tester_present(client, ecu):
    client.change_session(3)
    m = ecu.log.mark()
    for _ in range(5):
        time.sleep(1.0)
        with client.suppress_positive_response:
            client.tester_present()
    assert not [e for e in ecu.log.since(m) if e["ev"] == "s3_timeout"]
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x03"


@pytest.mark.slow
def test_s3_kept_alive_by_any_request(client, ecu):
    """ISO 14229-2: S3server restarts on every request, not only 0x10/0x3E."""
    client.change_session(3)
    m = ecu.log.mark()
    for _ in range(5):
        time.sleep(1.0)
        client.read_data_by_identifier(0xF18C)
    assert not [e for e in ecu.log.since(m) if e["ev"] == "s3_timeout"]
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x03"


# ============================================================================================
# generic NRC handling
# ============================================================================================
def test_nrc_0x7f_service_not_supported_in_active_session(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.write_data_by_identifier(0xF1A0, b"\x01\x02\x03\x04")
    assert nrc_of(ei) == 0x7F
    with pytest.raises(NegativeResponseException) as ei:
        client.start_routine(0x0203)
    assert nrc_of(ei) == 0x7F


def test_nrc_0x33_security_access_denied(client):
    client.change_session(3)
    with pytest.raises(NegativeResponseException) as ei:
        client.write_data_by_identifier(0xF190, "WNX0ECUSIM0000099")
    assert nrc_of(ei) == 0x33
    with pytest.raises(NegativeResponseException) as ei:
        client.read_data_by_identifier(0x0101)
    assert nrc_of(ei) == 0x33
    with pytest.raises(NegativeResponseException) as ei:
        client.start_routine(0x0204)
    assert nrc_of(ei) == 0x33


def test_nrc_0x31_request_out_of_range(client, raw):
    assert raw.request(bytes.fromhex("221234")) == bytes.fromhex("7F2231")
    # DID readable only in extended session
    assert raw.request(bytes.fromhex("220102")) == bytes.fromhex("7F2231")
    client.change_session(3)
    with pytest.raises(NegativeResponseException) as ei:
        client.write_data_by_identifier(0xF18C, "SN0000000043")  # read-only DID
    assert nrc_of(ei) == 0x31


def test_nrc_0x13_incorrect_length(client, raw):
    assert raw.request(bytes.fromhex("22F1")) == bytes.fromhex("7F2213")
    client.change_session(3)
    assert raw.request(bytes.fromhex("2EF1A00102")) == bytes.fromhex("7F2E13")  # 2 of 4 bytes
    assert raw.request(bytes.fromhex("10")) == bytes.fromhex("7F1013")


def test_nrc_0x11_service_not_supported(raw):
    assert raw.request(bytes.fromhex("BA00")) == bytes.fromhex("7FBA11")
    # disabled in config
    assert raw.request(bytes.fromhex("3500440008000000000100")) == bytes.fromhex("7F3511")


def test_nrc_0x11_request_file_transfer_not_stale(raw):
    """iso14229 0.11.0 re-sends the previous response for NRCs of 0x38 (see README)."""
    assert raw.request(bytes.fromhex("22F18C")) == bytes.fromhex("62F18C") + b"SN0000000042"
    assert raw.request(bytes.fromhex("380100046162636400010A0A")) == bytes.fromhex("7F3811")
    assert raw.request(bytes.fromhex("3801")) == bytes.fromhex("7F3811")  # too short


# ============================================================================================
# 0x27 SecurityAccess
# ============================================================================================
def test_security_access_unlock_with_correct_key(client):
    client.change_session(3)
    with pytest.raises(NegativeResponseException) as ei:
        client.write_data_by_identifier(0xF190, "WNX0ECUSIM0000099")
    assert nrc_of(ei) == 0x33
    assert client.request_seed(1).service_data.seed == SEED_L1
    client.send_key(2, KEY_L1)
    client.write_data_by_identifier(0xF190, "WNX0ECUSIM0000099")
    assert client.read_data_by_identifier(0xF190).service_data.values[0xF190] == "WNX0ECUSIM0000099"
    # already unlocked -> zero seed
    assert set(client.request_seed(1).service_data.seed) == {0}


def test_security_access_not_in_default_session(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.request_seed(1)
    assert nrc_of(ei) == 0x7F


def test_security_access_key_without_seed(client):
    client.change_session(3)
    with pytest.raises(NegativeResponseException) as ei:
        client.send_key(2, KEY_L1)
    assert nrc_of(ei) == 0x24


@pytest.mark.slow
def test_security_access_invalid_key_attempts_and_delay(client, ecu):
    client.change_session(3)
    bad = b"\x00\x00\x00\x00"
    for expected in (0x35, 0x35, 0x36):
        client.request_seed(1)
        with pytest.raises(NegativeResponseException) as ei:
            client.send_key(2, bad)
        assert nrc_of(ei) == expected
    # during the lockout delay
    with pytest.raises(NegativeResponseException) as ei:
        client.request_seed(1)
    assert nrc_of(ei) == 0x37
    with pytest.raises(NegativeResponseException) as ei:
        client.send_key(2, KEY_L1)
    assert nrc_of(ei) == 0x37
    time.sleep(1.6)  # lockout_ms = 1500
    assert client.request_seed(1).service_data.seed == SEED_L1
    client.send_key(2, KEY_L1)
    ev = [e["ev"] for e in ecu.log.entries()]
    assert "security_lockout" in ev and "security_lockout_end" in ev and "security_unlocked" in ev


def test_security_access_counter_seed_is_deterministic(client):
    client.change_session(3)
    client.change_session(2)
    s1 = client.request_seed(0x11).service_data.seed
    s2 = client.request_seed(0x11).service_data.seed
    assert s1 == bytes.fromhex("0A0B0C0D") and s2 == bytes.fromhex("0A0B0C0E")
    client.send_key(0x12, bytes(b ^ 0xFF for b in s2))


# ============================================================================================
# 0x22 / 0x2E / 0x2F / 0x31
# ============================================================================================
def test_rdbi_iso_identification_dids(client):
    vals = client.read_data_by_identifier([0xF187, 0xF188, 0xF189, 0xF18A, 0xF18B, 0xF18C, 0xF190,
                                           0xF191, 0xF192, 0xF193, 0xF194, 0xF195]).service_data.values
    assert vals[0xF190] == VIN and len(VIN) == 17
    assert vals[0xF18C] == "SN0000000042"
    assert vals[0xF18B] == bytes.fromhex("261110")
    assert vals[0xF195] == "B2"


def test_rdbi_multi_did_partial_support(raw):
    """ISO 14229-1:2020: unsupported DIDs are omitted; 0x31 only if none is supported."""
    rsp = raw.request(bytes.fromhex("22F1901234F18C"))
    assert rsp == bytes.fromhex("62F190") + VIN.encode() + bytes.fromhex("F18C") + b"SN0000000042"
    assert raw.request(bytes.fromhex("2212345678")) == bytes.fromhex("7F2231")


def test_wdbi_roundtrip(client):
    client.change_session(3)
    client.write_data_by_identifier(0xF1A0, bytes.fromhex("DEADBEEF"))
    assert client.read_data_by_identifier(0xF1A0).service_data.values[0xF1A0] == bytes.fromhex("DEADBEEF")


def test_io_control(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.io_control(0x0100, InputOutputControlByIdentifier.ControlParam.shortTermAdjustment, [b"\x7f"])
    assert nrc_of(ei) == 0x7F
    client.change_session(3)
    r = client.io_control(0x0100, InputOutputControlByIdentifier.ControlParam.shortTermAdjustment, [b"\x7f"])
    assert r.service_data.decoded_data == b"\x7f"
    assert client.read_data_by_identifier(0x0100).service_data.values[0x0100] == b"\x7f"
    r = client.io_control(0x0100, InputOutputControlByIdentifier.ControlParam.returnControlToECU)
    assert r.service_data.decoded_data == b"\x00"
    assert client.read_data_by_identifier(0x0100).service_data.values[0x0100] == b"\x00"
    # IO control ends when leaving to the default session
    client.io_control(0x0100, InputOutputControlByIdentifier.ControlParam.shortTermAdjustment, [b"\x33"])
    client.change_session(1)
    assert client.read_data_by_identifier(0x0100).service_data.values[0x0100] == b"\x00"


def test_routine_control(client):
    client.change_session(3)
    r = client.start_routine(0x0203)
    assert r.service_data.routine_status_record == b"\x00"
    r = client.get_routine_result(0x0203)
    assert r.service_data.routine_status_record == bytes.fromhex("AA55")
    r = client.stop_routine(0x0203)
    assert r.service_data.routine_status_record == b"\x01"
    with pytest.raises(NegativeResponseException) as ei:
        client.stop_routine(0x0203)
    assert nrc_of(ei) == 0x24
    with pytest.raises(NegativeResponseException) as ei:
        client.start_routine(0x9999)
    assert nrc_of(ei) == 0x31


# ============================================================================================
# 0x28 / 0x85 / 0x3E / 0x11
# ============================================================================================
def test_communication_control(client, raw, ecu):
    ct = udsoncan.CommunicationType(subnet=0, normal_msg=True, network_management_msg=False)
    with pytest.raises(NegativeResponseException) as ei:
        client.communication_control(CommunicationControl.ControlType.enableRxAndDisableTx, ct)
    assert nrc_of(ei) == 0x7F
    client.change_session(3)
    m = ecu.log.mark()
    client.communication_control(CommunicationControl.ControlType.enableRxAndDisableTx, ct)
    assert ecu.log.wait_for(lambda e: e["ev"] == "comm_ctrl", since=m)["ctrl"] == 1
    assert raw.request(bytes.fromhex("287F01")) == bytes.fromhex("7F2812")
    assert raw.request(bytes.fromhex("280000")) == bytes.fromhex("7F2831")


def test_control_dtc_setting(client, ecu):
    with pytest.raises(NegativeResponseException) as ei:
        client.control_dtc_setting(2)
    assert nrc_of(ei) == 0x7F
    client.change_session(3)
    m = ecu.log.mark()
    client.control_dtc_setting(2)
    assert ecu.log.wait_for(lambda e: e["ev"] == "dtc_setting", since=m)["on"] is False
    client.control_dtc_setting(1)
    assert ecu.log.wait_for(lambda e: e["ev"] == "dtc_setting" and e["on"], since=m)


def test_tester_present_with_and_without_suppress(client, raw, ecu):
    assert client.tester_present() is not None
    m = ecu.log.mark()
    with client.suppress_positive_response:
        assert client.tester_present() is None
    assert raw.request(bytes.fromhex("3E80"), timeout=0.3) is None
    ent = ecu.log.since(m)
    assert sum(1 for e in ent if e["ev"] == "rx" and e["data"] == "3E80") == 2
    assert not [e for e in ent if e["ev"] == "tx"]
    assert raw.request(bytes.fromhex("3E05")) == bytes.fromhex("7F3E12")


def test_ecu_reset(client, raw, ecu):
    unlock_l1(client)
    m = ecu.log.mark()
    r = client.ecu_reset(ECUReset.ResetType.hardReset)
    assert r.service_data.reset_type_echo == 1
    # request during power-down (100 ms) must be lost, like on a real ECU
    assert raw.request(bytes.fromhex("22F190"), timeout=0.5) is None
    ev = ecu.log.wait_for(lambda e: e["ev"] == "ecu_reset", since=m)
    assert ev["type"] == 1 and ev["dropped_requests"] == 1
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x01"
    client.change_session(3)
    with pytest.raises(NegativeResponseException) as ei:
        client.read_data_by_identifier(0x0101)
    assert nrc_of(ei) == 0x33
    with pytest.raises(NegativeResponseException) as ei:
        client.ecu_reset(0x05)
    assert nrc_of(ei) == 0x12


def test_ecu_reset_suppressed_response(raw, ecu):
    m = ecu.log.mark()
    assert raw.request(bytes.fromhex("1181"), timeout=0.4) is None
    ecu.log.wait_for(lambda e: e["ev"] == "ecu_reset" and e["type"] == 1, since=m)
    assert not [e for e in ecu.log.since(m) if e["ev"] == "tx"]


# ============================================================================================
# Flash: 0x34 / 0x36 / 0x37 / CRC routine / 0x23 read-back
# ============================================================================================
def test_flash_download_with_bsc_wrap_and_crc(client, ecu):
    data = bytes((i * 7 + (i >> 8)) & 0xFF for i in range(40000))
    base = 0x00080000

    with pytest.raises(NegativeResponseException) as ei:  # default session
        client.request_download(MemoryLocation(base, len(data), 32, 32))
    assert nrc_of(ei) == 0x7F

    enter_programming_unlocked(client)
    client.start_routine(0xFF00)  # erase
    with pytest.raises(NegativeResponseException) as ei:  # CRC before any download
        client.start_routine(0x0202)
    assert nrc_of(ei) == 0x24

    with pytest.raises(NegativeResponseException) as ei:  # outside any download region
        client.request_download(MemoryLocation(0x00010000, 16, 32, 32))
    assert nrc_of(ei) == 0x31

    r = client.request_download(MemoryLocation(base, len(data), 32, 32))
    max_len = r.service_data.max_length
    assert max_len == 130
    chunk = max_len - 2
    seqs = []
    for n, off in enumerate(range(0, len(data), chunk)):
        seq = (n + 1) & 0xFF
        seqs.append(seq)
        client.transfer_data(seq, data[off:off + chunk])
    assert len(seqs) > 256 and 0xFF in seqs and seqs[seqs.index(0xFF) + 1] == 0x00
    client.request_transfer_exit()

    crc = zlib.crc32(data) & 0xFFFFFFFF
    r = client.start_routine(0x0202)
    assert r.service_data.routine_status_record == crc.to_bytes(4, "big")
    done = [e for e in ecu.log.entries() if e["ev"] == "download_done"][-1]
    assert done["crc32"] == f"{crc:08X}" and done["size"] == len(data)

    # 0x23 reads back what was flashed (whole image in 4000-byte pieces)
    back = b""
    for off in range(0, len(data), 4000):
        n = min(4000, len(data) - off)
        back += client.read_memory_by_address(MemoryLocation(base + off, n, 32, 16)).service_data.memory_block
    assert back == data


def test_transfer_data_without_download_is_rejected(client, raw):
    enter_programming_unlocked(client)
    rsp = raw.request(bytes.fromhex("360100"))
    assert rsp is not None and rsp[:2] == bytes.fromhex("7F36") and rsp[2] in (0x24, 0x70)


def test_transfer_data_wrong_block_sequence_counter_iso_nrc(client):
    """ISO 14229-1:2020 Table 0x36 NRCs: wrong blockSequenceCounter -> 0x73.
    iso14229 0.11.0 answers 0x24 (requestSequenceError) - see README 'Bulunan sorunlar'."""
    enter_programming_unlocked(client)
    client.request_download(MemoryLocation(0x00080000, 256, 32, 32))
    client.transfer_data(1, bytes(128))
    with pytest.raises(NegativeResponseException) as ei:
        client.transfer_data(3, bytes(128))
    assert nrc_of(ei) == 0x73


# ============================================================================================
# 0x19 / 0x14
# ============================================================================================
def test_read_dtc_information(client):
    r = client.get_number_of_dtc_by_status_mask(0xFF)
    assert r.service_data.dtc_count == 2
    assert r.service_data.dtc_format == udsoncan.Dtc.Format.ISO14229_1
    assert client.get_number_of_dtc_by_status_mask(0x04).service_data.dtc_count == 1

    r = client.get_dtc_by_status_mask(0x08)
    got = {(d.id, d.status.get_byte_as_int()) for d in r.service_data.dtcs}
    assert got == {(0x012345, 0x2F), (0x9A0B00, 0x08)}

    r = client.get_supported_dtc()
    assert {d.id for d in r.service_data.dtcs} == {0x012345, 0x9A0B00, 0x400100}

    r = client.get_dtc_snapshot_by_dtc_number(0x012345, record_number=0xFF)
    dtc = r.service_data.dtcs[0]
    # udsoncan yields one Snapshot object per (record, DID): 2 records x 2 DIDs
    assert dtc.id == 0x012345 and len(dtc.snapshots) == 4
    assert {sn.record_number for sn in dtc.snapshots} == {1, 2}
    s = {(sn.record_number, sn.did): sn.data for sn in dtc.snapshots}
    assert s[(1, 0x1001)] == bytes.fromhex("1234") and s[(2, 0x1002)] == bytes.fromhex("EF")

    r = client.get_dtc_extended_data_by_dtc_number(0x012345, record_number=0xFF, data_size=1)
    ext = {e.record_number: e.raw_data for e in r.service_data.dtcs[0].extended_data}
    assert ext == {1: b"\x05", 2: b"\x10"}

    with pytest.raises(NegativeResponseException) as ei:
        client.get_dtc_snapshot_by_dtc_number(0x111111, record_number=1)
    assert nrc_of(ei) == 0x31


def test_read_dtc_unsupported_subfunction(raw):
    assert raw.request(bytes.fromhex("1903")) == bytes.fromhex("7F1912")


def test_clear_dtc_then_read_is_empty(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.clear_dtc(0x111111)
    assert nrc_of(ei) == 0x31
    client.clear_dtc(0x9A0B00)
    assert client.get_number_of_dtc_by_status_mask(0xFF).service_data.dtc_count == 1
    client.clear_dtc(0xFFFFFF)
    assert client.get_number_of_dtc_by_status_mask(0xFF).service_data.dtc_count == 0
    assert client.get_dtc_by_status_mask(0xFF).service_data.dtcs == []
    r = client.get_dtc_snapshot_by_dtc_number(0x012345, record_number=0xFF)
    assert r.service_data.dtcs[0].snapshots == []


# ============================================================================================
# 0x23 ReadMemoryByAddress
# ============================================================================================
def test_read_memory_by_address(client):
    r = client.read_memory_by_address(MemoryLocation(0x00010000, 16, 32, 16))
    assert r.service_data.memory_block == bytes.fromhex("00112233445566778899AABBCCDDEEFF")
    r = client.read_memory_by_address(MemoryLocation(0x20000000, 8, 32, 16))
    assert r.service_data.memory_block == bytes(8)
    with pytest.raises(NegativeResponseException) as ei:  # crosses region end
        client.read_memory_by_address(MemoryLocation(0x000100F8, 16, 32, 16))
    assert nrc_of(ei) == 0x31
    with pytest.raises(NegativeResponseException) as ei:  # unmapped
        client.read_memory_by_address(MemoryLocation(0x30000000, 4, 32, 16))
    assert nrc_of(ei) == 0x31


# ============================================================================================
# OBD-II mode 01 + functional addressing
# ============================================================================================
def test_obd_mode01_functional(raw_func, ecu):
    assert raw_func.request(bytes.fromhex("0100")) == bytes.fromhex("410008180001")
    assert raw_func.request(bytes.fromhex("0120")) == bytes.fromhex("412000020000")
    assert raw_func.request(bytes.fromhex("010C")) == bytes.fromhex("410C1AF8")  # 1726 rpm
    assert raw_func.request(bytes.fromhex("010D")) == bytes.fromhex("410D3C")    # 60 km/h
    assert raw_func.request(bytes.fromhex("0105")) == bytes.fromhex("41057B")    # 83 degC
    assert raw_func.request(bytes.fromhex("010C0D05")) == bytes.fromhex("410C1AF80D3C057B")
    m = ecu.log.mark()
    assert raw_func.request(bytes.fromhex("010A"), timeout=0.4) is None  # unsupported -> silent
    ent = ecu.log.since(m)
    assert [e for e in ent if e["ev"] == "rx" and e["ta"] == "func" and e["data"] == "010A"]
    assert not [e for e in ent if e["ev"] == "tx"]


def test_functional_uds_addressing(raw_func, raw, ecu):
    assert raw_func.request(bytes.fromhex("3E00")) == bytes.fromhex("7E00")
    assert raw_func.request(bytes.fromhex("1003")) == bytes.fromhex("5003003200C8")
    m = ecu.log.mark()
    # NRC 0x11 / 0x31 are suppressed for functional requests, but not for physical ones
    assert raw_func.request(bytes.fromhex("BA00"), timeout=0.4) is None
    assert raw_func.request(bytes.fromhex("221234"), timeout=0.4) is None
    assert not [e for e in ecu.log.since(m) if e["ev"] == "tx"]
    assert raw.request(bytes.fromhex("221234")) == bytes.fromhex("7F2231")


# ============================================================================================
# deterministic fault injection
# ============================================================================================
def test_fault_fixed_nrc(client):
    with pytest.raises(NegativeResponseException) as ei:
        client.read_data_by_identifier(0xFA01)
    assert nrc_of(ei) == 0x22


def test_fault_response_pending_within_p2_star(raw, ecu):
    t0 = raw.send(bytes.fromhex("22FA02"))
    msgs = []
    while True:
        m = raw.recv(timeout=P2_STAR_MS / 1000 + 0.5)
        assert m is not None, f"no message within P2* after {msgs}"
        msgs.append((time.monotonic(), m))
        if m[:3] != bytes.fromhex("7F2278"):
            break
    assert [m for _, m in msgs] == [bytes.fromhex("7F2278")] * 2 + [bytes.fromhex("62FA02C0DE")]
    assert msgs[0][0] - t0 < P2_MS / 1000  # first 0x78 within P2server
    times = [t0] + [t for t, _ in msgs]
    gaps = [b - a for a, b in zip(times[1:], times[2:])]
    assert all(g < P2_STAR_MS / 1000 for g in gaps), gaps  # every next frame within P2*server
    tx = [e for e in ecu.log.entries() if e["ev"] == "tx"][-3:]
    assert [e["data"] for e in tx] == ["7F2278", "7F2278", "62FA02C0DE"]


def test_fault_response_pending_with_udsoncan(client):
    t = time.monotonic()
    assert client.read_data_by_identifier(0xFA02).service_data.values[0xFA02] == bytes.fromhex("C0DE")
    assert time.monotonic() - t < 2 * P2_STAR_MS / 1000


def test_fault_pending_forces_response_despite_suppress_bit(raw):
    """ISO 14229-1 7.5: after 0x78 a positive response is sent even with SPRMIB set."""
    assert raw.request(bytes.fromhex("1003")) == bytes.fromhex("5003003200C8")
    raw.send(bytes.fromhex("3181FA06"))
    msgs = [raw.recv(timeout=1.0), raw.recv(timeout=P2_STAR_MS / 1000 + 0.5)]
    assert msgs == [bytes.fromhex("7F3178"), bytes.fromhex("7101FA0600")]


def test_fault_response_delay(client, ecu):
    t = time.monotonic()
    assert client.read_data_by_identifier(0xFA03).service_data.values[0xFA03] == b"\x03"
    dt = time.monotonic() - t
    assert 0.38 <= dt < 1.0, dt
    rx = [e for e in ecu.log.entries() if e["ev"] == "rx" and e["data"] == "22FA03"][-1]
    tx = [e for e in ecu.log.entries() if e["ev"] == "tx" and e["data"] == "62FA0303"][-1]
    assert 399 <= tx["t"] - rx["t"] < 450
    with make_client(p2_timeout=0.2) as fast:
        with pytest.raises(TimeoutException):
            fast.read_data_by_identifier(0xFA03)


def test_fault_no_response(client, ecu):
    m = ecu.log.mark()
    with make_client(p2_timeout=0.5, request_timeout=1.0) as c:
        with pytest.raises(TimeoutException):
            c.read_data_by_identifier(0xFA04)
    ent = ecu.log.since(m)
    assert [e for e in ent if e["ev"] == "rx" and e["data"] == "22FA04"]
    assert [e for e in ent if e["ev"] == "tx_drop" and e["data"] == "62FA0404"]


def test_fault_busy_repeat_request_count(client):
    client.change_session(3)
    for _ in range(2):
        with pytest.raises(NegativeResponseException) as ei:
            client.start_routine(0xFA05)
        assert nrc_of(ei) == 0x21
    assert client.start_routine(0xFA05).service_data.routine_status_record == b"\x00"


# ============================================================================================
# CAN-FD
# ============================================================================================
def test_canfd_64_byte_frames(ecu_fd, tmp_path):
    long_did = (b"The quick brown fox jumps over the lazy dog. 0123456789. " * 3
                + b"ABCDEFGHIJKLMNOPQRSTUVWXYZ!!!")
    assert len(long_did) == 200
    cap = Candump(tmp_path / "fd.candump", filt="7E1:7FF,7E9:7FF")
    with cap:
        with make_client(txid=FD_REQ, rxid=FD_RESP, fd=True) as c:
            assert c.read_data_by_identifier(0xF1F1).service_data.values[0xF1F1] == long_did
            assert c.read_data_by_identifier(0xF190).service_data.values[0xF190] == VIN
            c.change_session(3)
            c.write_data_by_identifier(0xF1A0, bytes.fromhex("01020304"))
    resp = [f for f in cap.frames() if f.startswith("7E9#")]
    req = [f for f in cap.frames() if f.startswith("7E1#")]
    assert resp and all("##" in f for f in resp), resp  # every ECU frame is a CAN-FD frame
    payload_lens = [len(f.split("##")[1][1:]) // 2 for f in resp]
    assert payload_lens.count(64) >= 3, payload_lens  # FF + CFs use the full 64 byte DLC
    assert req and all("##" in f for f in req), req


def test_canfd_with_raw_single_frame_escape(ecu_fd):
    with RawTp(txid=FD_REQ, rxid=FD_RESP, fd=True) as r:
        # 62 data bytes -> 65 byte response (multi frame); 13 byte ASCII -> FD single frame
        assert r.request(bytes.fromhex("22F18A")) == bytes.fromhex("62F18A") + b"NEXUSCAN-TEST"
        rsp = r.request(bytes.fromhex("22F1F0"))
        assert rsp is not None and len(rsp) == 65


# ============================================================================================
# control interface + golden capture
# ============================================================================================
def test_reload_config_via_sighup(client, ecu):
    cfg = json.loads(DEFAULT_CFG.read_text())
    cfg["timing"]["security_boot_delay_ms"] = 1500
    for d in cfg["dids"]:
        if d["id"] == "0xF190":
            d["ascii"] = "WNX0RELOADED00042"
    original = ecu.cfg_path.read_text()
    try:
        ecu.cfg_path.write_text(json.dumps(cfg))
        assert ecu.reload()["ok"] is True
        assert client.read_data_by_identifier(0xF190).service_data.values[0xF190] == "WNX0RELOADED00042"
        client.change_session(3)
        with pytest.raises(NegativeResponseException) as ei:  # boot delay after (re)start
            client.request_seed(1)
        assert nrc_of(ei) == 0x37

        ecu.cfg_path.write_text("{ broken json")
        ev = ecu.reload()
        assert ev["ok"] is False  # keeps serving the previous configuration
        assert client.read_data_by_identifier(0xF190).service_data.values[0xF190] == "WNX0RELOADED00042"
    finally:
        ecu.cfg_path.write_text(original)
        assert ecu.reload()["ok"] is True
    assert client.read_data_by_identifier(0xF190).service_data.values[0xF190] == VIN


def test_state_reset_via_sigusr1(client, ecu):
    client.change_session(3)
    client.write_data_by_identifier(0xF1A0, bytes.fromhex("11111111"))
    ecu.reset_state()
    assert client.read_data_by_identifier(0xF1A0).service_data.values[0xF1A0] == bytes(4)
    assert client.read_data_by_identifier(0xF186).service_data.values[0xF186] == b"\x01"


def _normalize(lines):
    out, t0 = [], None
    for ln in lines:
        p = ln.split()
        t = float(p[0].strip("()"))
        t0 = t if t0 is None else t0
        cid, _, data = p[2].partition("#")
        out.append(f"({t - t0:010.6f}) {p[1]} {_canon_id(cid)}#{data}")
    return out


_ID_MAP = {f"{REQ:03X}": f"{CANON_REQ:03X}", f"{RESP:03X}": f"{CANON_RESP:03X}"}


def _canon_id(cid: str) -> str:
    """Maps ECUSIM_REQ/ECUSIM_RESP back to the ids the golden files were recorded with."""
    return _ID_MAP.get(cid.upper(), cid)


def _canon_isotp(line: str) -> str:
    p = line.split()
    if len(p) >= 2 and p[1].upper() in _ID_MAP:
        line = line.replace(f"  {p[1]}  ", f"  {_canon_id(p[1])}  ", 1)
    return line


def test_golden_capture_session_security_vin(ecu, tmp_path):
    """Neutral observer (candump) records the bus during a fixed UDS sequence. The frame
    sequence (ids + payload, timestamps ignored) must match tests/hil/golden/."""
    cap = Candump(tmp_path / "golden.candump", filt=f"{REQ:X}:7FF,{RESP:X}:7FF")
    dump = IsoTpDump(tmp_path / "golden.isotpdump")
    with cap, dump:
        with make_client() as c:
            c.change_session(3)
            c.read_data_by_identifier(0xF190)
            c.request_seed(1)
            c.send_key(2, KEY_L1)
            c.write_data_by_identifier(0xF190, "WNX0GOLDENREC0001")
            c.read_data_by_identifier(0xF190)
            c.change_session(1)
    got = _normalize(cap.path.read_text().splitlines())
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text("\n".join(got) + "\n")
        GOLDEN_ISOTP.write_text("\n".join(_canon_isotp(ln) for ln in dump.lines()) + "\n")
    assert GOLDEN.exists() and GOLDEN_ISOTP.exists(), "golden missing (UPDATE_GOLDEN=1)"
    want = [ln.split()[2] for ln in GOLDEN.read_text().splitlines() if ln.strip()]
    assert [ln.split()[2] for ln in got] == want
    assert [_canon_isotp(ln) for ln in dump.lines()] == \
        [ln.rstrip() for ln in GOLDEN_ISOTP.read_text().splitlines() if ln.strip()]
