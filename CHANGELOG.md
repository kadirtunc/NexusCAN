# Changelog

All notable changes to NexusCAN are listed here. Format: Keep a Changelog 1.1.0.
Releases are tagged `v<version>-build.<N>`; CI turns the `[Unreleased]` section into the notes of the next
release and the app shows this file under **Help → Changelog**.

## [Unreleased]

### Added
- **Trace: Open in new window.** Move a Trace session into its own viewer while it records. Close the viewer or choose Return to main window to redock.
- **Receive/Transmit context menus.** Add or edit TX drafts, copy received frames, add decoded signals to Watch, hide live rows, and edit or delete the TX entry under the pointer.
- **Context menus.** Right-click Trace, RX/TX, Connections and Plotter for local actions or a one-time browser menu.
- **MCP: Arm Active Bus requests.** MCP can request Active Bus for one connected channel. NexusCAN requires fresh desktop approval and leaves the saved profile unchanged.
- **DBC Studio: Edit DB.** Each database row now has an **Edit DB** button that opens a full DBC editor (messages,
  signals, ECUs, value tables, bit matrix and communication matrix) with Save (overwrite) and Save As.
- **DBC editor: drag signals in the bit matrix.** Grab a signal cell and drop it on another bit to change its start bit;
  a ghost preview shows the new position, overlaps (warning) and out-of-range drops (blocked). Esc cancels.
- **DBC editor: multiplexer page selector.** The bit matrix now has a page combobox per multiplexer switch (including
  cascaded sub-switches); it shows only the signals active on the chosen page, or all pages overlaid.
