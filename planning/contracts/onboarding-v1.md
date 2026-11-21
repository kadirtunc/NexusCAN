# Kontrat: onboarding-v1 — İlk Kullanım Yönlendirmesi & Yardım Sistemi

Durum: TASLAK (kullanıcı onayı bekliyor) · Sahip: team-lead · Tarih: 2026-11-21

## 0. Problem
İlk kez açan kullanıcı 10 sekme (Workspace, RX/TX, Trace, Plotter, DBC Studio, Connections,
Simulation, Cloud, Diagnostics, RE) ile karşılaşıyor; "nereden başlarım / donanımım yok / neden TX
gönderemiyorum (Listen-Only)" sorularına uygulama içinde cevap yok. Örnek DBC/trace yalnızca
`test/` altında; paketlenmiş uygulamada yok → "donanımsız dene" yolu kurulamıyor.

## 1. Hedef (Kabul Ölçütü)
Hiç donanımı olmayan yeni kullanıcı, uygulamayı ilk açışından itibaren **≤ 3 dakikada** ve
**dışarıdan doküman okumadan**: mock0'a bağlanır → örnek DBC yükler → Trace'te çözülmüş sinyal
görür → Plotter'da bir sinyal çizer. Aktif TX'e geçişte güvenlik modelini (Listen-Only → Arm Active
→ Panic Stop) uygulama içinde öğrenir.

