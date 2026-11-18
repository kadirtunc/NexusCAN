# NexusCAN Flasher — HIL Validation Plan (`nexus-ecu-sim`)

The NexusCAN ECU flasher (UDS 0x34/0x36/0x37 over ISO-TP) is validated against
targets that share **no code** with it:

| Implementation | ISO-TP | UDS |
| :--- | :--- | :--- |
| NexusCAN flasher (client under test) | `nexus-protocols` / `automotive` | `nexus-protocols` |
| `crates/nexus-ecu-sim` (server, this HIL target) | **Linux kernel `CAN_ISOTP`** | own, written from ISO 14229-1 |
| driftregion `iso14229` (optional 2nd server) | kernel `CAN_ISOTP` | C library |

A bug must therefore show up in two independent implementations at once to
slip through.

---

## Layer 1: vcan0 + simulator + byte compare + fault matrix (every PR)

### Bring-up

```bash
sudo scripts/hil/vcan_up.sh                 # modprobe vcan can_isotp, vcan0 MTU 72, idempotent
# no sudo (e.g. WSL2 without a password): run everything rootless inside a
# user+network namespace — the kernel auto-loads vcan / can_isotp:
scripts/hil/run_hil_tests.sh                # builds, creates vcan0 (sudo or `unshare -rn`), runs all HIL tests
```

`run_hil_tests.sh` sets `NEXUS_HIL_REQUIRE=1`: if the interface is missing,
the tests **fail** instead of skipping, so a run can never pass without
testing anything. A plain `cargo test -p nexus-ecu-sim -- --ignored` without
vcan0 prints `SKIP: CAN interface 'vcan0' not present …` per test.
`NEXUS_HIL_IFACE=can0` points the same tests at a real interface.

### Run the simulator by hand

```bash
cargo run -p nexus-ecu-sim --bin nexus-ecu-sim -- \
  --iface vcan0 --rx 0x7E0 --tx 0x7E8 --functional 0x7DF --padding 0xAA \
  --boot-jump-ms 300 --reboot-ms 200 --sw-version "SW 1.0.0" --new-sw-version "SW 1.1.0" \
  --mem-region 0x08000000:0x80000 --max-block-len 0x402 \
  --seed-algo xor_ff --p2 50 --p2star 5000 --s3 5000 \
  --image-out flash_image.json --log jsonl
# point the NexusCAN flasher at vcan0, 0x7E0/0x7E8, seed provider builtin xor_ff
cargo run -p nexus-ecu-sim --bin nexus-flash-compare -- \
  --source firmware.hex --image flash_image.json        # exit 0 only if byte-for-byte equal
```

jsonl log: every `rx` / `rx-ignored` line carries `addr` (`phys`|`func`), `canId` and `pdu`;
`tx` carries `addr` + `canId`; `boot-jump`/`boot-jump-end` and `reboot`/`boot` bracket the
silent windows.

`nexus-flash-compare` parses Intel HEX (types 00–05), Motorola S-record
(S0/S1–S3/S5/S6/S7–S9, checksums and record count verified) and raw `.bin`
(`--base 0x08000000`). It fails on missing bytes, extra bytes **and** differing
bytes, and prints the first mismatch address (exit 1; exit 2 = parse/usage error).

### Simulated ECU (summary; details in `crates/nexus-ecu-sim/src/server.rs`)

