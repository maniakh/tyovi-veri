// tyovi — piyasa toplayıcı. Opsiyon işinin içinde çalışır (ek GitHub Actions dakikası harcamaz), Claude kullanmaz.
// Çıktı: piyasa.json ("veri" dalına yazılır; uygulama GitHub API ile okur).
//  - takvim: ForexFactory haftalık takvimi (açık JSON) — ABD yüksek + orta etkili, diğer büyükler yalnızca yüksek; beklenti/önceki
//  - etf: spot Bitcoin ve Ethereum ETF günlük net akışı (CoinMarketCap açık veri ucu; BTC için yedek Bitbo tablosu, sayfadan)
//  - makro: 10Y reel faiz (ABD Hazinesi reel getiri eğrisi CSV'si, yedek FRED DFII10; anahtarsız); son değer ve 5 iş günü değişimi (bp)
//  - gundem: TradingView ekonomik takvimi (gerçek/beklenti/önceki, son 3 gün + 10 gün; Origin başlığıyla), yüksek etkili ABD
//    verilerinin 3 yıllık sürpriz geçmişi (tipik sapma, son 12 açıklamanın yönü), Cleveland Fed enflasyon tahmini ve isabeti, Fed karar günü
//  - evds: TCMB EVDS haftalık menkul kıymet istatistikleri — yurt dışı yerleşiklerin hisse senedi (TP.MKNETHAR.M7) ve DİBS (M8) net
//    alımı, milyon $; anahtar GitHub gizli değişkeni EVDS_KEY (yoksa "evds: anahtar yok"), istek başlığında "key"; ayrıca TCMB Piyasa
//    Katılımcıları Anketi (faiz, TÜFE, dolar/TL beklentisi)
//  - ileriye dönük: başabaş enflasyon (Hazine nominal − reel, 5 ve 10 yıl), VIX vade yapısı (CBOE: 9 gün, 30 gün, 3 ay, 6 ay, VVIX, SKEW),
//    Kalshi olay piyasası olasılıkları (TÜFE, istihdam, işsizlik, Fed, GSYH; herkese açık, anahtarsız; Türkiye'den engelli, burada alınır)
//  - haber: varlık başına son 1,5 günün başlıkları YALNIZ güvenilir kaynaklardan (alan adıyla doğrulanır): Reuters, Bloomberg, CNBC, WSJ,
//    FT, MarketWatch, AP, CoinDesk, The Block, Kitco, Fed, ECB; Türkiye için yalnız resmî kurumlar (TCMB…) ve AA
// Hiçbir kaynak zorunlu değil: düşen kaynak "hatalar"a yazılır, iş başarısız sayılmaz.
import fs from "node:fs";

const NOW = Date.now(), DAY = 864e5, hatalar = [];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36" };
async function get(url, type = "json", ms = 15000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: UA });
    if (!r.ok) throw new Error(r.status + "");
    return type === "json" ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
const dec = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ---- Ekonomik takvim ----
const ULKE = { USD: "ABD", EUR: "Euro Bölgesi", GBP: "İngiltere", JPY: "Japonya", CNY: "Çin", AUD: "Avustralya", CAD: "Kanada", CHF: "İsviçre", NZD: "Yeni Zelanda" };
// Sık görülen olayların Türkçesi (bilinmeyen ad İngilizce kalır)
const OLAY = [
  [/^Non-Farm Employment Change$/, "Tarım dışı istihdam"], [/^ADP Non-Farm Employment Change$/, "ADP istihdam"],
  [/^Unemployment Rate$/, "İşsizlik oranı"], [/^Unemployment Claims$/, "Haftalık işsizlik başvuruları"],
  [/^Average Hourly Earnings/, "Saatlik kazanç"], [/^JOLTS Job Openings$/, "JOLTS açık iş ilanları"],
  [/^Core CPI/, "Çekirdek TÜFE"], [/^CPI/, "TÜFE"], [/^Core PPI/, "Çekirdek ÜFE"], [/^PPI/, "ÜFE"],
  [/^Core PCE Price Index/, "Çekirdek PCE"], [/^PCE Price Index/, "PCE"],
  [/^Federal Funds Rate$/, "Fed faiz kararı"], [/^FOMC Statement$/, "FOMC bildirisi"], [/^FOMC Press Conference$/, "FOMC basın toplantısı"],
  [/^FOMC Meeting Minutes$/, "FOMC tutanakları"], [/^FOMC Economic Projections$/, "FOMC projeksiyonları"],
  [/^Fed Chair (.+) Speaks$/, "Fed Başkanı $1 konuşuyor"], [/^FOMC Member (.+) Speaks$/, "FOMC üyesi $1 konuşuyor"],
  [/^ECB President (.+) Speaks$/, "ECB Başkanı $1 konuşuyor"], [/^BOE Gov (.+) Speaks$/, "BoE Başkanı $1 konuşuyor"],
  [/^Main Refinancing Rate$/, "ECB faiz kararı"], [/^Official Bank Rate$/, "BoE faiz kararı"], [/^BOJ Policy Rate$/, "BoJ faiz kararı"],
  [/^ISM Manufacturing PMI$/, "ISM imalat PMI"], [/^ISM Services PMI$/, "ISM hizmet PMI"],
  [/^Flash Manufacturing PMI$/, "İmalat PMI (öncü)"], [/^Flash Services PMI$/, "Hizmet PMI (öncü)"],
  [/^Retail Sales/, "Perakende satışlar"], [/^Core Retail Sales/, "Çekirdek perakende satışlar"],
  [/^Advance GDP/, "GSYH öncü"], [/^Prelim GDP/, "GSYH ikinci tahmin"], [/^Final GDP/, "GSYH son tahmin"], [/^GDP/, "GSYH"],
  [/^Prelim UoM Consumer Sentiment$/, "Michigan tüketici güveni (öncü)"], [/^Revised UoM Consumer Sentiment$/, "Michigan tüketici güveni"],
  [/^CB Consumer Confidence$/, "Tüketici güveni (Conference Board)"], [/^Durable Goods Orders/, "Dayanıklı mal siparişleri"],
  [/^Core Durable Goods Orders/, "Çekirdek dayanıklı mal siparişleri"], [/^Crude Oil Inventories$/, "Ham petrol stokları"],
  [/^Empire State Manufacturing Index$/, "Empire State imalat"], [/^Philly Fed Manufacturing Index$/, "Philadelphia Fed imalat"],
  [/^Pending Home Sales/, "Bekleyen konut satışları"], [/^Existing Home Sales$/, "İkinci el konut satışları"], [/^New Home Sales$/, "Yeni konut satışları"],
  [/^Building Permits$/, "İnşaat izinleri"], [/^Trade Balance$/, "Dış ticaret dengesi"], [/^Bank Holiday$/, "Resmi tatil"]
];
const DONEM = s => s.replace(/ m\/m$/, " (aylık)").replace(/ y\/y$/, " (yıllık)").replace(/ q\/q$/, " (çeyreklik)");
function olayAdi(t) {
  const m = String(t).match(/^(.*?)( [mqy]\/[mqy])?$/), kok = m[1], ek = m[2] || "";
  for (const [re, tr] of OLAY) if (re.test(kok)) return DONEM(kok.replace(re, tr) + ek);
  return t;
}
async function takvim() {
  const all = [];
  for (const w of ["thisweek", "nextweek"]) {
    try { all.push(...await get("https://nfs.faireconomy.media/ff_calendar_" + w + ".json")); }
    catch (e) { if (w === "thisweek") hatalar.push("takvim: " + e.message); }
  }
  const seen = {};
  return all.filter(e => e.impact === "High" || (e.impact === "Medium" && e.country === "USD"))
    .map(e => ({ t: Date.parse(e.date), ad: (ULKE[e.country] || e.country) + " · " + olayAdi(e.title), etki: e.impact === "High" ? "high" : "medium",
      ulke: e.country, beklenti: e.forecast || null, onceki: e.previous || null }))
    .filter(e => isFinite(e.t) && e.t > NOW - 2 * DAY && !seen[e.t + e.ad] && (seen[e.t + e.ad] = 1))
    .sort((a, b) => a.t - b.t);
}

