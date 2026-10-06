// tyovi: uygulama kapalıyken telefona gidecek uyarılar (Android'deki yerel arka plan görevi 15 dk'da bir uyari.json'u okur).
// Kullanıcı (2026-10-06): "uygulama içindeyken bildirim geliyor, dışındayken gelmiyor" — Android arka plandaki uygulamayı dondurur,
// uygulamadaki JS çalışmaz; canlı veri gerektiren uyarılar burada (GitHub Actions, 10 dk) hesaplanır.
//  1) Hyperliquid balina hareketleri: piyasa.json'daki en büyük 200 hesabın tüm pozisyonları; önceki görüntü balina-snap.json
//     (veri dalı, ≤40 dk eskiyse). Kurallar uygulamadaki balinaFark ile aynı: açtı / kapattı / artırdı / azalttı / yön değiştirdi,
//     değişim kontrat farkı × fiyat (allMids), eşik BTC 5 mn $, ETH 2 mn $, diğer 1 mn $; artış/azalışta pozisyonun ≥%10'u ya da
//     bildirim eşiği. Bildirim: BTC ≥25 mn $, ETH ≥10 mn $.
//  2) Kritik haber: piyasa.json haberleri (yalnız güvenilir kaynaklar), son 60 dk, kritik kelime + tonlu başlık (uygulamadaki
//     newsAlerts ile aynı düzenli ifadeler).
// Çıktılar: balina.json { at, n, hareket: son 24 sa (en çok 300) } — uygulamanın Hareketler listesi kapalıyken de dolsun;
//           balina-snap.json { t, s: { adres: { coin: [szi, kaldıraç] } } } — sonraki çalışmanın karşılaştırması;
//           uyari.json { at, balina: bildirim eşiğini aşan son 6 sa, haber: [...] } — telefon için küçük dosya.
// Yalnız herkese açık piyasa verisi (Hyperliquid pozisyonları zincir üstünde herkese açık); kişisel veri yok.
import fs from "fs";

const NOW = Date.now();
const rd = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
const P = rd("piyasa.json") || rd("piyasa.prev.json") || {};
const ESIK = { BTC: 5e6, ETH: 2e6 }, DIGER = 1e6, BILDIR = { BTC: 25e6, ETH: 10e6 };
const TONE_POS = /surg|soar|rall(y|ies|ied)|jump|rebound|record high|all-time high|\bath\b|bullish|\bgains?\b|climb|inflows?|approv|accumulat|rate cuts?|cuts? rates|breakout|spikes?|\brises?\b|rising|higher|yüksel|rekor|zirve|ralli|toparlan|sıçra|uçtu|coştu|kazandır|girişi|onay|indirim/i;
const TONE_NEG = /plung|crash|tumbl|slump|\bdrops?\b|dropp|\bfalls?\b|falling|\bfell\b|sell-?off|bearish|\blosses\b|outflows?|hack|exploit|\bbans?\b|lawsuit|\bsues?\b|liquidat|\bfears?\b|reject|lower|dump|slid|\bsinks?\b|düştü|düşüş|düşüyor|geriled|geriliyor|çöktü|çöküş|eridi|sert fren|vurdu|kayb|çıkışı|yasak|dava|panik|sert satış/i;
const NEWS_CRIT = /\bsec\b|etf (approv|reject|denied)|\bfed\b|powell|fomc|rate (cut|hike)|tariff|\bwar\b|attack|hack|exploit|\bbans?\b|bankrupt|default|emergency|sanction|ceasefire|faiz kararı|savaş|saldırı|yasak|tcmb|merkez bankası|ateşkes|gümrük/i;
const ton = t => { const p = TONE_POS.test(t), n = TONE_NEG.test(t); return p && !n ? 1 : (n && !p ? -1 : 0); };

async function hl(body, ms = 12000) {
  const c = new AbortController(), tm = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: c.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(tm); }
}

