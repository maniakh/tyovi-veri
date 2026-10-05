// tyovi — option flow toplayıcı. GitHub Actions 10 dakikada bir çalıştırır (açık depo tyovi-veri; Claude kullanmaz).
// Çıktı: opsiyon.json ("veri" dalına yazılır; uygulama GitHub API ile okur).
// Kaynaklar (anahtarsız): BTC → Deribit, olmazsa OKX, olmazsa Binance opsiyon. ABD → CBOE gecikmeli zincir (15 dk).
// Üç modül için: Maruziyet → net gamma (GEX), strike'lara göre gamma profili, gamma dönümü, call/put duvarı, max pain;
// Oynaklık → vadelere göre ATM IV (vade yapısı), beklenen hareket, 25 delta skew; Akış → günlük prim (call/put),
// put/call hacmi, ABD'de olağandışı sözleşmeler, BTC'de Deribit'te son işlemlerin yönü ve büyük/blok işlemler.
import fs from "node:fs";

const NOW = Date.now(), DAY = 864e5;
const US_BASE = ["SPY", "QQQ", "GLD"];
// Nasdaq / S&P'yi taşıyan büyük şirketler: bilanço öncesi opsiyonların beklediği hareket (uygulama bilanço tarihini Finnhub'dan alır)
const MEGA = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "AVGO", "TSLA"];

async function getJson(url, ms = 25000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Mozilla/5.0 (tyovi opsiyon)" } });
    if (!r.ok) throw new Error(r.status + " " + url);
    return await r.json();
  } finally { clearTimeout(t); }
}
const nd = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, iv) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  return nd(d1) / (S * iv * Math.sqrt(T));
}
// Normal dağılım birikimli fonksiyonu (Abramowitz-Stegun 7.1.26)
function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
function bsDelta(S, K, T, iv, type) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return null;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  return type === "C" ? ncdf(d1) : ncdf(d1) - 1;
}
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;