// ---- Spot ETF akışları ----
async function etfCmc(cat) {
  const j = await get("https://api.coinmarketcap.com/data-api/v3/etf/overview/netflow/chart?category=" + cat + "&range=30d");
  const p = (j.data && j.data.points) || [];
  if (!p.length) throw new Error("boş");
  return p.map(x => ({ d: new Date(+x.timestamp).toISOString().slice(0, 10), v: Math.round(+x.value) })).slice(-12);
}
async function etfBitbo() {
  const h = await get("https://bitbo.io/treasuries/etf-flows/", "text");
  const i = h.indexOf("<table"), t = h.slice(i, h.indexOf("</table>", i));
  const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(m => [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => dec(c[1])));
  const head = rows[0] || [], ti = head.indexOf("Totals");
  return rows.slice(1).map(r => ({ d: new Date(Date.parse(r[0] + " UTC")).toISOString().slice(0, 10), v: Math.round(parseFloat(r[ti]) * 1e6) }))
    .filter(x => isFinite(x.v)).reverse().slice(-12);
}
async function etf() {
  const out = {};
  for (const [k, cat] of [["BTC", "btc"], ["ETH", "eth"]]) {
    try { out[k] = await etfCmc(cat); }
    catch (e) {
      hatalar.push("etf " + k + " (CMC): " + e.message);
      if (k === "BTC") { try { out[k] = await etfBitbo(); } catch (e2) { hatalar.push("etf BTC (Bitbo): " + e2.message); } }
    }
  }
  return out;
}

// ---- Haber başlıkları: yalnız güvenilir kaynaklar ----
// Kullanıcı (2026-10-04): "haberleri Türklerden değil yabancılardan ve doğru kaynaklardan al; Türklerden alıyorsan resmîlerden al,
// bilmem ne şehrinin yerel haberini alma". Her başlığın kaynağı ALAN ADIYLA doğrulanır (Google News'te <source url>, doğrudan
// akışlarda akışın kendisi); listede olmayan hiçbir site alınmaz, yedek olarak da. Yabancı: büyük ajanslar ve finans yayınları,
// kriptoda uzman yayınlar, merkez bankaları. Türkiye: yalnız resmî kurumlar (TCMB, Hazine, TÜİK, SPK, Borsa İstanbul, KAP) ve devlet
// haber ajansı AA; Türkiye hakkındaki haber ayrıca Reuters / Bloomberg / FT'den. (KAP bildirimleri uygulamada ayrı, Mynet'ten.)
const GUVENILIR = [["reuters.com", "Reuters"], ["bloomberg.com", "Bloomberg"], ["cnbc.com", "CNBC"], ["wsj.com", "WSJ"], ["ft.com", "Financial Times"],
  ["marketwatch.com", "MarketWatch"], ["barrons.com", "Barron's"], ["apnews.com", "AP"], ["economist.com", "The Economist"], ["nikkei.com", "Nikkei"],
  ["bbc.com", "BBC"], ["bbc.co.uk", "BBC"], ["coindesk.com", "CoinDesk"], ["theblock.co", "The Block"], ["blockworks.co", "Blockworks"],
  ["dlnews.com", "DL News"], ["kitco.com", "Kitco"], ["federalreserve.gov", "Fed"], ["ecb.europa.eu", "ECB"], ["imf.org", "IMF"],
  ["aa.com.tr", "Anadolu Ajansı"], ["tcmb.gov.tr", "TCMB"], ["hmb.gov.tr", "Hazine ve Maliye"], ["tuik.gov.tr", "TÜİK"], ["spk.gov.tr", "SPK"],
  ["borsaistanbul.com", "Borsa İstanbul"], ["kap.org.tr", "KAP"]];
