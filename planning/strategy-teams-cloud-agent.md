# Strateji: Mühendislik Ekipleri için Cloud + Agent Platformu

Durum: TASLAK (kullanıcı kararları bekleniyor) · Sahip: team-lead · Tarih: 2026-11-21
Kullanıcı yönlendirmesi: "Bu program car hacking için değil. Cloud ve Agent işlemlerine yönelik mühendislik
takımlarına yönelik işlemler yapacağız."

## 1. Konumlandırma
**Eski algı:** tek kişilik masaüstü analizör + "car hacking" (RE) vitrini.
**Yeni:** *Test / validasyon / entegrasyon ekipleri için işbirlikçi CAN mühendislik platformu.*
Üç katman, tek veri modeli:
1. **Desktop (NexusCAN):** mühendisin tezgâhtaki aracı (bugünkü uygulama).
2. **Team Cloud (NexusCANCloud, self-hosted):** ortak DBC/ECU kütüphanesi, kayıtlar, run geçmişi, RBAC, audit.
3. **Agents:** (a) **Bench/Fleet Agent** (`nexus-cli agent`): tezgâh, HIL ve araçlarda GUI'siz, Listen-Only
   gözlem ve kayıt; (b) **AI Agents** (MCP): kayıt triage'ı, rapor üretimi, ekip bilgisine sorgu.

Rakiplerden ayrışma: BUSMASTER / PCAN-Explorer / SavvyCAN tek kullanıcılı; Vector'ün ekip çözümleri pahalı ve kapalı.
Biz: açık, self-hosted, ekip + otomasyon + AI-native, güvenlik (Listen-Only, audit) varsayılan.

## 2. Mevcut Varlıklar → Yeni Odak
| Varlık | Durum | Yeni roldeki yeri |
|---|---|---|
| NexusCANCloud (Next.js, PG17/Timescale, S3, RBAC, pairing) | Var, 2026-11-09'dan beri durgun | Ekip platformunun merkezi |
| Desktop Cloud sekmesi | `CLOUD_AVAILABLE=false` (build 18'de kapatıldı) | Sunucu hazır olunca yeniden açılır |
| `nexus-cloud` crate (read-only bridge, SHA-256 schema dedupe) | Var | Desktop ↔ Cloud ↔ Agent taşıyıcısı |
| `nexus-cli agent` (headless, Listen-Only, read-only bridge) | Var | Bench/Fleet Agent |
| MCP (46 read-only araç) | Var | Desktop AI co-pilot → Cloud MCP |
| Workbench / Flow / Run store / ECU registry | Var (yerel) | Ekip test otomasyonu, cloud senkronu |
| Reverse Engineering sekmesi | Var | **Uygulamada aynen kalır** (karar 2026-11-21). Vitrin odağı değil; ileride ayrı bir NexusCAN organizasyonu/reposu altına taşınabilir |

## 3. Fazlar (öneri)
**C0 — Konumlandırma temizliği (kısa):** README/README.tr'den "car hacking" / "Cheat Engine" dili kaldırıldı
(2026-11-21, yapıldı). RE özellikleri uygulamada ve README'de kalır. Sonraki adım: tanıtım metinlerine ekip / cloud /
agent akışını eklemek, Ecosystem roadmap'i ana vitrine taşımak.

**C1 — Team Cloud v1 (desktop ↔ cloud):** NexusCANCloud'u ayağa kaldır ve CI'a bağla; desktop'ta Cloud'u yeniden aç
(giriş, pairing, org/proje). Proje + DBC sürümleri + ECU registry senkronu, semantik DBC diff, kayıt yükleme/indirme,
çakışma çözümü. Audit log.

**C2 — Bench/Fleet Agent:** Cloud'da agent kaydı ve sağlık durumu; uzaktan canlı izleme (read-only); uzaktan kayıt
başlat/durdur; tetik kuralları (DTC göründü, sinyal eşiği, bus-off) → otomatik kayıt + cloud'a yükleme; agent
paketleri (systemd / Windows service / Docker).

**C3 — Ekip test otomasyonu:** Workbench/Flow'ları agent veya `nexus-cli` ile GUI'siz çalıştırma; run geçmişinin
cloud'a senkronu; test raporları (HTML/PDF, gereksinim ID izlenebilirliği); CI entegrasyonu (JUnit çıktısı,
GitHub Actions / Jenkins örnekleri).