// cs: [{ exp(ms), K, type "C"|"P", oi, vol, iv(ondalık), px (dayanak başına $ fiyat) }], S: spot, mult: sözleşme başına dayanak adedi
// mult: gamma için sözleşme başına dayanak adedi (ABD 100, BTC 1); açık pozisyon sözleşme olarak yazılır
function summarize(S, cs, mult) {
  cs = cs.filter(c => c.exp > NOW && c.K > 0 && isFinite(c.oi) && c.iv > 0.02 && c.iv < 4);
  if (!cs.length || !(S > 0)) return null;
  const exps = [...new Set(cs.map(c => c.exp))].sort((a, b) => a - b);
  const nearOf = target => exps.reduce((b, e) => Math.abs(e - NOW - target) < Math.abs(b - NOW - target) ? e : b, exps[0]);
  function expiry(e) {
    const L = cs.filter(c => c.exp === e), days = (e - NOW) / DAY;
    const strikes = [...new Set(L.map(c => c.K))].sort((a, b) => a - b);
    const atmK = strikes.reduce((b, k) => Math.abs(k - S) < Math.abs(b - S) ? k : b, strikes[0]);
    const atm = L.filter(c => c.K === atmK && c.iv > 0 && c.iv < 5);
    const iv = atm.length ? atm.reduce((a, c) => a + c.iv, 0) / atm.length : null;
    const em = iv ? S * iv * Math.sqrt(Math.max(days, 0.02) / 365) : null;
    let mp = null, best = Infinity;
    for (const k of strikes) {
      let pay = 0;
      for (const c of L) pay += c.oi * (c.type === "C" ? Math.max(0, k - c.K) : Math.max(0, c.K - k));
      if (pay < best) { best = pay; mp = k; }
    }
    const oi = L.reduce((a, c) => a + c.oi, 0);
    return { tarih: new Date(e).toISOString().slice(0, 10), gun: r2(days), iv: iv ? r2(iv * 100) : null,
      beklenen: r2(em), beklenenPct: em ? r2(em / S * 100) : null, maxPain: mp, acikPoz: Math.round(oi) };
  }
  // 60 güne kadar vadeler: put/call, duvarlar, gamma
  const win = cs.filter(c => c.exp - NOW <= 60 * DAY);
  const tot = (f) => win.reduce((a, c) => a + f(c), 0);
  const cOI = tot(c => c.type === "C" ? c.oi : 0), pOI = tot(c => c.type === "P" ? c.oi : 0);
  const cV = tot(c => c.type === "C" ? c.vol : 0), pV = tot(c => c.type === "P" ? c.vol : 0);
  const byK = {};
  for (const c of win) {
    const b = byK[c.K] || (byK[c.K] = { K: c.K, c: 0, p: 0 });
    if (c.type === "C") b.c += c.oi; else b.p += c.oi;
  }
  const rows = Object.values(byK);
  const top = (arr, f, n) => arr.slice().sort((a, b) => f(b) - f(a)).slice(0, n);
  const callWalls = top(rows.filter(r => r.K >= S), r => r.c, 3).filter(r => r.c > 0).map(r => ({ K: r.K, oi: Math.round(r.c) }));
  const putWalls = top(rows.filter(r => r.K <= S), r => r.p, 3).filter(r => r.p > 0).map(r => ({ K: r.K, oi: Math.round(r.p) }));
  // Net GEX (dayanak %1 oynarsa piyasa yapıcıların $ cinsinden gamma pozisyonu; bayilerin call sattığı, put aldığı varsayımıyla işaretli)
  const gexAt = s => win.reduce((a, c) => {
    const T = (c.exp - NOW) / (365 * DAY);
    return a + (c.type === "C" ? 1 : -1) * bsGamma(s, c.K, T, c.iv) * c.oi * mult * s * s * 0.01;
  }, 0);
  const gex = gexAt(S);
  let flip = null;
  const grid = []; for (let f = 0.8; f <= 1.2001; f += 0.005) grid.push(S * f);
  let prev = null;
  for (const s of grid) {
    const g = gexAt(s);
    if (prev && Math.sign(prev.g) !== Math.sign(g)) {
      const x = prev.s + (s - prev.s) * (0 - prev.g) / (g - prev.g);
      if (flip === null || Math.abs(x - S) < Math.abs(flip - S)) flip = x;
    }
    prev = { s, g };
  }
  // Vadeler: en yakın (en az yarım gün kalan), ~1 hafta, ~1 ay; aynı vade tekrar yazılmaz
  const e0 = exps.find(e => e - NOW >= 0.5 * DAY) || exps[0], e7 = nearOf(7 * DAY), e30 = nearOf(30 * DAY);
  const near = expiry(e0), hafta = e7 !== e0 ? expiry(e7) : null, ay = e30 !== e0 && e30 !== e7 ? expiry(e30) : null;
  // Gamma profili: dayanağın ±%15'indeki strike'larda net GEX; en büyük 24'ü, strike sırasıyla [K, $]
  const gK = {};
  for (const c of win) {
    if (Math.abs(c.K / S - 1) > 0.15) continue;
    const T = (c.exp - NOW) / (365 * DAY);
    gK[c.K] = (gK[c.K] || 0) + (c.type === "C" ? 1 : -1) * bsGamma(S, c.K, T, c.iv) * c.oi * mult * S * S * 0.01;
  }
  const gexK = Object.keys(gK).map(k => [+k, Math.round(gK[k])]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 24).sort((a, b) => a[0] - b[0]);
  // Vade yapısı: 120 güne kadar her vadenin ATM IV'si (en fazla 8 nokta)
  const vadeYapi = exps.filter(e => e - NOW >= 0.5 * DAY && e - NOW <= 120 * DAY).map(e => { const x = expiry(e); return { gun: x.gun, iv: x.iv }; })
    .filter(x => x.iv != null);
  const step = Math.max(1, Math.ceil(vadeYapi.length / 8));
  // 25 delta skew (~30 gün): call IV − put IV; eksi = korunma (put) talebi baskın
  let skew = null;
  { const L = cs.filter(c => c.exp === e30), T = (e30 - NOW) / (365 * DAY);
    let bc = null, bp = null;
    for (const c of L) {
      const d = bsDelta(S, c.K, T, c.iv, c.type); if (d == null) continue;
      if (c.type === "C" && (!bc || Math.abs(d - 0.25) < Math.abs(bc.d - 0.25))) bc = { d, iv: c.iv };
      if (c.type === "P" && (!bp || Math.abs(d + 0.25) < Math.abs(bp.d + 0.25))) bp = { d, iv: c.iv };
    }
    if (bc && bp && Math.abs(bc.d - 0.25) < 0.1 && Math.abs(bp.d + 0.25) < 0.1)
      skew = { gun: r2((e30 - NOW) / DAY), call25: r2(bc.iv * 100), put25: r2(bp.iv * 100), rr: r2((bc.iv - bp.iv) * 100) }; }
  // Sıradaki aylık vade: kriptoda (Deribit, mult 1) ayın son cuması 08:00 UTC, ABD'de ayın üçüncü cuması; Mart/Haziran/Eylül/Aralık
  // çeyreklik. Vadesi dolacak opsiyonların $ büyüklüğü (açık poz. × sözleşme büyüklüğü × fiyat), tüm açık pozisyondaki payı, P/C, max pain
  const isMonthly = e => { const d = new Date(e); if (d.getUTCDay() !== 5) return false; const day = d.getUTCDate();
    return mult === 1 ? day + 7 > new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() : (day >= 15 && day <= 21); };
  let vade = null;
  { const eM = exps.find(isMonthly);
    if (eM) {
      const x = expiry(eM), L = cs.filter(c => c.exp === eM), allOI = cs.reduce((a, c) => a + c.oi, 0);
      const co = L.reduce((a, c) => a + (c.type === "C" ? c.oi : 0), 0), po = L.reduce((a, c) => a + (c.type === "P" ? c.oi : 0), 0);
      vade = { t: eM, tarih: x.tarih, tur: new Date(eM).getUTCMonth() % 3 === 2 ? "çeyreklik" : "aylık", notional: Math.round((co + po) * mult * S),
        pay: allOI > 0 ? r2((co + po) / allOI * 100) : null, pc: co > 0 ? r2(po / co) : null, maxPain: x.maxPain };
    } }
  // Günlük prim (hacim × fiyat): call ve put'a giden para
  const prim = { call: 0, put: 0 };
  for (const c of cs) if (c.px > 0 && c.vol > 0) prim[c.type === "C" ? "call" : "put"] += c.vol * c.px * mult;
  // Olasılık için oynaklık gülümsemesi: OTM opsiyonların IV'si (spotun altında put, üstünde call), spotun ±%30'u, en çok 60 nokta.
  // Uygulama bundan herhangi bir fiyat için "vade sonunda üstünde kapanma" ve "vadeye kadar dokunma" olasılığını hesaplar.
  const gulusOf = e => {
    const pts = cs.filter(c => c.exp === e && Math.abs(c.K / S - 1) <= 0.3 && c.iv > 0.02 && c.iv < 4 && ((c.type === "P" && c.K < S) || (c.type === "C" && c.K >= S)))
      .map(c => [c.K, r2(c.iv * 100)]).sort((a, b) => a[0] - b[0]);
    const st = Math.max(1, Math.ceil(pts.length / 60));
    return { t: e, tarih: new Date(e).toISOString().slice(0, 10), T: +((e - NOW) / (365 * DAY)).toFixed(5), pts: pts.filter((x, i) => i % st === 0) };
  };
  const gE = [...new Set([e0, e7, e30, vade && vade.t].filter(Boolean))];
  const gulus = gE.map(gulusOf).filter(g => g.pts.length >= 5 && g.T > 0);
  // Sıradaki 8 vadenin beklenen hareketi (bilanço vadesini uygulama seçer)
  const vadeler = exps.filter(e => e - NOW >= 0.2 * DAY).slice(0, 8).map(e => { const x = expiry(e); return { t: e, tarih: x.tarih, pct: x.beklenenPct }; }).filter(x => x.pct != null);
  // Canlı gamma (uygulama dakikada bir canlı fiyatla yeniden hesaplar): 14 güne kadar vadeler, spotun ±%12'si (ABD ±%6) — vade × strike
  // satırları [vade sırası, K, call OI, put OI, call IV %, put IV %]; daha uzak vadelerin gamma'sı sabit kabul edilir (uzak).
  const cE = exps.filter(e => e - NOW <= 14 * DAY), bant = mult === 1 ? 0.12 : 0.06, tb = {};
  for (const c of cs) {
    if (c.exp - NOW > 14 * DAY || Math.abs(c.K / S - 1) > bant || !(c.oi > 0)) continue;
    const key = c.exp + "|" + c.K, t = tb[key] || (tb[key] = [cE.indexOf(c.exp), +c.K.toFixed(2), 0, 0, null, null]);
    if (c.type === "C") { t[2] += c.oi; t[4] = +(c.iv * 100).toFixed(1); } else { t[3] += c.oi; t[5] = +(c.iv * 100).toFixed(1); }
  }
  // Tablo dışındakiler (14 günden uzak ya da bant dışı strike) sabit kabul edilir: tablo + uzak = toplam GEX
  const uzak = win.filter(c => c.exp - NOW > 14 * DAY || Math.abs(c.K / S - 1) > bant).reduce((a, c) => a + (c.type === "C" ? 1 : -1) * bsGamma(S, c.K, (c.exp - NOW) / (365 * DAY), c.iv) * c.oi * mult * S * S * 0.01, 0);
  const canli = { s0: r2(S), m: mult, e: cE, uzak: Math.round(uzak),
    r: Object.values(tb).map(t => [t[0], t[1], Math.round(t[2] * 100) / 100, Math.round(t[3] * 100) / 100, t[4], t[5]]) };
  return { spot: r2(S), yakin: near, hafta, ay, gulus, vadeler, canli,
    pcOI: cOI > 0 ? r2(pOI / cOI) : null, pcHacim: cV > 0 ? r2(pV / cV) : null,
    callDuvar: callWalls, putDuvar: putWalls, gex: Math.round(gex), gammaDonum: r2(flip),
    gexK, vadeYapi: vadeYapi.filter((x, i) => i % step === 0 || i === vadeYapi.length - 1), skew, vade,
    prim: prim.call + prim.put > 0 ? { call: Math.round(prim.call), put: Math.round(prim.put) } : null };
}