const RESMI = /^(Fed|ECB|IMF|TCMB|Hazine ve Maliye|TÜİK|SPK|Borsa İstanbul|KAP)$/;
function kaynakAdi(url) {
  let h = ""; try { h = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return null; }
  const g = GUVENILIR.find(([d]) => h === d || h.endsWith("." + d));
  return g ? g[1] : null;
}
function rss(xml, kaynakVarsayilan) {
  return [...String(xml).matchAll(/<item[ >]([\s\S]*?)<\/item>/g)].map(m => {
    const it = m[1], g = tag => { const x = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">").exec(it); return x ? dec(x[1]) : ""; };
    const su = /<source url="([^"]+)"/.exec(it);
    let baslik = g("title"), ad = g("source");
    if (ad && baslik.endsWith(" - " + ad)) baslik = baslik.slice(0, -(ad.length + 3));
    // Google News: kaynak, öğedeki <source url> alan adından (listede yoksa null → atılır); doğrudan akış: akışın adı
    const kaynak = su ? kaynakAdi(su[1]) : (kaynakVarsayilan || null);
    return { t: Date.parse(g("pubDate")), baslik, kaynak, link: g("link") };
  }).filter(x => x.baslik && isFinite(x.t) && x.kaynak);
}
// TCMB basın duyuruları (Atom, Türkçe tarih "1 Eki 2026 14:00:00", TR saati)
const TR_AY = { Oca: 0, "Şub": 1, Mar: 2, Nis: 3, May: 4, Haz: 5, Tem: 6, "Ağu": 7, Eyl: 8, Eki: 9, Kas: 10, Ara: 11 };
function atomTcmb(xml) {
  return String(xml).split("<entry>").slice(1).map(e => {
    const ti = /<title[^>]*>([\s\S]*?)<\/title>/.exec(e), li = /<link[^>]*href="([^"]+)"/.exec(e);
    const pu = /<published>([^<]+)<\/published>/.exec(e) || /<updated>([^<]+)<\/updated>/.exec(e);
    const m = pu && /(\d{1,2}) (\S+) (\d{4}) (\d{2}):(\d{2})/.exec(pu[1].trim());
    const t = m && TR_AY[m[2]] != null ? Date.UTC(+m[3], TR_AY[m[2]], +m[1], +m[4] - 3, +m[5]) : NaN;
    return { t, baslik: ti ? dec(ti[1]) : "", kaynak: "TCMB", link: li ? li[1].replace(/^http:/, "https:") : "" };
  }).filter(x => x.baslik && isFinite(x.t));
}
const gn = (q, tr) => "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:1d")
  + (tr ? "&hl=tr&gl=TR&ceid=TR:tr" : "&hl=en-US&gl=US&ceid=US:en");
// Google News araması yalnız güvenilir sitelerde (site: süzgeci); sonuç yine alan adıyla doğrulanır
const gnSite = (q, siteler) => gn(q + " (" + siteler.map(s => "site:" + s).join(" OR ") + ")");
const S_PIYASA = ["reuters.com", "bloomberg.com", "cnbc.com", "wsj.com", "ft.com", "marketwatch.com", "apnews.com"];
const S_KRIPTO = ["reuters.com", "bloomberg.com", "coindesk.com", "theblock.co", "cnbc.com", "ft.com", "wsj.com", "blockworks.co", "dlnews.com"];
const S_ALTIN = ["reuters.com", "bloomberg.com", "kitco.com", "cnbc.com", "ft.com", "wsj.com", "marketwatch.com"];
const S_TR = ["reuters.com", "bloomberg.com", "ft.com", "cnbc.com", "wsj.com", "aa.com.tr"];
const AKIS = {
  coindesk: ["https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"], theblock: ["https://www.theblock.co/rss.xml", "The Block"],
  bloomberg: ["https://feeds.bloomberg.com/markets/news.rss", "Bloomberg"],
  cnbc: ["https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", "CNBC"],
  marketwatch: ["https://feeds.content.dowjones.io/public/rss/mw_topstories", "MarketWatch"],
  wsj: ["https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", "WSJ"], ft: ["https://www.ft.com/markets?format=rss", "Financial Times"],
  fed: ["https://www.federalreserve.gov/feeds/press_monetary.xml", "Fed"], ecb: ["https://www.ecb.europa.eu/rss/press.html", "ECB"],
  aa: ["https://www.aa.com.tr/tr/rss/default?cat=ekonomi", "Anadolu Ajansı"], aaEn: ["https://www.aa.com.tr/en/rss/default?cat=economy", "Anadolu Ajansı"],
  tcmb: ["https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Bottom+Menu/Diger/RSS/Basin+Duyurulari", "TCMB"]
};
const RE_ALTIN = /gold|bullion|precious metal|altın|\bons\b|xau/i;
// Türkiye: yalnız piyasa ve makro (şehir, sektör, fuar haberi girmez)
const RE_TR = /borsa|\bbist\b|hisse senedi|tcmb|merkez bankası|para politikası|politika faizi|faiz kararı|\bppk\b|enflasyon|tüfe|üfe|cari (açık|işlemler|denge)|dış ticaret açığı|rezerv|bütçe (açığı|dengesi)|hazine|tahvil|eurobond|\bcds\b|kredi notu|gsyh|büyüme (rakam|oran|verisi)|işsizlik oranı|\bspk\b|\bbddk\b|döviz kuru|lira|turkish (stocks|central bank|inflation|economy|bonds|lira)|turkey.{0,30}(inflation|rate|central bank|stocks|bonds|lira|economy)|borsa istanbul/i;
const RE_TR_EN = /inflation|interest rate|central bank|lira|stocks|borsa|reserves|budget|current account|bonds?|eurobond|credit rating|\bgdp\b|unemployment/i;
// Konu: Google News sorguları, doğrudan akışlar [anahtar, süzgeç (null = hepsi)], başlıkta aranan konu
const KONU = {
  // Kripto: CoinDesk ve The Block yalnız kripto yazar → akışları süzgeçsiz; genel yayınlarda başlıkta kripto geçmeli
  BTC: { gn: [gnSite("bitcoin", S_KRIPTO), gnSite("crypto market", S_KRIPTO)], akis: [["coindesk", null], ["theblock", null], ["bloomberg"]],
    re: /bitcoin|\bbtc\b|crypto|digital assets?|stablecoin|tokeniz|blockchain/i },
  ETH: { gn: [gnSite("ethereum", S_KRIPTO)], akis: [["coindesk"], ["theblock"]], re: /ethereum|\beth\b|\bether\b|staking|layer[- ]?2|defi|tokeniz|stablecoin|crypto/i },
  XAU: { gn: [gnSite("gold price", S_ALTIN)], akis: [["bloomberg"], ["cnbc"], ["wsj"], ["ft"]], re: RE_ALTIN },
  SPY: { gn: [gnSite("stocks Wall Street", S_PIYASA), gnSite("Federal Reserve", S_PIYASA)],
    akis: [["cnbc"], ["marketwatch"], ["wsj"], ["ft"], ["bloomberg"], ["fed", null], ["ecb", /monetary policy|interest rate|press conference/i]],
    re: /s&p|wall street|\bfed\b|federal reserve|fomc|stocks|equities|\bdow\b|treasur|yields?|inflation|payroll|jobs report|monetary policy|interest rate/i },
  QQQ: { gn: [gnSite("Nasdaq tech stocks", S_PIYASA)], akis: [["cnbc"], ["marketwatch"], ["wsj"], ["bloomberg"]],
    re: /nasdaq|tech stocks|technology stocks|nvidia|apple|microsoft|alphabet|amazon|\bmeta\b|semiconductor|chipmakers?/i },
  BIST: { gn: [gnSite("Turkey lira OR \"Borsa Istanbul\" OR \"Turkish central bank\" OR \"Turkish stocks\"", S_TR)],
    akis: [["aa", RE_TR], ["aaEn", RE_TR_EN], ["tcmb", null]], re: RE_TR }
};
// Anlamsız başlıklar (fiyat listesi, tahmin, tık tuzağı, tamamı büyük harf) güvenilir kaynakta da elenir
const JUNK = /ne kadar|kaç (tl|lira|dolar)|fiyatları|canlı|gram altın|çeyrek altın|price today|rate today|price range on|prediction|forecast:? \d|\bkahin|baba vanga|horoscope|burç|check latest|güncel fiyat|altın fiyatı|piyasalarda bugün|live updates?|price analysis|teknik analiz|technical analysis|should you buy|millionaire|could turn|could make you|\d+x (gain|return)|top \d+ (crypto|coins|altcoins)|presale|meme coin|stock price, news|price, news, quote|live (gold |silver |bitcoin )?price|price in [a-z]{3}\b|\$[0-9.,]+ ?(m|million|k)\?/i;
// Sayfa adları ve program başlıkları (haber değil) da elenir; 5 kelimeden kısa başlık haber sayılmaz
const SAYFA = /print edition|stock quote|stock price \||opinion (&|and) analysis|\| (wall street journal|wsj|marketwatch|cnbc|reuters|bloomberg)$|^watch:|^video:|podcast/i;
const junk = x => { if (SAYFA.test(x.baslik) || x.baslik.trim().split(/\s+/).length < 5) return true; const up = (x.baslik.match(/[A-ZÇĞİÖŞÜ]/g) || []).length, lo = (x.baslik.match(/[a-zçğıöşü]/g) || []).length; return JUNK.test(x.baslik) || (up > lo && up > 15); };
async function haber() {
  const out = {}, akis = {};
  await Promise.all(Object.keys(AKIS).map(async k => {
    try { const x = await get(AKIS[k][0], "text"); akis[k] = k === "tcmb" ? atomTcmb(x) : rss(x, AKIS[k][1]); }
    catch (e) { akis[k] = []; hatalar.push("haber " + k + ": " + e.message); }
  }));
  await Promise.all(Object.keys(KONU).map(async k => {
    const K = KONU[k];
    let L = [];
    for (const u of K.gn) { try { L.push(...rss(await get(u, "text")).filter(x => K.re.test(x.baslik))); } catch (e) { hatalar.push("haber " + k + ": " + e.message); } }
    for (const [a, re] of K.akis) L.push(...(akis[a] || []).filter(x => re === null ? true : (re || K.re).test(x.baslik)));
    const seen = {};
    out[k] = L.filter(x => x.t > NOW - (RESMI.test(x.kaynak) ? 4 : 1.5) * DAY && x.t < NOW + 36e5 && !junk(x)).sort((a, b) => b.t - a.t)
      .filter(x => { const key = x.baslik.toLowerCase().slice(0, 45); if (seen[key]) return false; seen[key] = 1; return true; }).slice(0, 8);
  }));
  return out;
}