- **DBC editor: Network Nodes graph.** The ECUs view has a Table | Graph toggle; the graph shows which ECU transmits
  to which (TX solid, RX dashed), a hover tooltip lists the messages, a right-hand details sidebar shows each ECU's incoming and outgoing
  messages and signals (or an edge's messages), optional edge labels, and node positions are remembered.
- **CSS Electronics CANsub.2 / CANsub.4 support.** Connect over USB or Ethernet on Windows, macOS and Linux, with
  hardware timestamps and device-enforced Listen-Only. Devices are found automatically (mDNS) or added by host/IP and
  Device ID; Panic Stop also clears the device's TX queue and periodic jobs. The sample point is picked
  automatically (closest to 80 %), so CAN-FD settings such as 500 kbit/s / 5 Mbit/s open; replayed frames never hide
  the TX confirmation of your own frames in the trace. Bitrate combinations the device cannot run are greyed out in
  the connection dialog.
- **`nexuscan cansub-selftest <host>`.** Command-line acceptance test for CSS Electronics CANsub devices: Listen-Only
  receive statistics, clock offset and error frames as a JSON report, plus an optional two-channel TX loopback.

### Changed
- **Trace performance.** Active filters process new frames incrementally. Restbus builds its message list when open, and Pause holds the capture buffer in place.
- **Top menu bar.** Language selection uses a dropdown. Toolpacks, MCP and About & Open Source Licenses sit in the upper-right control group.
- **Theme switch** moved next to the language selector in the upper-right corner.
- **Receive/Transmit row controls.** Click to select, use the disclosure arrow or left/right keys to collapse or expand, and press Ctrl+A to select visible messages in the focused pane. Open an RX message in DBC Studio from its context menu.
- **RX and Bus Load indicators** refresh every 500 ms.

### Fixed
- **Trace scrolling.** Pause keeps the current viewport, and scrolling back while recording disengages auto-scroll.
- **Connection indicators.** RX, TX and Load show zero when no CAN bus is connected.
- **Receive multi-selection.** Copy every selected valid frame to TX, paste multiple frame lines, or remove the selected rows from the live Receive list.
- **Middle-click navigation** is disabled so the mouse wheel button uses its default behavior.
- **Connections: deleting an active profile.** The bus disconnects before its profile is removed, including test simulators.
- **Connections: CANsub profiles.** Select CSS Electronics CANsub in the Connection Profile Editor and save a discovered or manually probed channel.
- **DBC editor: false bit-overlap warnings.** Multiplexed signals on different pages that share bits are no longer
  flagged as overlapping.

## [0.1.0 build 38] — 2026-11-21

### Added
- **AI co-pilot (MCP server).** A built-in, read-only Model Context Protocol (MCP)
  server lets an assistant such as Claude Code read live bus data, traces, the loaded DBC, diagnostics, RE results
  and project history: 46 tools in 8 groups, including a UI co-pilot that can switch tabs, select messages, set the
  Trace filter and add signals to the Plotter. Off by default; start it from the `MCP` indicator in the status bar.
  The (i) button in the MCP panel lists every tool with a description.
- **Guided onboarding.** **Start Tour** walkthroughs and re-openable (i) info dialogs on Workspace, Receive / Transmit,
  Connections, Trace, Plotter, DBC Studio, Simulation and Cloud.
- **Getting Started panel** on Workspace: five steps (project → connection → why TX is locked → DBC → panels) with
  live progress, **Go** and **Details** buttons. It can be collapsed with ×; **Start Tour** stays available.
- **"Why can't I transmit?"** links next to the Listen-Only / TX-locked indicators explain Listen-Only, Arm Active,
  Panic Stop and clearing the Panic latch.
- **Update notifications.** NexusCAN checks GitHub Releases (at most once a day, can be turned off), shows a
  **build N ready** card, release notes and a link to the Releases page. Nothing is downloaded or installed.
  Manual check: **Help → Check for updates…**.
- **Version label** in the status bar (`v0.1.0 · build N`) with a **New update available** badge.
- **Changelog** in the app: **Help → Changelog…**.
- **UI Scale** (90 / 100 / 110 / 125 %) under the View menu.

### Changed
- **Top bar on high-DPI screens.** The three header rows keep a fixed height at every width (tested 1280–2560 px,
  e.g. 3200×2000 at 175 %). Labels collapse to icons and low-priority controls move into a `⋯` menu instead of
  wrapping. Panic Stop, TX mode and the backend status are never hidden. The tab strip scrolls with arrows.
- **One colour system.** Every colour comes from the dark / light theme tokens; Toolpacks, MCP, top bar,
  Workspace, project explorer, Connections and DBC Studio no longer use off-theme blue tones and follow the light
  theme correctly.
- Status indicators in Connections and Trace no longer animate.

### Fixed
- Top-bar buttons wrapped onto a second line on scaled displays.

### Security
- MCP server: `127.0.0.1` only, a fresh random token on every start, loopback `Host` / `Origin` check, every call
  audited in the Debug Console, SecurityAccess / Authentication data redacted. No MCP tool can transmit, arm a bus,
  run UDS services, flash or write files.
- Update check: only `github.com/kadirtunc/NexusCAN/releases` pages can be opened; the UI gets no general
  URL-opening permission.

### Developer
- `npm run lint:theme` gate (hard-coded colours may only decrease); CI release notes now include this changelog
  section and a **What's changed** commit list.
- CI stability: TX write-barrier and cycle-health tests no longer fail on paused macOS runners (production barrier
  bound unchanged at 250 ms); `nexus-hal` timing tests run one at a time in CI; Windows-safe temp paths in the MCP
  tests.

## [0.1.0 build 18] — 2026-11-20

### Changed
- NexusCloud removed from the public build (feature flag compiled off, View-menu toggle removed).

### Fixed
- Clean first start: no stale buses, Debug Console closed; About dialog follows the theme.

## [0.1.0 build 14] — 2026-11-20

First public build: CAN / CAN-FD analyzer with Receive / Transmit, Trace, Plotter, DBC Studio, Simulation,
UDS diagnostics workbench, Reverse Engineering and Flow Editor for Linux, Windows and macOS.