// ---- BTC ----
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
async function btcDeribit(C = "BTC") {
  const [book, idx] = await Promise.all([
    getJson("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=" + C + "&kind=option"),
    getJson("https://www.deribit.com/api/v2/public/get_index_price?index_name=" + C.toLowerCase() + "_usd")]);
  const S = idx.result.index_price;
  const cs = book.result.map(o => {
    const m = new RegExp("^" + C + "-(\\d{1,2})([A-Z]{3})(\\d{2})-(\\d+)-([CP])$").exec(o.instrument_name);
    if (!m) return null;
    return { exp: Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8), K: +m[4], type: m[5], oi: +o.open_interest || 0,
      vol: +o.volume || 0, iv: (+o.mark_iv || 0) / 100, px: (+o.mark_price || 0) * S };
  }).filter(Boolean);
  let dvol = null;
  try {
    const v = await getJson("https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=" + C + "&resolution=3600&start_timestamp=" + (NOW - 3 * 3600e3) + "&end_timestamp=" + NOW);
    const d = v.result.data; if (d.length) dvol = r2(d[d.length - 1][4]);
  } catch (e) {}
  return { kaynak: "Deribit", S, cs, dvol, akis: await btcTrades(S, C).catch(() => null) };
}
// Deribit'te son 12 saatin opsiyon işlemleri (sayfa başına 1.000, en fazla 15 sayfa): alıcı mı satıcı mı başlattı (taker yönü),
// prim, büyük ve blok işlemler.
async function btcTrades(S, C = "BTC") {
  const T = [], from = NOW - 12 * 3600e3;
  let end = NOW;
  for (let p = 0; p < (C === "BTC" ? 15 : 8); p++) {
    const j = await getJson("https://www.deribit.com/api/v2/public/get_last_trades_by_currency_and_time?currency=" + C + "&kind=option&count=1000&sorting=desc"
      + "&start_timestamp=" + from + "&end_timestamp=" + end);
    const L = (j.result && j.result.trades) || [];
    T.push(...L);
    if (!j.result || !j.result.has_more || !L.length) break;
    end = Math.min(...L.map(t => +t.timestamp)) - 1;
  }
  if (!T.length) return null;
  const a = { callAl: 0, callSat: 0, putAl: 0, putSat: 0, blok: 0, blokPrim: 0 }, big = [];
  let t0 = NOW;
  for (const t of T) {
    const m = new RegExp("^" + C + "-(\\d{1,2})([A-Z]{3})(\\d{2})-(\\d+)-([CP])$").exec(t.instrument_name);
    if (!m) continue;
    const usd = (+t.price || 0) * (+t.amount || 0) * (+t.index_price || S), buy = t.direction === "buy";
    a[(m[5] === "C" ? "call" : "put") + (buy ? "Al" : "Sat")] += usd;
    if (t.block_trade_id) { a.blok++; a.blokPrim += usd; }
    t0 = Math.min(t0, +t.timestamp || NOW);
    big.push({ tip: m[5] === "C" ? "call" : "put", K: +m[4], tarih: new Date(Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8)).toISOString().slice(0, 10),
      yon: buy ? "al" : "sat", miktar: r2(+t.amount), prim: Math.round(usd), iv: r2(+t.iv), blok: !!t.block_trade_id, at: +t.timestamp });
  }
  for (const k of Object.keys(a)) a[k] = Math.round(a[k]);
  a.saat = r2((NOW - t0) / 3600e3); a.adet = T.length;
  a.buyuk = big.sort((x, y) => y.prim - x.prim).slice(0, 8);
  return a;
}
function ymdExp(s, hourUtc) { return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), hourUtc); }
async function btcOkx(C = "BTC") {
  const [sum, oi, tk, idx] = await Promise.all([
    getJson("https://www.okx.com/api/v5/public/opt-summary?uly=" + C + "-USD"),
    getJson("https://www.okx.com/api/v5/public/open-interest?instType=OPTION&uly=" + C + "-USD"),
    getJson("https://www.okx.com/api/v5/market/tickers?instType=OPTION&uly=" + C + "-USD"),
    getJson("https://www.okx.com/api/v5/market/index-tickers?instId=" + C + "-USD")]);
  const S = +idx.data[0].idxPx, O = {}, V = {};
  oi.data.forEach(x => { O[x.instId] = +x.oiCcy || 0; });
  tk.data.forEach(x => { V[x.instId] = +x.volCcy24h || 0; });
  const cs = sum.data.map(o => {
    const m = new RegExp("^" + C + "-USD-(\\d{6})-(\\d+)-([CP])$").exec(o.instId);
    if (!m) return null;
    return { exp: ymdExp(m[1], 8), K: +m[2], type: m[3], oi: O[o.instId] || 0, vol: V[o.instId] || 0, iv: +o.markVol || 0 };
  }).filter(Boolean);
  return { kaynak: "OKX", S, cs, dvol: null };
}
async function btcBinance(C = "BTC") {
  const [mark, tk, idx] = await Promise.all([
    getJson("https://eapi.binance.com/eapi/v1/mark"),
    getJson("https://eapi.binance.com/eapi/v1/ticker"),
    getJson("https://eapi.binance.com/eapi/v1/index?underlying=" + C + "USDT")]);
  const S = +idx.indexPrice, V = {};
  tk.forEach(x => { V[x.symbol] = +x.volume || 0; });
  const btc = mark.filter(o => o.symbol.indexOf(C + "-") === 0);
  const exps = [...new Set(btc.map(o => o.symbol.split("-")[1]))];
  const O = {};
  for (const e of exps) {
    try {
      const a = await getJson("https://eapi.binance.com/eapi/v1/openInterest?underlyingAsset=" + C + "&expiration=" + e);
      a.forEach(x => { O[x.symbol] = +x.sumOpenInterest || 0; });
    } catch (err) {}
  }
  const cs = btc.map(o => {
    const m = new RegExp("^" + C + "-(\\d{6})-(\\d+)-([CP])$").exec(o.symbol);
    if (!m) return null;
    return { exp: ymdExp(m[1], 8), K: +m[2], type: m[3], oi: O[o.symbol] || 0, vol: V[o.symbol] || 0, iv: +o.markIV || 0, px: +o.markPrice || 0 };
  }).filter(Boolean);
  return { kaynak: "Binance", S, cs, dvol: null };
}