**C4 — AI Agents:** Cloud tarafı MCP (ekibin kayıtları, DBC geçmişi, run'lar üzerinde sorgu); agent kayıtlarında
anomali triage'ı; otomatik test raporu özeti. (İsteğe bağlı, karar #3'e bağlı:) Desktop MCP M4 = kontrollü aksiyonlar:
kullanıcı Arm etmiş olmalı + `ui_confirm` + clamp + rate limit; Panic Stop her zaman kazanır.

Çapraz konular: SSO/OIDC, on-prem kurulum kılavuzu, lisans/iş modeli (open-core + ekip katmanı?), çoklu-dil.

## 4. Karar Bekleyen Sorular
1. **Dağıtım modeli:** yalnız self-hosted (OEM / Tier-1 on-prem), yoksa ayrıca bizim barındırdığımız SaaS da mı?
2. **"Agent" kapsamı:** Bench/Fleet Agent mı, AI Agent mı, ikisi birden mi (öneri: ikisi; önce C2 bench agent)?
3. **Uzaktan TX:** Cloud/agent üzerinden kontrollü aktüasyon (uzaktan test akışı çalıştırma) istenecek mi, yoksa uzak
   taraf sonsuza kadar read-only mi kalacak? (Bugünkü tasarım: read-only; değiştirmek büyük güvenlik kararı.)
4. **İlk hedef müşteri:** EV/batarya test ekipleri, OEM validasyon, Tier-1 tedarikçi, endüstriyel otomasyon?
5. ~~Reverse Engineering sekmesi~~ — KARAR: uygulamada kalır, yalnız README'deki hacking dili temizlendi; ileride ayrı org.
6. **Diagnostics derinliği:** UDS flash / SecurityAccess gibi atölye özellikleri öne çıkarılmaya devam mı, geri planda mı?

## 5. Alınan Kararlar (2026-11-21)
- **Tek build, local-first.** Cloud asla zorunlu değil; desktop internetsiz tam çalışır. İki ayrı build YOK.
- **Cloud erişimi iki yoldan:** (1) **NexusCloud Community (beta)** — bizim barındırdığımız, kurulum gerektirmeyen
  sunucu, ücretsiz bulut katmanında (ör. Oracle Always Free; koşullar kurulum günü doğrulanacak), kota + saklama süresi
  + "beta, garanti yok" + gizlilik/kullanım koşulları ile; (2) **self-hosted** NexusCANCloud (kurumsal / air-gapped).
  Desktop'ta aynı "Sunucuya bağlan" ekranı; varsayılan adres Community, değiştirilebilir.
- **Desktop teknik değişikliği:** `CLOUD_AVAILABLE` derleme bayrağı → çalışma zamanı ayarı; sunucu girilmedikçe hiçbir
  ağ bağlantısı yok (bugünkü gizlilik garantisi korunur).
- **Alan adı:** marka NexusCAN kalır; `nexuscan.dev` alınacak (Google Registry RDAP: boş). `nexuscan.com` 2018'den beri
  domain yatırımcısında (NameBright) — peşine düşülmeyecek. Alt alanlar: `cloud.` (Community), `docs.`; site GitHub /
  Cloudflare Pages (ücretsiz), indirmeler GitHub Releases.
- **Marka:** TÜRKPATENT ve EUIPO'da "nexuscan" kaydı yok (kullanıcı kontrolü). Plan: TÜRKPATENT kelime markası, sınıf
  9 + 42; 6 ay içinde rüçhanlı EUIPO (bütçeye bağlı). "NEXUS" kalabalık/zayıf unsur, risk düşük kabul edildi.
- **RE:** uygulamada kalır; README'den hacking dili temizlendi; ileride ayrı org olabilir.
- **İş modeli (öneri, onaylanmadı):** open-core — desktop + self-hosted cloud + agent ücretsiz; ileride ücretli Team
  katmanı (kota/SLA/SSO), destek.

## 6. Bekleyenler
- Kullanıcı: `nexuscan.dev` satın alma, TÜRKPATENT başvurusu (maaş sonrası).
- Teknik (sıradaki): C1-a desktop "Sunucuya bağlan" ayarı; C1-b NexusCANCloud Community hazırlığı (kota, saklama, kurulum
  kılavuzu, ToS/gizlilik); C0 devamı: README'ye ekip/cloud/agent vitrini.
- Açık sorular: uzaktan TX (read-only kalsın mı), ilk hedef müşteri, bench vs AI agent önceliği.
