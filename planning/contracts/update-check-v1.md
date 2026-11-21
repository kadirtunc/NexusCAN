# Kontrat: update-check-v1 — GitHub Release Bildirimi (yalnız kontrol + bildirim)

Durum: AKTİF · Sahip: team-lead · Tarih: 2026-11-21
Kullanıcı kararı: **Otomatik indirme/kurma YOK.** Yalnızca bildirim, sürüm notları ve Releases bağlantısı.

## 1. Kaynak
- Repo: `kadirtunc/NexusCAN`. Tag biçimi: `v<semver>-build.<N>` (CI `GITHUB_RUN_NUMBER`). Sürüm şu an hep `0.1.0`;
  "yeni mi?" kararı **build numarası** (N) ile verilir, eşitse semver ile.
- API: `GET https://api.github.com/repos/kadirtunc/NexusCAN/releases?per_page=15` (draft/prerelease hariç).
  Header: `User-Agent: NexusCAN/<version>`, `Accept: application/vnd.github+json`. Token YOK (anonim, 60 istek/saat).
- Releases sayfası: `https://github.com/kadirtunc/NexusCAN/releases`.

## 2. Build numarası gömme (team-lead CI + backend)
- CI paketleme adımında env `NEXUS_BUILD_NUMBER=${{ github.run_number }}`.
- `src-tauri/build.rs`: `cargo:rerun-if-env-changed=NEXUS_BUILD_NUMBER`.
- Kod: `option_env!("NEXUS_BUILD_NUMBER").and_then(|s| s.parse::<u32>().ok())` → yerel/dev build'de `None`.

## 3. Backend (`src-tauri/`)
```rust
#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")]
pub struct ReleaseInfoDto {
    pub tag: String,            // "v0.1.0-build.19"
    pub name: String,           // release title
    pub version: String,        // "0.1.0"
    pub build: u32,             // 19
    pub published_at: String,   // ISO-8601 (GitHub)
    pub notes_markdown: String, // release body, max 16 KiB (UTF-8 sınırında kırp)
    pub html_url: String,       // release sayfası
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub current_version: String,          // env!("CARGO_PKG_VERSION") veya tauri.conf version
    pub current_build: Option<u32>,       // None = dev build
    pub update_available: bool,           // current_build Some && latest.build > current
    pub latest: Option<ReleaseInfoDto>,
    pub newer_releases: Vec<ReleaseInfoDto>, // current'tan yeni olanlar, yeni→eski, en fazla 10 (dev'de: yalnız latest)
    pub releases_page_url: String,
}
#[tauri::command] async fn cmd_check_for_update() -> Result<UpdateCheckDto, AppError>
#[tauri::command] async fn cmd_open_release_page(url: Option<String>) -> Result<(), AppError>
```
- HTTP: workspace `ureq` 3 (rustls), toplam timeout 8 s, `spawn_blocking`/`run_blocking` ile; UI thread ve CAN hot-path'e dokunmaz.
- Tag ayrıştırma: `^v(\d+\.\d+\.\d+)-build\.(\d+)$`; eşleşmeyen tag yok sayılır. Ağ hatası → `AppError` (anlamlı mesaj:
  çevrimdışı / rate limit 403 / zaman aşımı).
- `cmd_open_release_page`: URL `None` → releases sayfası. `Some(u)` yalnızca
  `https://github.com/kadirtunc/NexusCAN/releases` önekiyle başlıyorsa açılır; değilse hata. Sistem tarayıcısında
  açma: `tauri-plugin-opener` **Rust API** (JS izni VERİLMEZ) ya da eşdeğer güvenli crate.
- ACL: komutlar `app_commands.rs` + `src-tauri/permissions/*.toml` içinde yeni `updates` seti; `capabilities/default.json`'a
  `"updates"`. Hiçbir `core:*`/plugin JS izni eklenmez. CSP değişmez.
- Birim testi: tag ayrıştırma, karşılaştırma (dev/None, eşit, eski, yeni), notes kırpma (çok baytlı karakter sınırı),
  URL beyaz liste.

## 4. Frontend (`src/`)
- `ipcClient.ts`: `apiCheckForUpdate(): Promise<UpdateCheckDto>`, `apiOpenReleasePage(url?: string)`; TS tipleri birebir.
  Tauri yoksa (tarayıcı modu) özellik sessizce devre dışı.
- `src/store/updateStore.ts` (localStorage `nexuscan.updates.v1`): `{ autoCheck: boolean (vars. true), lastCheckedAtMs,
  dismissedBuild: number | null }`. Açılıştan 5 s sonra, `autoCheck` açık ve son kontrol > 24 saat ise kontrol et.
- Bildirim: sağ altta küçük, animasyonsuz, kapatılabilir kart: "NexusCAN build {N} hazır" · [Sürüm Notları] [Releases] [×].
  × → `dismissedBuild = N` (o build için bir daha gösterme; daha yeni build gelirse yine göster).
- Sürüm Notları dialogu: `newerReleases` listesi (her biri başlık, tarih `font-mono tabular-nums`, notlar), "Releases'ta aç"
  butonu, "Açılışta otomatik denetle" anahtarı, "Şimdi denetle" butonu, mevcut sürüm/build satırı (dev build ise "geliştirme
  sürümü"). Markdown: bağımlılık yok, HTML enjeksiyonu yok — basit satır işleme (başlık `#`, madde `- `, `code`,
  tablolar `pre` olarak). Linkler tıklanınca yalnız `apiOpenReleasePage(url)` ile.
- Yardım menüsü (`TopBar.tsx` Help): "Güncellemeleri denetle…" → dialogu açar ve hemen kontrol eder.
- i18n: yeni shard `src/i18n/shards/updates.ts` (`upd.*`, TR+EN birebir), `i18n/index.ts` kaydı.
- Renk: yalnız tema token'ları (`theme-tokens-v1`); `npm run lint:theme` PASS. `any`, blur, animasyon yok.

## 5. CI (team-lead)
- Release notlarına "What's changed": önceki `v*-build.*` tag'inden bu yana commit başlıkları (`git log --no-merges
  --pretty='- %s (%h)'`), checkout `fetch-depth: 0`.

## 6. Kontrol Listesi
- [ ] Çevrimdışıyken uygulama açılışı gecikmez/hata pop-up'ı çıkmaz (otomatik kontrol hatası sessiz; manuel kontrolde mesaj).
- [ ] Dev build (`current_build = None`) bildirim göstermez; dialogda latest bilgisi görünür.
- [ ] Kontrol hot-path / 60 Hz telemetri thread'lerini bloklamaz.
- [ ] Yalnız GitHub releases URL'leri açılabilir.