// ---- ABD (CBOE gecikmeli zincir) ----
function cboeParse(root, j) {
  const d = j.data, S = +d.current_price || +d.close;
  const cs = d.options.map(o => {
    const m = /^([A-Z.]+?)(\d{6})([CP])(\d{8})$/.exec(o.option);
    if (!m) return null;
    return { exp: ymdExp(m[2], 20), K: +m[4] / 1000, type: m[3], oi: +o.open_interest || 0, vol: +o.volume || 0,
      iv: +o.iv || 0, mid: ((+o.bid || 0) + (+o.ask || 0)) / 2, px: ((+o.bid || 0) + (+o.ask || 0)) / 2, sym: o.option };
  }).filter(Boolean);
  return { S, cs, iv30: d.iv30 != null ? r2(+d.iv30) : null, degisim: d.price_change_percent != null ? r2(+d.price_change_percent) : null };
}
// Olağandışı: günlük hacim açık pozisyonun 1,5 katını ve 1.000 sözleşmeyi aşan, en az 250 bin $ primli sözleşmeler
function unusual(root, S, cs) {
  return cs.filter(c => c.exp > NOW && c.vol >= 1000 && c.vol > 1.5 * c.oi && c.exp - NOW <= 90 * DAY)
    .map(c => ({ hisse: root, tip: c.type === "C" ? "call" : "put", K: c.K, tarih: new Date(c.exp).toISOString().slice(0, 10),
      hacim: c.vol, acikPoz: c.oi, prim: Math.round(c.vol * c.mid * 100), otm: r2((c.K / S - 1) * 100) }))
    .filter(u => u.prim >= 250000)
    .sort((a, b) => b.prim - a.prim).slice(0, 5);
}

