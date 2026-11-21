# Changelog

All notable changes to NexusCAN are listed here. Format: Keep a Changelog 1.1.0.
Releases are tagged `v<version>-build.<N>`; CI turns the `[Unreleased]` section into the notes of the next
release and the app shows this file under **Help → Changelog**.

## [Unreleased]

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
