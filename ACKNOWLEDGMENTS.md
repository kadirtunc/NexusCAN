# Open-Source Acknowledgments & Community Respect

**NexusCAN** and **NexusCANCloud** stand on the shoulders of decades of open-source engineering in the automotive, robotics, Linux kernel, Rust, and web ecosystems. We built our own clean-room compilers, codecs, and telemetry pipelines from scratch, and we owe deep gratitude to the open-source pioneers whose work taught, inspired, and empowered the entire CAN bus community.

---

## 1. CAN Bus, Automotive & Telemetry Pioneers

Special respect and gratitude to the maintainers and contributors of:

- **[Linux SocketCAN & `linux-can/can-utils`](https://github.com/linux-can/can-utils)** — Oliver Hartkopp, Marc Kleine-Budde, Urs Thuermann, and the Linux kernel networking community for making CAN / CAN-FD a first-class network citizen on Linux.
- **[SavvyCAN](https://github.com/collin80/SavvyCAN)** *(Collin Kidder & contributors, MIT)* — For showing generations of EV builders, reverse engineers, and hobbyists what an accessible cross-platform CAN reverse-engineering and analysis tool can be.
- **[cantools](https://github.com/cantools/cantools)** *(Erik Moqvist & contributors, MIT)* & **[canmatrix](https://github.com/ebroecker/canmatrix)** *(Eduard Bröcker & contributors, BSD-2-Clause)* — For advancing community understanding and interoperability around `.dbc`, `.kcd`, and automotive network description formats.
- **[Kayak (`.kcd`)](https://github.com/dschanoeh/Kayak)** *(Jan-Niklas Meier, LGPLv3 spec/schema)* — For introducing an open, human-readable XML network definition format (`.kcd`) to the CAN ecosystem.
- **[PlotJuggler](https://github.com/facontidavide/PlotJuggler)** *(Davide Faconti, MPL-2.0)* — For setting the engineering bar on high-frequency time-series signal visualization in robotics and embedded systems.
- **[Candlelight / `gs_usb`](https://github.com/candle-usb/candleLight_fw)** *(Hubert Denkmair & the open hardware CAN community)* — For democratizing affordable, open-firmware USB CAN and CAN-FD adapters worldwide.

---

## 2. Core Rust & WebAssembly Engine (`nexus-core`, `nexus-netdb`, `nexus-hal`, `nexus-cloud`)

- **[Rust Programming Language](https://www.rust-lang.org/)** *(MIT / Apache-2.0)*
- **[Tokio](https://github.com/tokio-rs/tokio)** & **[Axum](https://github.com/tokio-rs/axum)** *(MIT)* — High-concurrency async runtime and WebSocket/HTTP transport.
- **[Winnow](https://github.com/winnow-rs/winnow)** *(MIT)* & **[Quick-XML](https://github.com/tafia/quick-xml)** *(MIT)* — Zero-copy combinator and XML foundations behind our clean-room `.dbc` and `.kcd` parser stages.
- **[Serde](https://github.com/serde-rs/serde)** *(MIT / Apache-2.0)*, **[parking_lot](https://github.com/Amanieu/parking_lot)** *(MIT / Apache-2.0)*, **[crossbeam](https://github.com/crossbeam-rs/crossbeam)** *(MIT / Apache-2.0)*.
- **[socketcan-rs](https://github.com/socketcan-rs/socketcan-rs)** *(MIT)* & **[serialport-rs](https://gitlab.com/susurrus/serialport-rs)** *(MPL-2.0)*.
- **[Tauri](https://github.com/tauri-apps/tauri)** *(MIT / Apache-2.0)* & **[wasm-bindgen](https://github.com/rustwasm/wasm-bindgen)** *(MIT / Apache-2.0)* — Enabling 100% bit-identical signal decoding across native desktop and cloud WebAssembly workers.

---

## 3. Cloud, Time-Series & Ergonomic Web Stack

- **[PostgreSQL](https://www.postgresql.org/)** *(PostgreSQL License)* & **[TimescaleDB](https://github.com/timescale/timescaledb)** *(Apache-2.0 / TSL)* — Time-series hypertables and peak-preserving `time_bucket()` signal envelopes.
- **[PGlite](https://github.com/electric-sql/pglite)** *(ElectricSQL, Apache-2.0)* — Zero-dependency embedded PostgreSQL 17 WASM engine for instant local development and CI verification.
- **[Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)** *(Apache-2.0)*, **[Better Auth](https://github.com/better-auth/better-auth)** *(MIT)*, **[Zod](https://github.com/colinhacks/zod)** *(MIT)*.
- **[Next.js](https://github.com/vercel/next.js)** *(MIT)*, **[React](https://github.com/facebook/react)** *(MIT)*, **[Zustand](https://github.com/pmndrs/zustand)** *(MIT)*, **[TanStack Virtual](https://github.com/TanStack/virtual)** *(MIT)*, **[Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)** *(MIT)*, **[Lucide Icons](https://github.com/lucide-icons/lucide)** *(ISC)*.
- **[OpenStreetMap](https://www.openstreetmap.org/copyright)** *(© OpenStreetMap contributors, ODbL)* — Map tile data powering GNSS / GPS telemetry panels.

---

## 4. Independent Project & Trademark Notice

**NexusCAN**, **NexusCANCloud**, and **DBC Studio** are independent open-source software projects licensed under the [MIT License](./LICENSE) (`Copyright (c) 2026 Kadir Tunç`).

They are **not affiliated with, endorsed by, sponsored by, or derived from** Vector Informatik GmbH, PEAK-System Technik GmbH, Kvaser AB, SAE International, or CAN in Automation (CiA). Any third-party product names, file extensions, or protocol standards (such as CAN, CAN-FD, ISO 11898, SAE J1939, CANopen, `.dbc`, `.kcd`, or `.asc`) are referenced strictly for technical interoperability identification; all respective trademarks belong to their owners.