| Service | Behaviour |
| :--- | :--- |
| 0x10 | 01/02/03; Programming only from Extended (else NRC 0x22) unless `--allow-direct-programming`; `50 xx P2(ms) P2*(10 ms units)`; every session change relocks security and aborts a download; entering Programming = **bootloader jump**: positive response, then silent for `--boot-jump-ms` (300), requests meanwhile are discarded (`rx-ignored`) |
| S3 | no request for `--s3` ms in a non-default session: back to Default, relocked |
| 0x11 | 01/02/03, positive response then reboot (`--reboot-ms`, alias `--reset-ms`, 200); requests queued during the reboot are discarded; applies the F189 update armed by a successful FF01 |
| 0x3E | 00 / 80 (suppressPosRsp) |
| 0x27 | 01/02 (Extended+Programming), 11/12 (Programming only, else 0x7E); random 4-byte seed; zero seed when already unlocked; 0x24 key without seed; 0x35 invalid key, 0x36 on the `--max-attempts`th (3), then 0x37 for `--lockout-ms`; the lockout survives resets |
| 0x22 | F186, F187, F188, F189 (`--sw-version`, "SW 1.0.0"), F18C, F190, F191 (`--hw-number`, "HW-NX-01"), F195, F15A/F184 fingerprint (several DIDs per request) |
| 0x2E | F190: Extended/Programming, any unlocked level (else 0x33). F15A (alias F184) fingerprint, 1..64 bytes: Programming only (else 0x7F), unlocked (else 0x33); logged, non-volatile |
| 0x19 / 0x14 | 01, 02 / FFFFFF or a single DTC |
| 0x28 / 0x85 | Extended + Programming |
| 0x31 | `0203` checkProgrammingPreconditions (Extended + Programming, no security): 00, or 01 with `--fault precondition-fail`. `FF00` erase (`ALFID addr len` erases exactly that range, callable per segment with gaps; no args = all regions; needs level `--download-level` 0x11; sends 0x78 every 0.4·P2* while erasing). `0202` with a 4-byte CRC-32/ISO-HDLC is matched against (1) the most recently downloaded segment, (2) any other single segment downloaded since its erase, (3) all segments concatenated in download order (legacy whole-image check) → 00 marks the matched segment(s) verified; mismatch → 01 and the most recent segment is marked failed (sticky until re-erased). No arg → 00 + whole-image CRC, all segments marked verified. `FF01` dependencies: 00 only if no download is active and every segment is verified and not failed (arms F189 = `--new-sw-version` "SW 1.1.0", or the ASCII string at `--sw-version-addr` in the image, applied on the next 0x11). Sub 03 results; FF00/0202/FF01 only in Programming (else 0x31) |
| 0x34 | Programming + unlocked; DFI 00; ALFID nibbles 1..4; range inside one `--mem-region` and erased (else 0x70); `74 20 MMMM` (or `74 40 MMMMMMMM` if > 0xFFFF) |
| 0x36 | BSC starts at 01 and wraps FF→00; a repeat of the last counter is acked without rewriting; wrong counter → 0x73; more data than requested → 0x71; request longer than maxNumberOfBlockLength → 0x13; programming a non-erased byte → 0x72 (NOR-flash semantics) |
| 0x37 | no download → 0x24; fewer bytes received than requested → 0x24 (download stays active); the image is written **before** the 0x77 |
| functional | `--functional` default **0x7DF** (`off` disables). Received on CAN_RAW and decoded as **Single Frame only** (FF/CF logged as `rx-ignored`, no FlowControl); answered on `--tx`. 10/11/3E/22/19/14/28/85 accepted, SPR honoured; NRCs 11/12/31/7E/7F suppressed. 3E 80 (func or phys) restarts S3 in every session |

Seed/key: `xor_ff` (`k = s ^ 0xFF`) and `xor_const[:HEX]` (`k[i] = s[i] ^ C_be[i % 4]`,
default `5A3C1E8F`), identical to the NexusCAN builtin providers.

### Fault matrix (`--fault`, repeatable; each one has a unit and a vcan test)

| Spec | Expected flasher behaviour |
| :--- | :--- |
| `pending78:<sid>:<n>` | follows N× 0x78 using P2*, no premature timeout |
| `slow:<sid>:<ms>` | P2 timeout handling (no 0x78 sent) |
| `silent-after-block:<n>` | detects a dead ECU, aborts cleanly with a clear error |
| `nrc:<sid>:<nrc>:once\|always` | NRC handling / retry policy |
| `wrong-seq-once:<block>` | 0x73 handling (the block is not written; resending the same counter succeeds) |
| `drop-response-once:<block>` | resends the **same** counter after a timeout; the sim acks without a double write (proven by byte compare + CRC) |
| `max-block-len:<n>` | honours the advertised maxNumberOfBlockLength |
| `reset-during-transfer:<block>` | detects the reset (Default session, 0x7F), re-runs the whole sequence |
| `erase-time:<ms>` | long erase handled through repeated 0x78 |
| `precondition-fail` | 31 01 0203 answers status 01; the flow must stop before 10 02 |

`<block>` = 1-based ordinal of a new TransferData block within the download
(not the wrapping counter). One-shot faults fire once per simulator process.

**Acceptance for the flasher (Layer 1):** for every row, run the flasher
against `nexus-ecu-sim --fault <spec>` and require either `nexus-flash-compare`
exit 0 or the documented clean failure, plus a no-fault run with a > 256-block
image (counter wrap) on both classical and padded (`--padding 0xAA`) links.

### Optional second target: iso14229