// ---- Reel faiz (10Y): ABD Hazinesi'nin günlük reel getiri eğrisi CSV'si (resmî, anahtarsız, FRED'den bir gün önce);
//      düşerse FRED grafik CSV'si (DFII10, anahtarsız; GitHub'dan zaman zaman yavaş) ----
async function reelHazine() {
  const y = new Date(NOW).getUTCFullYear(), url = yr => "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
    + yr + "/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=" + yr + "&page&_format=csv";
  let rows = [];
  for (const yr of [y, y - 1]) {
    const csv = await get(url(yr), "text", 30000), L = csv.trim().split("\n"), head = L[0].split(",").map(x => x.replace(/"/g, ""));
    const i = head.indexOf("10 YR");
    if (i < 0) throw new Error("10 YR sütunu yok");
    rows = rows.concat(L.slice(1).map(l => l.split(",")).map(r => { const [m, d, yy] = r[0].split("/"); return [yy + "-" + m + "-" + d, parseFloat(r[i])]; }).filter(r => isFinite(r[1])));
    if (rows.length >= 6) break;
  }
  rows.sort((p, q) => p[0] < q[0] ? -1 : 1);
  return rows;
}
async function reelFred() {
  const from = new Date(NOW - 40 * DAY).toISOString().slice(0, 10);
  const csv = await get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10&cosd=" + from, "text", 40000);
  return csv.trim().split("\n").slice(1).map(l => l.split(",")).map(r => [r[0], parseFloat(r[1])]).filter(r => isFinite(r[1]));
}
async function makro() {
  let L = [], kaynak = "Hazine";
  try { L = await reelHazine(); } catch (e) { hatalar.push("hazine: " + e.message); }
  if (L.length < 6) { kaynak = "FRED"; L = await reelFred(); }
  if (!L.length) throw new Error("reel faiz yok");
  const n = L.length;
  return { reel: { v: L[n - 1][1], d: L[n - 1][0], d5: n > 5 ? Math.round((L[n - 1][1] - L[n - 6][1]) * 100) : null, kaynak } };
}

// ---- Gündem: açıklanan verinin gerçek değeri, göstergelerin sürpriz geçmişi, Cleveland Fed enflasyon tahmini (nowcast) ----
// TradingView ekonomik takvimi (gerçek / beklenti / önceki; tarayıcıya kapalı, Origin başlığıyla sunucudan açık). Uygulama bilgisayarda
// yerel sunucudan (/takvim) aynı veriyi dakikasında alır; burası yedek ve geçmiş.
const TVCAL = "https://economic-calendar.tradingview.com/events";
async function tvCal(from, to, countries, minImp) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(TVCAL + "?from=" + new Date(from).toISOString() + "&to=" + new Date(to).toISOString() + "&countries=" + countries
      + "&minImportance=" + minImp, { signal: c.signal, headers: { ...UA, Origin: "https://www.tradingview.com" } });
    if (!r.ok) throw new Error("tv takvim " + r.status);
    return (await r.json()).result || [];
  } finally { clearTimeout(t); }
}
const gid = e => e.ticker || e.title;                        // "Core Inflation Rate MoM"un ticker'ı yok
const tvOlay = e => ({ t: Date.parse(e.date), id: gid(e), ad: e.title, ulke: e.country, etki: e.importance, a: e.actual, f: e.forecast, p: e.previous,
  birim: e.unit || "", olcek: e.scale || "", donem: e.period || "" });