async function balinalar(hatalar) {
  const A = (P.hl && P.hl.adres) || [], onceki = rd("balina.prev.json"), snapEski = rd("balina-snap.prev.json");
  let hareket = ((onceki && onceki.hareket) || []).filter(m => NOW - m.t < 24 * 36e5);
  if (!A.length) { hatalar.push("balina: adres listesi yok"); return hareket; }
  const mids = (await hl({ type: "allMids" })) || {};
  const snap = {}; let i = 0, ok = 0;
  async function isci() {
    while (i < A.length) {
      const a = A[i++], j = await hl({ type: "clearinghouseState", user: a });
      if (!j) continue; ok++;
      const p = {};
      (j.assetPositions || []).forEach(x => { const q = x && x.position; if (!q) return; const sz = +q.szi; if (sz) p[q.coin] = [sz, (q.leverage && +q.leverage.value) || 0]; });
      snap[a] = p;
    }
  }
  await Promise.all(Array.from({ length: 8 }, isci));
  if (ok < 10) { hatalar.push("balina: Hyperliquid yanıt yok (" + ok + ")"); return hareket; }
  const yeni = [];
  if (snapEski && snapEski.s && NOW - snapEski.t < 40 * 60000) {
    for (const a of Object.keys(snap)) {
      const O = snapEski.s[a]; if (!O) continue;                       // iki görüntüde de yanıt veren hesaplar
      const N = snap[a];
      for (const c of new Set([...Object.keys(O), ...Object.keys(N)])) {
        const so = O[c] ? O[c][0] : 0, sn = N[c] ? N[c][0] : 0; if (so === sn) continue;
        const px = +mids[c]; if (!(px > 0)) continue;
        const dv = (sn - so) * px, av = Math.abs(dv);
        if (av < (ESIK[c] || DIGER)) continue;
        const tur = !so ? "ac" : (!sn ? "kapat" : ((so > 0) !== (sn > 0) ? "cevir" : (Math.abs(sn) > Math.abs(so) ? "artir" : "azalt")));
        if ((tur === "artir" || tur === "azalt") && av < Math.max(Math.abs(so), Math.abs(sn)) * px * 0.1 && av < (BILDIR[c] || 1e7)) continue;
        yeni.push({ t: NOW, a, c, tur, y: sn ? (sn > 0 ? 1 : -1) : (so > 0 ? 1 : -1), dv: Math.round(dv), v: Math.round(Math.abs(sn) * px), px, lev: (N[c] || O[c])[1] || 0, k: "s" });
      }
    }
  }
  hareket = hareket.concat(yeni).slice(-300);
  fs.writeFileSync("balina.json", JSON.stringify({ at: NOW, n: ok, hareket }));
  fs.writeFileSync("balina-snap.json", JSON.stringify({ t: NOW, s: snap }));
  console.log("balina:", ok, "hesap,", yeni.length, "yeni hareket");
  return hareket;
}

function haberler() {
  const out = [], H = P.haber || {};
  for (const k of ["BTC", "XAU", "ETH", "SPY", "QQQ"]) {
    const c = (H[k] || []).filter(x => NOW - x.t <= 60 * 60000 && NEWS_CRIT.test(x.baslik) && ton(x.baslik) !== 0)[0];
    if (c) out.push({ k, t: c.t, baslik: c.baslik, kaynak: c.kaynak || "" });
  }
  return out;
}

const hatalar = [];
let hareket = [];
try { hareket = await balinalar(hatalar); } catch (e) { hatalar.push("balina: " + e.message); }
const uyari = {
  at: NOW,
  balina: hareket.filter(m => BILDIR[m.c] && Math.abs(m.dv) >= BILDIR[m.c] && NOW - m.t < 6 * 36e5),
  haber: haberler(),
  hatalar
};
fs.writeFileSync("uyari.json", JSON.stringify(uyari));
console.log("uyari:", uyari.balina.length, "balina,", uyari.haber.length, "haber", hatalar.length ? hatalar : "");