`scripts/hil/iso14229_crosscheck.sh` fetches driftregion/iso14229 (pinned
`d018adc`), builds its Linux RDBI/WDBI example server and sends the same
generic probes to it and to `nexus-ecu-sim`. TesterPresent, SPRMIB suppression
and NRCs 0x11/0x12/0x13 must agree (they do). **TODO:** iso14229 ships no Linux
flash server (its `fwupdate` example is Zephyr/MCUBoot only). Writing C
handlers for `UDS_EVT_RequestDownload/TransferData/RequestTransferExit` would
add a second, fully independent flash target.

---

## Layer 2: BeagleBone Black over a CANable at 500 kbit/s

```
 PC / WSL2 (NexusCAN flasher)          BeagleBone Black (nexus-ecu-sim)
 CANable (gs_usb/candleLight) ── CAN_H ──── CAN cape transceiver ── DCAN1 (P9.24 RX / P9.26 TX)
        120 Ω jumper ON      ── CAN_L ────  120 Ω on the cape/bus end
                             ── GND  ─────  GND (common ground is mandatory)
```

* **Transceiver:** the AM335x DCAN pins are 3.3 V logic. If the CAN cape has no
  transceiver, use an SN65HVD230/231/232-class 3.3 V part (never connect
  CANH/CANL straight to the SoC pins, and never use a 5 V-only TJA1050 on the
  RX pin without level shifting).
* **Termination:** 120 Ω at **both** physical ends (CANable jumper + cape or an
  inline resistor). With power off, CANH–CANL should measure about 60 Ω.
* **Bitrate:** 500 kbit/s classical CAN. AM335x DCAN cannot do CAN FD, so do
  not use `--fd` on the BBB.

### BBB side

```bash
# on the PC: build a fully static ARMv7 binary (no glibc mismatch on old images)
scripts/hil/build_ecu_sim_bbb.sh            # musl + rust-lld; or --cross / --gnu
scp $CARGO_TARGET_DIR/armv7-unknown-linux-musleabihf/release/{nexus-ecu-sim,nexus-flash-compare} \
    scripts/hil/bbb_can_setup.sh debian@beaglebone.local:~/
# on the BBB:
sudo ./bbb_can_setup.sh can1 500000         # config-pin P9.24/P9.26 can, bitrate, restart-ms 100, up
sudo ./bbb_can_setup.sh can1 500000 --run --fault erase-time:3000   # setup + start the simulator
```

DCAN0 alternative: P9.19 (RX) / P9.20 (TX), which share pins with I2C2, the
cape EEPROM bus (`sudo ./bbb_can_setup.sh can0`). The BBB kernel needs
`CONFIG_CAN_ISOTP` (mainline ≥ 5.10; current Debian 11/12 BBB images with
5.10-ti / 6.1-ti kernels have it). The setup script warns if it is missing.

### PC side (WSL2)

```powershell
# Windows, elevated PowerShell (usbipd-win):
usbipd list
usbipd bind   --busid <BUSID>     # once
usbipd attach --wsl --busid <BUSID>
```

```bash
# WSL2: the CANable (candleLight firmware) enumerates through gs_usb as can0
sudo modprobe gs_usb
sudo ip link set can0 type can bitrate 500000 restart-ms 100 && sudo ip link set can0 up
candump -c can0      # sanity check: start the sim on the BBB, then send 3E 00 from the flasher
```

If the CANable runs slcan firmware instead, use `slcand -o -s6 -t hw /dev/ttyACM0 can0`.
After the flash, copy `flash_image.json` back from the BBB and run
`nexus-flash-compare` on the PC (or run it on the BBB itself).
(`NEXUS_HIL_IFACE` only retargets the Layer-1 tests, which spawn the simulator
locally; on a real interface their traffic loops back on the PC and never
crosses the bus. Layer 2 means the NexusCAN flasher on the PC talking to the
simulator on the BBB.)

Checks on the real bus (`ip -details -statistics link show can0` on both
ends): no `ERROR-PASSIVE`/`BUS-OFF`, TX/RX error counters at 0, and the same
fault matrix as Layer 1 with real timing (at 500 kbit/s a 1026-byte block is
≈ 147 frames ≈ 35–40 ms of bus time).

---

## Layer 3 (future): real MCU bootloader

Same sequence and fault expectations against a production-style bootloader
(e.g. STM32 with a UDS bootloader, or the iso14229 `fwupdate` example on a
NUCLEO-G474RE), comparing a flash read-back (0x35 RequestUpload or SWD dump)
with `nexus-flash-compare --source fw.hex --image <readback converted to image JSON>`.