// Cleveland Fed aylık enflasyon tahmini: ay başına grafik; son değer açıklamadan bir gün önceki tahmin
const NC_SERI = { cpi: "CPI Inflation", ccpi: "Core CPI Inflation", pce: "PCE Inflation", cpce: "Core PCE Inflation" };
const ncSon = (ch, ad) => { const s = (ch.dataset || []).find(d => d.seriesname === ad); const v = s && (s.data || []).filter(p => p.value !== undefined && p.value !== ""); return v && v.length ? +v[v.length - 1].value : null; };
const ncTarih = (ch, ad) => { const s = (ch.dataset || []).find(d => d.seriesname === ad); const v = s && (s.data || []).filter(p => p.value !== undefined && p.value !== ""); const m = v && v.length && String(v[v.length - 1].tooltext || "").match(/(\d\d)\/(\d\d)/); return m ? m[1] + "/" + m[2] : null; };
async function gundem(prev) {
  const out = { aciklama: [], gecmis: {}, nowcast: null, fomc: [] };
  // 1) Son 3 gün + önümüzdeki 10 gün: ABD ve Türkiye orta ve yüksek, diğer büyükler yalnız yüksek
  const L = await tvCal(NOW - 3 * DAY, NOW + 10 * DAY, "US,TR,EU,GB,JP,CN", 0);
  out.aciklama = L.filter(e => e.country === "US" || e.country === "TR" || e.importance >= 1).map(tvOlay).filter(e => isFinite(e.t)).sort((a, b) => a.t - b.t);
  // Fed ve TCMB karar günleri (önümüzdeki 5 ay; takvimde genelde yalnız sıradaki toplantı görünür); TCMB için beklenti ve önceki de
  try {
    const K = await tvCal(NOW, NOW + 150 * DAY, "US,TR", 0);
    out.fomc = K.filter(e => e.country === "US" && /Interest Rate Decision/i.test(e.title)).map(e => Date.parse(e.date));
    out.tcmb = K.filter(e => e.country === "TR" && /Interest Rate Decision/i.test(e.title)).map(e => ({ t: Date.parse(e.date), f: e.forecast, p: e.previous }));
  } catch (e) {}
  // 2) Geçmiş: son 3 yılın yüksek etkili ABD verileri → gösterge başına sürprizin tipik büyüklüğü ve son açıklamaların yönü
  //    (geçmiş prev'de varsa ve 12 saatten yeniyse yeniden çekilmez)
  if (prev && prev.gecmis && prev.gecmis["ECONOMICS:TRIRMM"] && prev.gecmisAt && NOW - prev.gecmisAt < 12 * 36e5) { out.gecmis = prev.gecmis; out.gecmisAt = prev.gecmisAt; out.cpiTar = prev.cpiTar || []; }
  else {
    const H = await tvCal(NOW - 3 * 365 * DAY, NOW, "US", 1), by = {};
    // Türkiye: TÜFE, TCMB kararı, GSYH, cari denge (TradingView'de önemi "orta"); kimlikleri ticker (ECONOMICS:TR…) zaten ülkeye özgü
    try { (await tvCal(NOW - 3 * 365 * DAY, NOW, "TR", 0)).forEach(e => { if (/^(Inflation Rate MoM|Inflation Rate YoY|TCMB Interest Rate Decision|GDP Growth Rate YoY|Current Account)$/.test(e.title)) H.push(e); }); }
    catch (e) { hatalar.push("tr geçmiş: " + e.message); }
    H.forEach(e => { if (e.actual != null && e.forecast != null && Date.parse(e.date) < NOW) (by[gid(e)] = by[gid(e)] || []).push(e); });
    for (const id of Object.keys(by)) {
      const R = by[id].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      if (R.length < 8) continue;
      const d = R.map(e => e.actual - e.forecast), sd = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length), son = d.slice(-12);
      out.gecmis[id] = { ad: R[0].title, n: R.length, sd: +sd.toPrecision(3), ust: son.filter(x => x > 0).length, alt: son.filter(x => x < 0).length,
        son: d.slice(-6).map(x => x > 0 ? 1 : (x < 0 ? -1 : 0)) };
    }
    out.gecmisAt = NOW;
    // TÜFE / çekirdek TÜFE / çekirdek PCE açıklamaları (nowcast isabeti için: dönem, beklenti, gerçek)
    out.cpiTar = H.filter(e => e.actual != null && e.forecast != null && /^(Inflation Rate MoM|Core Inflation Rate MoM|Core PCE Price Index MoM)$/.test(e.title))
      .map(e => ({ t: Date.parse(e.date), ad: e.title, a: e.actual, f: e.forecast, donem: e.period }));
  }
  // 3) Cleveland Fed tahmini (7,6 MB; 6 saatte bir) + isabeti: tahmin beklentinin üstünde/altındayken açıklama da o yönde mi geldi
  if (prev && prev.nowcast && NOW - (prev.nowcast.cekildi || 0) < 6 * 36e5) out.nowcast = prev.nowcast;
  else {
    const J = await get("https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_month.json", "json", 40000);
    const ay = ch => ch.chart && ch.chart.subcaption;                  // "2026-9" = Eylül verisi
    const acik = J.slice(-4).filter(ch => ncSon(ch, "Actual CPI Inflation") == null), cur = acik[0] || J[J.length - 1];   // en eski açıklanmamış ay
    const nc = { ay: ay(cur), tarih: ncTarih(cur, NC_SERI.cpi), cekildi: NOW };
    for (const k in NC_SERI) { const v = ncSon(cur, NC_SERI[k]); nc[k] = v == null ? null : +v.toFixed(3); }
    // PCE ayı TÜFE'den farklı olabilir (PCE daha geç açıklanır): PCE'si açıklanmamış en eski ay
    const pa = J.slice(-4).filter(ch => ncSon(ch, "Actual Core PCE Inflation") == null)[0];
    if (pa) { nc.pceAy = ay(pa); nc.pce = +(ncSon(pa, NC_SERI.pce) || 0).toFixed(3); nc.cpce = +(ncSon(pa, NC_SERI.cpce) || 0).toFixed(3); }
    const AY = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const isabet = {};
    for (const [tv, ser, key] of [["Inflation Rate MoM", NC_SERI.cpi, "cpi"], ["Core Inflation Rate MoM", NC_SERI.ccpi, "ccpi"], ["Core PCE Price Index MoM", NC_SERI.cpce, "cpce"]]) {
      let n = 0, h = 0;
      for (const e of (out.cpiTar || []).filter(x => x.ad === tv)) {
        const m = AY[String(e.donem || "").slice(0, 3)]; if (!m) continue;
        const y = new Date(e.t).getUTCFullYear() - (m > new Date(e.t).getUTCMonth() + 1 ? 1 : 0);
        const ch = J.find(c => ay(c) === y + "-" + m); const v = ch && ncSon(ch, ser);
        if (v == null) continue;
        const lean = Math.sign(Math.round(v * 10) / 10 - e.f), real = Math.sign(e.a - e.f);
        if (!lean || !real) continue;
        n++; if (lean === real) h++;
      }
      isabet[key] = { n, h };
    }
    nc.isabet = isabet;
    out.nowcast = nc;
  }
  return out;
}

