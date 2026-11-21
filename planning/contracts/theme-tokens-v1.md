# Kontrat: theme-tokens-v1 — Tek Kaynaklı Renk Sistemi (Dark / Light)

Durum: AKTİF · Sahip: team-lead · Tarih: 2026-11-21 · Kullanıcı kuralı: **"Bu temanın dışında başka renk görmek
istemiyorum; ben söylemedikçe dışına çıkma."**

## 1. Kural (değiştirilemez, kullanıcı onayı olmadan genişletilemez)
1. Renk DEĞERLERİ yalnızca `src/index.css` içinde `[data-theme="dark"]` ve `[data-theme="light"]` bloklarında tanımlanır.
   Yeni token eklemek/değer değiştirmek = kullanıcı onayı gerekir.
2. Diğer TÜM dosyalarda (`.tsx`, `.ts`, `.css`): Tailwind renk paleti sınıfı (`slate-*`, `sky-*`, `cyan-*`, `emerald-*`,
   `amber-*`, `red-*`, `white`, `black`, ...), hex (`#38bdf8`), `rgb()/rgba()/hsl()` literal **YASAK**.
3. İzinli kullanım: `var(--token)` (inline style veya `bg-[var(--token)]`) ya da `@theme inline` takma ad sınıfları
   (`bg-panel`, `bg-elevated`, `border-strong`, `text-primary`, `text-focus`, `bg-nominal/15` ...).
4. Canvas/WebGL: renk yalnızca `src/utils/themeTokens.ts` (`readThemeColor`, `seriesColor`, `subscribeThemeChange`).
   Tema değişince yeniden oku. Sabit hex fallback YOK (test ortamında boş string kabul).
5. Her bileşen dark VE light temada doğru görünmek zorunda (token kullanımı bunu otomatik sağlar).
6. Kaçış: aynı satırda `// theme-allow: <gerekçe>` — yalnızca team-lead onayıyla (ör. 3. parti logo). Varsayılan: yok.
7. Kapı: `node scripts/check-theme-tokens.mjs` (ratchet; dosya başı sayı yalnız AZALABİLİR). Hedef: `--strict` PASS.

## 2. Token Sözlüğü (izinli tek palet)
| Rol | Token | Utility |
|---|---|---|
| Uygulama zemini | `--bg-app`, `--bg-canvas` | `bg-app`, `bg-canvas` |
| Panel / kart | `--bg-panel`, `--bg-surface` | `bg-panel`, `bg-surface` |
| Yükseltilmiş / modal | `--bg-elevated`, `--bg-header` | `bg-elevated`, `bg-header` |
| Araç çubuğu / şerit | `--bg-toolbar`, `--bg-strip` | `bg-toolbar`, `bg-strip` |
| Hover / seçili satır | `--bg-hover`, `--bg-row-hover`, `--bg-row-selected` | `bg-hover` |
| Input | `--bg-input` | `bg-input` |
| Modal arka perde | `--bg-scrim` | `bg-[var(--bg-scrim)]` |
| Kenarlık | `--border-hairline`, `--border-grid`, `--border-strong` | `border-hairline`, `border-grid`, `border-strong` |
| Metin | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-ink`, `--text-subtle` | `text-primary`, `text-secondary`, `text-muted`, `text-ink`, `text-subtle` |
| Dolu vurgu üstü metin | `--text-on-accent` | `text-on-accent` |
| Vurgu / seçili / link / bilgi | `--status-focus` (+`-bg`, `-border`) | `text-focus`, `bg-focus`, `border-focus`, `bg-[var(--status-focus-bg)]` |
| Başarılı / bağlı / aktif | `--status-nominal` (+`-bg`, `-border`) | `text-nominal` ... |
| Uyarı / armed / bekleyen | `--status-warn` (+`-bg`, `-border`) | `text-warn` ... |
| Hata / TX / Panic / tehlike | `--status-critical` (+`-bg`, `-border`) | `text-critical` ... |
| Değişen bayt | `--bg-changed`, `--text-changed` | — |
| Frame etiketleri | `--tag-cc-*`, `--tag-fd-*`, `--tag-j1939-*` | `.pcan-tag-*` |
| Grafik serileri | `--series-1..8` | `seriesColor(i)` / `text-series-1` |
| Canvas ızgara/eksen | `--canvas-grid`, `--canvas-axis`, `--canvas-crosshair` | `readThemeColor` |

## 3. Eşleme Rehberi (eski → yeni)
| Eski | Yeni |
|---|---|
| `slate-950/900`, `#0B0F17`, `#0F172A`, `black/..` zemin | `bg-canvas` / `bg-app` |
| `slate-900/80`, `#111827`, `#1E293B` kart | `bg-panel` / `bg-surface` / `bg-elevated` |
| `slate-800` (bg) | `bg-elevated` veya `bg-hover` |
| `slate-700/800` (border) | `border-strong` / `border-hairline` |
| `slate-100..300`, `white` (metin) | `text-primary` (dolu vurgu üstündeyse `text-on-accent`) |
| `slate-400` | `text-secondary` |
| `slate-500/600` | `text-muted` |
| `sky/cyan/blue/indigo/violet/purple-*` | `focus` ailesi |
| `emerald/green/teal/lime-*` | `nominal` ailesi |
| `amber/yellow/orange-*` | `warn` ailesi |
| `red/rose/pink-*` | `critical` ailesi |
| `x-500/10` dolgu, `x-500/30` kenar | `bg-[var(--status-*-bg)]`, `border-[var(--status-*-border)]` |
| Çok renkli kategori rozetleri (toolpack, kategori) | Tek tip: nötr kart + `focus` vurgu; ayrım ikon/etiketle, renkle değil |
| Gradient (`from-*`, `to-*`) | Kaldır → düz `bg-panel`/`bg-elevated` |
| Gölgeler `shadow-*-500/..` | Kaldır veya nötr `shadow` |

## 4. Kalıcı (projeye kaydedilen) renkler
- Simulation widget / flow terminal / plot serisi gibi kullanıcıya ait renkler artık **token adı** olarak saklanır
  (`'series-1'`, `'focus'`, `'nominal'`, `'warn'`, `'critical'`). Render: `var(--series-1)` vb.
- Eski projelerdeki hex değerleri yükleme/render anında en yakın token'a eşlenir (yazma sırasında token'a dönüştürülür);
  şema sürümü değişmez, okuma geriye uyumlu kalır.
- Renk seçici UI yalnızca bu token listesini sunar.

## 5. Kontrol Listesi (uygulayıcı teslimden önce)
- [ ] `node scripts/check-theme-tokens.mjs --file <dosya>` → kendi dosyalarında 0 satır.
- [ ] `node scripts/check-theme-tokens.mjs` → PASS (ratchet).
- [ ] `npx tsc -p tsconfig.app.json --noEmit` temiz.
- [ ] Semantik korunur: TX/Panic/hata = critical, armed/uyarı = warn, bağlı/OK = nominal, seçili/link/bilgi = focus.
- [ ] Light temada okunabilirlik: dolu vurgu üstünde `text-on-accent`, nötr zeminde `text-primary/secondary`.
- [ ] `backdrop-blur`, animasyon, gradient eklenmedi.