async function main() {
  const out = { at: new Date(NOW).toISOString(), not: "Opsiyon piyasasının beklentisi; tahmin değil. ABD verisi 15 dk gecikmeli.",
    dayanak: {}, olagandisi: [], hatalar: [] };
  // BTC
  for (const C of ["BTC", "ETH"]) {
    for (const f of [btcDeribit, btcOkx, btcBinance]) {
      try {
        const b = await f(C);
        const s = summarize(b.S, b.cs, 1);
        if (s) { out.dayanak[C] = Object.assign({ kaynak: b.kaynak, dvol: b.dvol, akis: b.akis || null }, s); break; }
      } catch (e) { out.hatalar.push(C + " " + f.name + ": " + e.message); }
    }
  }

  // ABD: sabitler + uygulamanın listesindeki ABD hisseleri (snapshot)
  let extra = [];
  try {
    const snap = JSON.parse(fs.readFileSync("data/snapshot.json", "utf8"));
    extra = [...(snap.holdings || []), ...(snap.candidates || [])].map(x => String(x.tv || ""))
      .filter(tv => tv && !/^BIST:/.test(tv)).map(tv => tv.split(":").pop());
  } catch (e) {}
  const roots = [...new Set([...US_BASE, ...MEGA, ...extra])].slice(0, 24);
  // S&P ve Nasdaq: asıl opsiyon piyasası endeksin kendisi (SPX, SPY'nin ~13 katı; NDX). Endeks opsiyonları ETF ölçeğine çevrilip
  // ETF'ninkilerle birleştirilir: K × r, açık poz./hacim ÷ r (r = ETF / endeks) → $ gamma, duvar ve max pain aynı kalır.
  const IDXOPT = { SPY: "_SPX", QQQ: "_NDX" }, P = {};
  for (const ix of Object.values(IDXOPT)) {
    try { P[ix] = cboeParse(ix, await getJson("https://cdn.cboe.com/api/global/delayed_quotes/options/" + ix + ".json", 60000));
      out.olagandisi.push(...unusual(ix.replace("_", ""), P[ix].S, P[ix].cs)); }
    catch (e) { out.hatalar.push(ix + ": " + e.message); }
  }
  for (const root of roots) {
    try {
      const p = cboeParse(root, await getJson("https://cdn.cboe.com/api/global/delayed_quotes/options/" + root + ".json"));
      let cs = p.cs, kaynak = "CBOE", ek = {};
      const ix = IDXOPT[root], q = ix && P[ix];
      if (q && q.S > 0 && p.S > 0) {
        const r = p.S / q.S;
        cs = cs.concat(q.cs.map(c => Object.assign({}, c, { K: c.K * r, oi: c.oi / r, vol: c.vol / r, px: c.px * r, mid: c.mid * r })));
        kaynak = "CBOE · " + root + " + " + ix.slice(1); ek = { endeks: ix.slice(1), endeksSpot: r2(q.S), oran: +r.toFixed(6) };
      }
      const s = summarize(p.S, cs, 100);
      if (s) out.dayanak[root] = Object.assign({ kaynak, iv30: p.iv30, degisim: p.degisim }, ek, s);
      out.olagandisi.push(...unusual(root, p.S, p.cs));
    } catch (e) { out.hatalar.push(root + ": " + e.message); }
  }
  out.olagandisi.sort((a, b) => b.prim - a.prim);
  out.olagandisi = out.olagandisi.slice(0, 15);
  fs.writeFileSync("opsiyon.json", JSON.stringify(out));
  console.log("dayanaklar:", Object.keys(out.dayanak).join(", "), "· olağandışı:", out.olagandisi.length, "· hatalar:", out.hatalar.join(" | ") || "yok");
  if (!Object.keys(out.dayanak).length) process.exit(1);
}
main();