// ---- EVDS (TCMB): yabancıların haftalık hisse ve DİBS net alımı ----
async function evds() {
  const key = process.env.EVDS_KEY;
  if (!key) { hatalar.push("evds: anahtar yok"); return null; }
  const f = d => String(d.getUTCDate()).padStart(2, "0") + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + d.getUTCFullYear();
  const url = "https://evds3.tcmb.gov.tr/igmevdsms-dis/series=TP.MKNETHAR.M7-TP.MKNETHAR.M8&startDate=" + f(new Date(NOW - 200 * DAY)) + "&endDate=" + f(new Date(NOW)) + "&type=json";
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { ...UA, key } });
    if (!r.ok) throw new Error(r.status + (r.status === 401 ? " (anahtar geçersiz)" : ""));
    const j = await r.json(), num = v => v == null || v === "" ? null : +String(v).replace(",", ".");
    const L = (j.items || []).map(x => ({ d: x.Tarih, hisse: num(x.TP_MKNETHAR_M7), dibs: num(x.TP_MKNETHAR_M8) })).filter(x => x.hisse != null || x.dibs != null);
    if (!L.length) throw new Error("boş yanıt");
    return { yabanci: L.slice(-26), at: NOW, anket: await evdsAnket(key, f).catch(e => { hatalar.push("evds anket: " + e.message); return null; }) };
  } finally { clearTimeout(t); }
}
// TCMB Piyasa Katılımcıları Anketi (aylık): ilk toplantı ve yıl sonu politika faizi, bu ayın aylık TÜFE'si, yıl sonu TÜFE, yıl sonu dolar/TL
const ANKET = { faizIlk: "TP.PKAUO.S04.C.U", faizYil: "TP.PKAUO.S04.H.U", tufeAy: "TP.PKAUO.S01.A.U", tufeYil: "TP.PKAUO.S01.D.U", dolarYil: "TP.PKAUO.S05.B.U" };
async function evdsAnket(key, f) {
  const url = "https://evds3.tcmb.gov.tr/igmevdsms-dis/series=" + Object.values(ANKET).join("-") + "&startDate=" + f(new Date(NOW - 150 * DAY)) + "&endDate=" + f(new Date(NOW)) + "&type=json";
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { ...UA, key } });
    if (!r.ok) throw new Error(r.status + "");
    const items = (await r.json()).items || [], out = { d: null };
    for (const [ad, kod] of Object.entries(ANKET)) {
      const k = kod.split(".").join("_"), son = items.filter(x => x[k] != null && x[k] !== "").pop();
      out[ad] = son ? +String(son[k]).replace(",", ".") : null;
      if (son && (!out.d || son.Tarih > out.d)) out.d = son.Tarih;
    }
    return out;
  } finally { clearTimeout(t); }
}