## 2. Katmanlar
| # | Katman | Açıklama |
|---|---|---|
| L1 | **Welcome / Quick Start** | İlk açılışta (veya Yardım → "Başlangıç Rehberi") 3 yol: ① Donanımsız dene (mock0 + örnek DBC, tek tık) ② Donanımımı bağla (sürücü/OS'e göre adım listesi + "bulunamadı" sorun giderme) ③ Kayıt dosyası aç (.blf/.asc/.trc/.log). "Bir daha gösterme" kalıcı. |
| L2 | **Rehberli Turlar (Coach Marks)** | Sekme başına 3–6 adımlık spotlight turu. `data-tour="<id>"` çapaları. Animasyonsuz, `backdrop-blur` YOK (SVG mask / box-shadow cutout). Klavye: →/←/Esc. Sekme ilk ziyarette "Turu başlat?" küçük şeridi. |
| L3 | **Bağlamsal Boş Ekranlar** | Veri yokken her görünüm sebep + tek eylem gösterir: "Bağlantı yok → mock0'a bağlan", "DBC yok → Örnek DBC yükle / DBC aç", "Trace oturumu yok → Kaydı başlat". |
| L4 | **Yardım Merkezi (F1)** | Sağ dock / modal: aranabilir konu listesi, Klavye Kısayolları, Güvenlik Modeli, CAN/CAN-FD/J1939/UDS sözlüğü (DLC, BRS, ESI, mux, PGN, DID…), Sorun Giderme (vcan/WSL2, izinler, sürücü DLL yok). Tamamen offline, i18n TR/EN. Aktif sekmeye göre ilgili konu üstte. |
| L5 | **InfoHint (?)** | Jargon alanlarının yanında küçük `?` → popover (kısa açıklama + "Yardım Merkezinde aç"). Native `title` yerine erişilebilir bileşen. |
| L6 | **Güvenlik Eğitimi Kapısı** | İlk "Arm Active Bus" denemesinde açıklayıcı onay modalı (Listen-Only nedir, ACK etkisi, Panic Stop nerede). Onay sonrası bir daha gösterilmez; Panic Stop asla gizlenmez. |
| L7 | **Kullanıcı Kılavuzu (repo)** | `docs/user-guide/{en,tr}/`: quickstart, connections, dbc, trace, plotter, tx-safety, diagnostics, re, troubleshooting. README'den bağlantı. Uygulama içi içerikle aynı kaynak başlıklar. |

## 3. Veri Kontratları

### 3.1 Frontend — `src/store/onboardingStore.ts` (yeni)
```ts
export const ONBOARDING_SCHEMA_VERSION = 1;
export type TourId =
  | 'shell' | 'connections' | 'rxtx' | 'trace' | 'plotter' | 'dbcStudio'
  | 'simulation' | 'diagnostics' | 're';
export type QuickStartPath = 'demo' | 'hardware' | 'replay';
export interface OnboardingState {
  schemaVersion: number;
  welcomeDismissed: boolean;          // "Bir daha gösterme"
  completedTours: readonly TourId[];
  declinedTourPrompts: readonly TourId[];
  safetyBriefingAcked: boolean;       // L6
  activeTour: { id: TourId; step: number } | null; // kalıcı DEĞİL
  helpCenterOpen: boolean;            // kalıcı DEĞİL
  helpTopicId: string | null;
}
// API: startTour, nextStep, prevStep, endTour(completed), dismissWelcome, resetOnboarding,
//      ackSafetyBriefing, openHelp(topicId?), closeHelp
```
- Kalıcılık: `localStorage['nexuscan.onboarding.v1']`; şema sürümü uyuşmazsa varsayılana dön.
- Mevcut store desenini (`useSyncExternalStore`, bkz. `mcpUiOverlayStore.ts`) izle; yeni bağımlılık yok.

### 3.2 Tur tanımı — `src/onboarding/tours.ts`
```ts
export interface TourStep {
  anchor: string;              // data-tour değeri; DOM'da yoksa adım atlanır (kırılmaz)
  titleKey: string;            // i18n anahtarı: onboarding.tour.<tour>.<n>.title
  bodyKey: string;
  placement: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  requiresTab?: ActiveDocumentTab; // gerekirse sekmeye geçer
}
export const TOURS: Record<TourId, readonly TourStep[]>;
```

### 3.3 Yardım içeriği — `src/onboarding/helpTopics.ts`
```ts
export type HelpCategory = 'start' | 'safety' | 'connections' | 'database' | 'analysis'
  | 'transmit' | 'diagnostics' | 're' | 'shortcuts' | 'glossary' | 'troubleshooting';
export interface HelpTopic {
  id: string; category: HelpCategory;
  titleKey: string; bodyKeys: readonly string[];   // paragraf dizisi, HTML/markdown YOK
  relatedTabs: readonly ActiveDocumentTab[];
  action?: { labelKey: string; kind: 'openTab' | 'startTour' | 'loadDemo'; arg?: string };
}
```
- Metinler yeni i18n shard'larında: `src/i18n/shards/onboarding.ts` (wizard+tour+hint),
  `src/i18n/shards/helpCenter.ts` (konular+sözlük). TR ve EN anahtar kümesi birebir aynı (test ile).
- Terim politikası: özellik adları İngilizce kalır (Trace, Plotter, Diagnostics…; bkz. c86b7d9).

### 3.4 Backend — örnek varlıklar (`src-tauri/`)
- `tauri.conf.json > bundle.resources`: `samples/demo_ev_powertrain.dbc`, `samples/demo_drive_cycle.blf`
  (kaynak: `test/databases/ev_powertrain_full_test.dbc`, `traces/ev_drive_cycle_canfd.blf`;
  boyut ≤ 2 MB, değilse kırpılmış kopya).
- Yeni komut (salt-okunur, capability'ye eklenir):
```rust
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct SampleAssetsDto { demo_dbc_path: String, demo_trace_path: String, mock_device_id: String }
#[tauri::command] fn onboarding_sample_assets(app: AppHandle) -> Result<SampleAssetsDto, String>
```
  - `app.path().resolve(.., BaseDirectory::Resource)`; dev modunda repo yoluna düşer. Hot-path'e dokunmaz.
- "Donanımsız dene" akışı yalnızca **mevcut** komutları zincirler (mock0 connect → DBC load → Trace tab);
  mock0 Listen-Only kuralına uyar, TX açmaz.

## 4. Kısıtlar (Kırmızı Çizgiler)
- Animasyon yok (en fazla 100 ms opacity), `backdrop-blur` yok, `any` yok, Tauri v1 API yok.
- Tur/overlay 60 Hz telemetri akışını bloklamaz: overlay `position:fixed` tek katman, `getBoundingClientRect`
  yalnızca adım değişiminde + `resize` (rAF throttle), telemetri aboneliği YOK.
- Onboarding hiçbir zaman TX'i otomatik açmaz; Panic Stop overlay altında da tıklanabilir kalır (z-index).
- Mevcut kullanıcılar: `welcomeDismissed` yoksa ama localStorage'da proje/son-proje varsa Welcome
  otomatik açılmaz, yalnızca küçük "Başlangıç rehberi" şeridi gösterilir.
- Erişilebilirlik: odak tuzağı (focus trap) modal/turda, `aria-live` adım metni, Esc her yerde kapatır.

## 5. İş Bölümü (Dalgalar)
**Dalga 0 (team-lead):** bu kontrat + boş shard dosyaları ve `i18n/index.ts` kaydı + `onboardingStore` tip iskeleti
(paralel ajanlar aynı index'i düzenlemesin diye).

**Dalga 1 (paralel):**
| Ajan | Kapsam | Dosyalar |
|---|---|---|
| backend-dev | §3.4 örnek varlıklar + komut + capability + birim testi | `src-tauri/tauri.conf.json`, `src-tauri/src/commands/onboarding.rs`, `capabilities/default.json` |
| frontend-dev A | Store impl + Tur motoru (Spotlight overlay) + Welcome/QuickStart (L1, L2 motoru, L6) + Yardım menüsü/F1 bağlama | `src/store/onboardingStore.ts`, `src/onboarding/{TourOverlay,WelcomeWizard,SafetyBriefingModal}.tsx`, `TopBar.tsx` (yalnız Help menüsü), `App.tsx` (mount + F1) |
| frontend-dev B | Yardım Merkezi + içerik + sözlük + kısayol sayfası + InfoHint (L4, L5) | `src/onboarding/{HelpCenter,InfoHint}.tsx`, `helpTopics.ts`, `shards/helpCenter.ts` |

**Dalga 2:** frontend-dev C — `data-tour` çapaları + 9 tur içeriği (`tours.ts`, `shards/onboarding.ts`) +
boş ekranlar (L3) görünüm dosyalarında. (Çok dosyaya dokunduğu için Dalga 1 bitince.)

**Dalga 3:** L7 kullanıcı kılavuzu (docs/user-guide en+tr) + README bağlantıları.

**QA:** her dalga sonrası hafif kapı (sonnet: `tsc`, vitest, değişen dosya incelemesi, `cargo test -q -p` ilgili);
sonda tam kapı (opus): §1 senaryosu uçtan uca, 50k fps mock0 altında tur açıkken `dropped_frames == 0` ve
FPS ≥ 58, TR/EN anahtar eşitliği, Panic Stop'un overlay altında erişilebilirliği.

## 6. Kontrol Listesi (uygulayıcı teslimden önce doğrular)
- [ ] Tüm metinler i18n'de; TR/EN anahtar kümesi eşit (`onboarding.i18n.test.ts`).
- [ ] DOM'da olmayan çapa adımı atlanıyor, tur çökmüyor.
- [ ] Overlay açıkken Panic Stop tıklanabilir.
- [ ] `localStorage` bozuk JSON → varsayılan durum, hata yok.
- [ ] Sayısal örnek değerlerde `font-mono tabular-nums`.
- [ ] `npx tsc -p tsconfig.app.json --noEmit` temiz, `any` yok.

---
## 7. PİLOT (aktif kapsam) — Yalnızca Receive / Transmit sayfası · driver.js
Kullanıcı kararı (2026-11-21): tur motoru **driver.js ^1.14** (kuruldu). Önce yalnız `rxtx` sekmesi; beğenilirse
§5 dalgaları diğer sayfalara (proje → connection → TX güvenliği → DBC → panel sırası) yayılır. Diagnostics iç
yönlendirmeleri sonraya. Backend (§3.4) pilotta YOK.

### 7.1 Tekrar kullanılabilir altyapı (diğer sayfalar için de aynı kalacak)
- `src/onboarding/types.ts`:
```ts
export type GuidePageId = 'rxtx'; // ileride: 'start' | 'connections' | 'symbols' | 'panels' | ...
export interface GuideTourStep { anchor: string; titleKey: TranslationKey; bodyKey: TranslationKey;
  side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'start' | 'center' | 'end'; }
export interface GuideInfoSection { headingKey: TranslationKey; bodyKeys: readonly TranslationKey[]; }
export interface GuidePageDef { id: GuidePageId; tab: ActiveDocumentTab; titleKey: TranslationKey;
  tour: readonly GuideTourStep[]; info: readonly GuideInfoSection[]; tips: readonly TranslationKey[]; }
```
- `src/onboarding/registry.ts` → `GUIDE_PAGES: Record<GuidePageId, GuidePageDef>`.
- `src/onboarding/driverTour.ts` → `startPageTour(id)`: `driver({ animate:false, smoothScroll:false,
  allowClose:true, showProgress:true, overlayOpacity:0.6, popoverClass:'nx-tour' })`; çapa
  `[data-tour="…"]`, DOM'da yoksa adım filtrelenir; buton metinleri i18n.
- `src/onboarding/driverTheme.css` → koyu endüstriyel tema (`.nx-tour`), blur/animasyon yok, sayılar
  `font-mono tabular-nums`.
- `src/store/onboardingStore.ts` → `localStorage['nexuscan.onboarding.v1']`: `{ schemaVersion:1,
  seenPages: GuidePageId[], txSafetyAcked: boolean }`; bozuk JSON → varsayılan; `useSyncExternalStore`.
- `src/onboarding/GuideInfoDialog.tsx` → **sabit bilgi dialogu**: sayfanın `info` + `tips` içeriği,
  "Turu başlat" butonu, Esc/odak tuzağı; her an yeniden açılabilir.
- i18n: `src/i18n/shards/onboarding.ts` (TR+EN birebir), `i18n/index.ts`'e kayıt.

### 7.2 RX/TX içeriği
- Tur (5–7 adım): kanal/bus seçimi · RX tablosu (Overwrite/Chronological) · TX listesi & yeni mesaj ·
  TX modu kontrolü (Listen-Only → Arm Active) · Panic Stop · bilgi butonu.
- Bilgi dialogu bölümleri: "Bu sayfa ne işe yarar" · "**Neden hemen gönderemiyorum?**" (Listen-Only varsayılanı,
  ACK etkisi, Arm Active adımları, Panic Stop & kilidi kaldırma) · "DBC ile sinyal bazlı gönderim" · "Bunları da
  yapabilirsin" ipuçları.
- Giriş noktaları: (a) RX/TX sekmesine ilk girişte küçük, kapatılabilir şerit "Bu sayfayı tanı → Turu başlat / Bilgi"
  (dialog otomatik açılmaz); (b) sayfa başlığında kalıcı `ⓘ` butonu; (c) Yardım menüsü → "Bu sayfa hakkında…".
- TX güvenliği: kullanıcı TX denemesinde Listen-Only yüzünden engellendiğinde mevcut hata/toast yanına
  "Neden?" bağlantısı → dialog doğrudan ilgili bölüme açılır. Hiçbir onboarding eylemi TX'i açmaz.
- Panic Stop tur sırasında da erişilebilir kalmalı (driver.js overlay z-index 1e9 → çözüm uygulayıcıda, kanıtlanacak).

---
## 8. YAYILIM (aktif) — Diagnostics ve RE hariç tüm sayfalar
Pilot (rxtx) + Workspace (start) onaylandı. Sayfalar: `connections`, `trace`, `plotter`, `symbols` (DBC Studio),
`panels` (Simulation), `cloud`. Diagnostics/RE iç yönlendirmeleri sonraya.

### 8.1 Dosya sahipliği (paralel ajanlar çakışmasın)
- Sayfa ajanı YALNIZCA şunları düzenler: `src/onboarding/pages/<id>.ts` (export adı sabit: `guide<Name>`),
  `src/i18n/shards/onb<Name>.ts` (anahtar öneki `onb.<id>.*`, TR/EN birebir), kendi görünüm dosyaları.
- Team-lead'e ait (DOKUNULMAZ): `types.ts`, `registry.ts`, `i18n/index.ts`, `GuideButtons.tsx`, `GuideStrip.tsx`,
  `GuideInfoDialog.tsx`, `driverTour.ts`, `driverTheme.css`, `onboarding.test.ts`, `shards/onboarding.ts`, diğer sayfalar, TopBar.
  Ortak bir değişiklik gerekiyorsa uygulama, raporda öner.

### 8.2 Her sayfada zorunlu
- Kalıcı `GuideTourButton` + `GuideInfoButton` (sayfa araç çubuğu/başlığı), ilk ziyaret `GuideStrip`.
- Tur 4–7 adım; `topbar.panic` adımı + `keepInteractive: ['topbar.panic']`. Çapalar `data-tour="<id>.*"`.
- Info: `about` + sayfaya özgü 2–4 bölüm + sorun giderme (varsa); tips 2–4.
- Metinler gerçek UI etiketlerinden doğrulanır (uydurma buton/menü yok). Desteklenmeyen özellik anlatılmaz.

### 8.3 Kontrol listesi ek
- [ ] Shard'da `'TODO'` kalmadı.
- [ ] Boş veri durumunda (DBC yok / bağlantı yok) çapası kaybolan adım tur'u kırmıyor.
- [ ] Ortak dosyalara dokunulmadı (`git diff --stat` ile kontrol).