// ---- İleriye dönük (2026-10-04, kullanıcı: "sistem her zaman ileride ne olacak öyle çalışsın") ----
// Başabaş enflasyon: ABD Hazinesi nominal eğri − reel eğri (5 ve 10 yıl), resmî, anahtarsız. Piyasanın enflasyon beklentisi.
async function hazineCsv(tip) {
  const y = new Date(NOW).getUTCFullYear(), url = yr => "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
    + yr + "/all?type=" + tip + "&field_tdr_date_value=" + yr + "&page&_format=csv";
  let rows = [];
  for (const yr of [y, y - 1]) {
    const L = (await get(url(yr), "text", 30000)).trim().split("\n"), head = L[0].split(",").map(x => x.replace(/"/g, ""));
    const i5 = head.indexOf("5 YR") >= 0 ? head.indexOf("5 YR") : head.indexOf("5 Yr"), i10 = head.indexOf("10 YR") >= 0 ? head.indexOf("10 YR") : head.indexOf("10 Yr");
    rows = rows.concat(L.slice(1).map(l => l.split(",")).map(r => { const [m, d, yy] = r[0].split("/"); return { d: yy + "-" + m + "-" + d, v5: parseFloat(r[i5]), v10: parseFloat(r[i10]) }; })
      .filter(r => isFinite(r.v10)));
    if (rows.length >= 8) break;
  }
  return rows.sort((a, b) => a.d < b.d ? -1 : 1);
}
async function basabas() {
  const [N, R] = await Promise.all([hazineCsv("daily_treasury_yield_curve"), hazineCsv("daily_treasury_real_yield_curve")]);
  const rm = {}; R.forEach(r => rm[r.d] = r);
  const L = N.filter(n => rm[n.d]).map(n => ({ d: n.d, b5: isFinite(n.v5) && isFinite(rm[n.d].v5) ? n.v5 - rm[n.d].v5 : null, b10: n.v10 - rm[n.d].v10 }));
  if (L.length < 2) throw new Error("başabaş yok");
  const son = L[L.length - 1], once = L[Math.max(0, L.length - 6)];
  return { d: son.d, b10: +son.b10.toFixed(2), b5: son.b5 != null ? +son.b5.toFixed(2) : null, d5: Math.round((son.b10 - once.b10) * 100) };
}
// VIX vade yapısı (CBOE, 15 dk gecikmeli): 9 gün, 30 gün, 3 ay, 6 ay; VVIX (VIX'in oynaklığı), SKEW (kuyruk riski fiyatı)
async function vixVade() {
  const out = {};
  for (const [k, s] of [["vix9d", "_VIX9D"], ["vix", "_VIX"], ["vix3m", "_VIX3M"], ["vix6m", "_VIX6M"], ["vvix", "_VVIX"], ["skew", "_SKEW"]]) {
    try { const d = (await get("https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/" + s + ".json")).data; out[k] = { c: +d.current_price, chg: d.price_change_percent != null ? +d.price_change_percent : null }; }
    catch (e) { }
  }
  if (!out.vix) throw new Error("VIX yok");
  out.at = NOW;
  return out;
}
// Kalshi (ABD'de düzenlenen olay piyasası; herkese açık piyasa verisi anahtarsız): ekonomik verilerin sonucuna gerçek parayla verilen
// olasılıklar (TÜFE, istihdam, işsizlik, Fed kararı, GSYH). Türkiye'den erişim engelli → yalnız toplayıcıda (ABD).
const KALSHI = ["https://api.elections.kalshi.com/trade-api/v2", "https://external-api.kalshi.com/trade-api/v2"];
// Seriler açıkça (başlıktan tahmin alakasız seri seçiyordu): TÜFE aylık/yıllık, çekirdek TÜFE yıllık, tarım dışı istihdam, işsizlik,
// Fed kararı, GSYH, Türkiye enflasyonu. "aday": ilgili başlıklı tüm seriler (kod doğrulama için).
const KALSHI_SERI = [["cpi", "KXCPI"], ["cekirdek", "KXECONSTATCPICORE"], ["cpiYil", "KXCPIYOY"], ["cekirdekYil", "KXECONSTATCORECPIYOY"], ["isgucu", "KXPAYROLLS"], ["issizlik", "KXU3"],
  ["fed", "KXFEDDECISION"], ["fed", "KXFED"], ["gsyh", "KXGDP"], ["tr", "WCPI-TR"]];
async function kalshi() {
  let base = null, ser = null;
  for (const b of KALSHI) { try { ser = await get(b + "/series?category=Economics", "json", 20000); base = b; break; } catch (e) { } }
  if (!base) throw new Error("erişilemedi");
  const S = (ser.series || []).map(x => ({ ticker: x.ticker, title: x.title }));
  const out = { at: NOW, aday: S.filter(x => /cpi|inflation|payroll|jobs|unemploy|fed|fomc|gdp|rate decision|interest rate/i.test(x.title || "")).map(x => x.ticker + " · " + x.title).slice(0, 60), olaylar: [] };
  const n = v => v == null || v === "" ? null : +v;
  const fiyat = (m, c, dl) => { const a = n(m[dl]); if (a != null) return a; const x = n(m[c]); return x != null ? x / 100 : null; };
  const pr = m => { const bid = fiyat(m, "yes_bid", "yes_bid_dollars"), ask = fiyat(m, "yes_ask", "yes_ask_dollars"), last = fiyat(m, "last_price", "last_price_dollars");
    const p = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : last; return p == null ? null : +p.toFixed(3); };
  for (const [konu, tk] of KALSHI_SERI) {
    try {
      const j = await get(base + "/events?series_ticker=" + encodeURIComponent(tk) + "&status=open&with_nested_markets=true&limit=8", "json", 20000);
      const L = (j.events || []).map(e => ({ e, t: Date.parse(e.strike_date || (e.markets && e.markets[0] && (e.markets[0].expected_expiration_time || e.markets[0].close_time)) || "") }))
        .filter(o => isFinite(o.t) && o.t > NOW).sort((x, y) => x.t - y.t);
      const ev = L[0]; if (!ev) continue;
      if (!out.ornek && ev.e.markets && ev.e.markets[0]) out.ornek = Object.keys(ev.e.markets[0]).join(",");
      out.olaylar.push({ konu, seri: tk, baslik: ev.e.title, t: ev.t,
        piyasalar: (ev.e.markets || []).slice(0, 24).map(m => ({ alt: m.yes_sub_title || m.subtitle || m.title, tip: m.strike_type || null,
          alt_sinir: m.floor_strike != null ? +m.floor_strike : null, ust_sinir: m.cap_strike != null ? +m.cap_strike : null, p: pr(m), hacim: n(m.volume) || n(m.volume_fp) || 0 })) });
    } catch (e) { }
  }
  return out;
}

// Kalshi fiyat piyasaları (gün içi): "bugün 17:00 ET'de fiyat X'in üstünde mi" merdivenleri. Varlık başına aday seriler (ilk çalışan);
// açık olaylardan önce New York 17:00 kapanışlı en yakını, yoksa en yakın kapanış. Uygulama ortanca ve olasılık çıkarır.
const KALSHI_FIYAT = { BTC: ["KXBTCD"], ETH: ["KXETHD"], SPY: ["KXINXU", "KXINX"], QQQ: ["KXNASDAQ100U", "KXNASDAQ100"], XAU: ["KXGOLDD", "KXGOLD"] };
async function kalshiFiyat() {
  const n = v => v == null || v === "" ? null : +v;
  const fiyat = (m, c, dl) => { const a = n(m[dl]); if (a != null) return a; const x = n(m[c]); return x != null ? x / 100 : null; };
  const pr = m => { const bid = fiyat(m, "yes_bid", "yes_bid_dollars"), ask = fiyat(m, "yes_ask", "yes_ask_dollars"), last = fiyat(m, "last_price", "last_price_dollars");
    const p = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : last; return p == null ? null : +p.toFixed(3); };
  const out = {};
  for (const [k, adaylar] of Object.entries(KALSHI_FIYAT)) {
    for (const tk of adaylar) {
      try {
        const j = await get(KALSHI[0] + "/events?series_ticker=" + tk + "&status=open&with_nested_markets=true&limit=40", "json", 20000);
        const L = (j.events || []).map(e => { const ms = e.markets || []; const t = Date.parse((ms[0] && (ms[0].close_time || ms[0].expected_expiration_time)) || e.strike_date || "");
          return { e, t, ms }; }).filter(o => isFinite(o.t) && o.t > NOW + 10 * 60000 && o.ms.length >= 5).sort((a, b) => a.t - b.t);
        if (!L.length) continue;
        const etSaat = t => +new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
        const sec = L.find(o => etSaat(o.t) === 17 && o.t - NOW < 36 * 3600e3) || L[0];
        out[k] = { seri: tk, baslik: sec.e.title, t: sec.t,
          piyasalar: sec.ms.map(m => ({ alt: m.yes_sub_title || m.subtitle || m.title, tip: m.strike_type || null,
            alt_sinir: m.floor_strike != null ? +m.floor_strike : null, ust_sinir: m.cap_strike != null ? +m.cap_strike : null, p: pr(m), hacim: n(m.volume) || n(m.volume_fp) || 0 }))
            .filter(m => m.p != null).slice(0, 80) };
        break;
      } catch (e) { }
    }
  }
  return out;
}
// Hyperliquid balinaları: son gün işlem yapmış, hesabı ≥ 1 mn $ olan en büyük 200 hesap (pozisyonları uygulama canlı okur). Günde bir.
async function hlAdres() {
  const j = await get("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", "json", 60000);
  const w = (x, k) => +(((x.windowPerformances || []).find(p => p[0] === k) || [0, {}])[1].vlm || 0);
  const L = (j.leaderboardRows || []).map(x => ({ a: x.ethAddress, v: +x.accountValue, d: w(x, "day") })).filter(x => x.a && x.v >= 1e6 && x.d > 0)
    .sort((a, b) => b.v - a.v).slice(0, 200);
  if (L.length < 20) throw new Error("az hesap " + L.length);
  return { at: NOW, adres: L.map(x => x.a) };
}
async function main() {
  let prevAll = null; try { prevAll = JSON.parse(fs.readFileSync("piyasa.prev.json", "utf8")); } catch (e) {}
  // 10 dakikalık düzende yavaş değişen kaynaklar önceki dosyadan (zaman damgası "zaman"): takvim ve ETF 60 dk, haber 20 dk, reel faiz ve
  // başabaş 3 sa, EVDS 6 sa, Hyperliquid listesi 24 sa. ForexFactory sık istekte 429 verir.
  const Z = (prevAll && prevAll.zaman) || {}, taze = (k, ms) => prevAll && Z[k] && NOW - Z[k] < ms, zaman = Object.assign({}, Z);
  const tut = (k, ms, f, eski) => taze(k, ms) && eski != null ? Promise.resolve(eski) : f().then(v => { zaman[k] = NOW; return v; });
  const P0 = prevAll || {};
  let [tk, ef, hb, mk, gd] = await Promise.all([tut("takvim", 60 * 60000, takvim, P0.takvim).catch(e => { hatalar.push("takvim: " + e.message); return []; }),
    tut("etf", 60 * 60000, etf, P0.etf), tut("haber", 20 * 60000, haber, P0.haber),
    tut("makro", 3 * 36e5, makro, P0.makro).catch(e => { hatalar.push("fred: " + e.message); return null; }),
    gundem(prevAll && prevAll.gundem).catch(e => { hatalar.push("gundem: " + e.message); return prevAll && prevAll.gundem || null; })]);
  let ev = null; try { ev = await tut("evds", 6 * 36e5, evds, P0.evds); } catch (e) { hatalar.push("evds: " + e.message); }
  let hl = null; try { hl = await tut("hl", 24 * 36e5, hlAdres, P0.hl); } catch (e) { hatalar.push("hl: " + e.message); hl = P0.hl || null; }
  const [bb, vx, kl] = await Promise.all([tut("basabas", 3 * 36e5, basabas, P0.basabas).catch(e => { hatalar.push("başabaş: " + e.message); return prevAll && prevAll.basabas || null; }),
    vixVade().catch(e => { hatalar.push("vix: " + e.message); return prevAll && prevAll.vix || null; }),
    kalshi().catch(e => { hatalar.push("kalshi: " + e.message); return null; })]);
  if (kl) kl.fiyat = await kalshiFiyat().catch(e => { hatalar.push("kalshi fiyat: " + e.message); return {}; });
  if (!ev && prevAll && prevAll.evds) ev = prevAll.evds;
  // Kaynak düşerse bir önceki çalışmanın verisi kullanılır (iş akışı veri dalındaki eski dosyayı piyasa.prev.json olarak indirir)
  try {
    const prev = prevAll || {};
    if (!tk.length && prev.takvim) tk = prev.takvim.filter(e => e.t > NOW - 2 * DAY);
    for (const k of ["BTC", "ETH"]) if (!ef[k] && prev.etf && prev.etf[k]) ef[k] = prev.etf[k];
  } catch (e) {}
  if (!mk) try { mk = JSON.parse(fs.readFileSync("piyasa.prev.json", "utf8")).makro || null; } catch (e) {}
  const out = { at: new Date(NOW).toISOString(), takvim: tk, etf: ef, haber: hb, makro: mk, gundem: gd, evds: ev, basabas: bb, vix: vx, kalshi: kl, hl, zaman, hatalar };
  fs.writeFileSync("piyasa.json", JSON.stringify(out));
  console.log("takvim:", tk.length, "· etf:", Object.keys(ef).map(k => k + " " + (ef[k] || []).length).join(", "),
    "· haber:", Object.keys(hb).map(k => k + " " + hb[k].length).join(", "),
    "· gündem:", gd ? gd.aciklama.length + " olay, " + Object.keys(gd.gecmis).length + " gösterge, nowcast " + (gd.nowcast ? gd.nowcast.ay + " TÜFE " + gd.nowcast.cpi : "yok") : "yok", "· hatalar:", hatalar.join(" | ") || "yok");
}
main();
