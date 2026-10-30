// 満竹華庵 (宿) の予約・売上を AI が読むための MCP ツール (読み取り専用)。
// データは /yado/ と同じ Cloud SQL の yado_bookings (Beds24 のキャッシュ)。ここからは何も書かない・Beds24 も叩かない。
// 集計は /yado/ の画面と同じ決まり: 売上は「予約の総額を泊数で按分して、その月にかかる泊数分だけ」計上、
// 稼働率は 1 室として「泊数 ÷ 月の日数」。だから画面と同じ数字が返る。
// 個人情報 (メール・電話・住所) は DB に持っていないので出ない。宿泊者名は画面と同じく返す。

const DAY = 86400000;
const CHANNELS = ["airbnb", "booking", "direct", "other"];
const NUM_ROOMS = 1; // 画面と同じ仮置き (roomQty = 1)

const ymd = (v) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(v || "").slice(0, 10));
const dayMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(dayMs(s) + n * DAY).toISOString().slice(0, 10);
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const monthKey = (s) => s.slice(0, 7);
const monthStart = (m) => `${m}-01`;
const nextMonth = (m) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
const addMonths = (m, n) => { let k = +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1) + n; return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; };
const daysInMonth = (m) => Math.round((dayMs(monthStart(nextMonth(m))) - dayMs(monthStart(m))) / DAY);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(dayMs(String(s)));
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

// DB の行 → AI に渡す形 (画面の rowToFrontend と同じ項目から、連絡先系と自由記述 (comments など) を除いた薄い版)
export function bookingOut(r) {
  const price = Number(r.price) || 0, commission = Number(r.commission) || 0;
  const bookedAt = r.booking_time ? new Date(r.booking_time).getTime() : null;
  const arrival = ymd(r.arrival), departure = ymd(r.departure);
  const leadDays = bookedAt ? Math.max(0, Math.floor((dayMs(arrival) - bookedAt) / DAY)) : null;
  return {
    id: String(r.id), arrival, departure, nights: Number(r.nights) || 0,
    channel: r.channel || "other", referer: r.referer || undefined,
    status: r.status || undefined,
    guests: { adult: Number(r.num_adult) || 0, child: Number(r.num_child) || 0 },
    country: r.country || undefined, guest_name: r.guest_name || undefined,
    price, commission, net: Math.max(0, price - commission),
    booked_at: r.booking_time ? new Date(r.booking_time).toISOString() : undefined, lead_days: leadDays ?? undefined,
  };
}

// その月にかかる泊数 (画面の nightsInMonth と同じ)
export function nightsInMonth(b, m) {
  const s = Math.max(dayMs(b.arrival), dayMs(monthStart(m))), e = Math.min(dayMs(b.departure), dayMs(monthStart(nextMonth(m))));
  return Math.max(0, Math.round((e - s) / DAY));
}

// 月ごとの集計 (画面のサマリータブと同じ按分)。bookings は取消を除いたもの
export function monthStats(bookings, m, { detail = false } = {}) {
  const inMonth = bookings.filter((b) => b.departure > monthStart(m) && b.arrival < monthStart(nextMonth(m)));
  let nights = 0, gross = 0, commission = 0;
  const ch = {};
  for (const b of inMonth) {
    const n = nightsInMonth(b, m), k = n / Math.max(1, b.nights || 1);
    nights += n; gross += b.price * k; commission += b.commission * k;
    const c = (ch[b.channel] ||= { bookings: 0, nights: 0, gross: 0 });
    c.bookings += 1; c.nights += n; c.gross += b.price * k;
  }
  const net = gross - commission, avail = daysInMonth(m) * NUM_ROOMS;
  const out = {
    month: m, bookings: inMonth.length, nights, available_nights: avail,
    occupancy_pct: Math.round((nights / Math.max(1, avail)) * 100),
    gross: Math.round(gross), commission: Math.round(commission), net: Math.round(net),
    net_rate_pct: gross > 0 ? Math.round((net / gross) * 1000) / 10 : 0,
    adr_gross: nights ? Math.round(gross / nights) : 0, adr_net: nights ? Math.round(net / nights) : 0,
    by_channel: Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, { bookings: v.bookings, nights: v.nights, gross: Math.round(v.gross) }])),
  };
  if (detail) {
    const cc = {};
    for (const b of inMonth) { const c = (b.country || "??").toUpperCase() || "??"; cc[c] = (cc[c] || 0) + 1; }
    out.countries = Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([country, bookings]) => ({ country, bookings }));
    const leads = inMonth.map((b) => b.lead_days).filter((x) => x != null).sort((a, b) => a - b);
    out.lead_days = leads.length ? { avg: Math.round(leads.reduce((a, b) => a + b, 0) / leads.length), median: leads[Math.floor(leads.length / 2)] } : null;
    out.cancelled_in_month = undefined;
  }
  return out;
}

// 期間 [from, to] (両端を含む日付) の空き日: 泊数ベース (to の夜まで)。連続した空き日をまとめる
export function vacantRanges(bookings, from, to) {
  const booked = new Set();
  for (const b of bookings) for (let d = b.arrival; d < b.departure; d = addDays(d, 1)) booked.add(d);
  const out = [];
  let start = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!booked.has(d)) { if (!start) start = d; }
    else if (start) { out.push({ from: start, to: addDays(d, -1), nights: Math.round((dayMs(d) - dayMs(start)) / DAY) }); start = null; }
  }
  if (start) out.push({ from: start, to, nights: Math.round((dayMs(addDays(to, 1)) - dayMs(start)) / DAY) });
  return out;
}

export function createYado({ getPool, ensureSchema, getMeta, refresh = null, refreshTimeoutMs = 25000 }) {
  const pool = () => { const p = getPool(); if (!p) throw new Error("DB not configured"); return p; };

  // 読むときの取り直し: 最後の同期が STALE_HOURS より古いときだけ、Beds24 から取り直して (refresh = 画面の 🔄 と同じ処理) から答える。
  // 書くのは自分の DB のキャッシュだけで、Beds24 の予約は一切変えない (だから readOnlyHint のまま)。
  // 取り直しは RETRY_MS に 1 回まで・同時に 1 本・REFRESH_TIMEOUT_MS を超えたら待たずに今ある分で答える (失敗しても答えは返る)
  const STALE_HOURS = 6, RETRY_MS = 30 * 60000;
  let lastAttempt = 0, running = null;
  async function refreshIfStale() {
    if (!refresh) return null;
    const f = await freshness();
    if (f.bookings_in_db > 0 && f.hours_since_sync != null && f.hours_since_sync < STALE_HOURS) return null;
    if (!running) {
      if (Date.now() - lastAttempt < RETRY_MS) return { ran: false, reason: "30 分以内に取り直したばかりなので待っている" };
      lastAttempt = Date.now();
      running = Promise.resolve().then(() => refresh()).finally(() => { running = null; });
      running.catch(() => {}); // タイムアウトで見放したあとの失敗が未処理にならないように
    }
    let timer;
    try {
      const r = await Promise.race([running, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Beds24 の取り直しが ${Math.round(refreshTimeoutMs / 1000)} 秒で終わらなかった (裏では続く)。今ある分で答える`)), refreshTimeoutMs); })]);
      if (r && r.ok === false) return { ran: false, error: String(r.error || "取り直せなかった").slice(0, 200) };
      return { ran: true, fetched: r?.fetched, upserted: r?.upserted, reconciled: r?.reconciled };
    } catch (e) { return { ran: false, error: String(e?.message || e).slice(0, 200) }; }
    finally { clearTimeout(timer); }
  }

  async function freshness() {
    await ensureSchema();
    const { rows } = await pool().query(`SELECT COUNT(*)::int AS n, MAX(synced_at) AS last_synced, MAX(modified_time) AS newest FROM yado_bookings`);
    const r = rows[0] || {};
    let meta = null; try { meta = await getMeta("last_sync_modified"); } catch { meta = null; }
    const last = r.last_synced ? new Date(r.last_synced) : null;
    const hours = last ? Math.floor((Date.now() - last.getTime()) / 3600000) : null;
    return {
      bookings_in_db: r.n || 0,
      last_synced_at: last ? last.toISOString() : null,
      hours_since_sync: hours,
      note: !r.n ? "予約が DB に無い (まだ Beds24 から取り込んでいない)。/yado/ の 🔄 を人が押すと取り込まれる"
        : hours != null && hours >= 24 ? `最後に Beds24 と同期したのは ${hours} 時間前。${refresh ? "読むときに自動で取り直す設定だが取り直せていない (data.refresh を見る)。" : ""}今の予約状況が必要なら人が /yado/ の 🔄 を押す` : undefined,
      last_sync_modified: meta || undefined,
    };
  }
  async function rowsOverlapping(from, toExclusive, { cancelled = false } = {}) {
    await ensureSchema();
    const { rows } = await pool().query(
      `SELECT * FROM yado_bookings WHERE departure > $1::date AND arrival < $2::date ${cancelled ? "" : "AND status IS DISTINCT FROM 'cancelled'"} ORDER BY arrival ASC, id ASC`,
      [from, toExclusive]);
    return rows.map(bookingOut);
  }

  const READ = { readOnlyHint: true };
  const tools = [
    {
      name: "yado_bookings",
      description: "満竹華庵 (宿) の予約一覧と空き日。from〜to (YYYY-MM-DD、省略で今日から 30 日) にかかる予約を、チェックインの早い順に返す。各予約: 到着・出発・泊数・チャネル (airbnb / booking / direct / other)・人数・国・宿泊者名・金額 (price=総額、commission、net)・予約日・リードタイム。vacant に期間内の空き日 (連続でまとめたもの、泊数つき)。取消は既定で除く (include_cancelled: true で含める)。金額は円。data (最終同期の時刻) は 6 時間より古ければ読む前に Beds24 から自動で取り直す (data.refresh)。それでも古ければ人に /yado/ の 🔄 を頼む",
      annotations: READ,
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD。省略で今日" },
          to: { type: "string", description: "YYYY-MM-DD (この日の夜までを含む)。省略で from の 30 日後" },
          channel: { type: "string", enum: CHANNELS, description: "チャネルで絞る" },
          include_cancelled: { type: "boolean", description: "true で取消も含める (既定 false)" },
          limit: { type: "integer", description: "最大件数 (既定 100、最大 300)" },
        },
      },
      handler: async (a) => {
        const from = a.from ? String(a.from) : todayJst();
        if (!isDate(from)) throw new Error("from は YYYY-MM-DD");
        const to = a.to ? String(a.to) : addDays(from, 30);
        if (!isDate(to)) throw new Error("to は YYYY-MM-DD");
        if (to < from) throw new Error("to は from 以降の日付");
        if (dayMs(to) - dayMs(from) > 800 * DAY) throw new Error("期間が長すぎる (800 日まで)");
        const limit = Math.min(300, Math.max(1, Number(a.limit) || 100));
        const rf = await refreshIfStale();
        let list = await rowsOverlapping(from, addDays(to, 1), { cancelled: !!a.include_cancelled });
        if (a.channel) list = list.filter((b) => b.channel === a.channel);
        const live = list.filter((b) => b.status !== "cancelled");
        const total = list.length;
        return {
          from, to, today: todayJst(), count: total,
          vacant: vacantRanges(live, from, to),
          bookings: list.slice(0, limit),
          truncated: total > limit ? `全 ${total} 件のうち先頭 ${limit} 件。from / to を絞る` : undefined,
          data: { ...(await freshness()), refresh: rf || undefined },
        };
      },
    },
    {
      name: "yado_sales",
      description: "満竹華庵 (宿) の月ごとの売上・稼働率。months は months 個ぶんの月 (from_month〜to_month、YYYY-MM。省略で 2 か月前〜3 か月先) を返す。各月: 予約数・泊数・稼働率 (1 室として泊数÷日数)・gross (売上)・commission・net・net 率・ADR (1 泊あたり)・チャネル別。売上は予約の総額を泊数で按分してその月にかかる泊数分だけ計上 (/yado/ の画面と同じ)。未来の月は「今入っている予約」だけなので今後増える。month を 1 つ指定するとその月だけ、国別とリードタイムの詳細つき。取消は含まない。金額は円",
      annotations: READ,
      inputSchema: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM。1 か月だけ詳しく (国別・リードタイム)" },
          from_month: { type: "string", description: "YYYY-MM。省略で 2 か月前" },
          to_month: { type: "string", description: "YYYY-MM。省略で 3 か月先" },
        },
      },
      handler: async (a) => {
        const cur = monthKey(todayJst());
        let from, to, detail = false;
        if (a.month) { if (!isMonth(a.month)) throw new Error("month は YYYY-MM"); from = to = String(a.month); detail = true; }
        else {
          from = a.from_month ? String(a.from_month) : addMonths(cur, -2);
          to = a.to_month ? String(a.to_month) : addMonths(cur, 3);
          if (!isMonth(from) || !isMonth(to)) throw new Error("from_month / to_month は YYYY-MM");
          if (to < from) throw new Error("to_month は from_month 以降");
          if ((+to.slice(0, 4) * 12 + +to.slice(5, 7)) - (+from.slice(0, 4) * 12 + +from.slice(5, 7)) > 35) throw new Error("期間が長すぎる (36 か月まで)");
        }
        const rf = await refreshIfStale();
        const list = await rowsOverlapping(monthStart(from), monthStart(nextMonth(to)));
        const months = [];
        for (let m = from; m <= to; m = nextMonth(m)) {
          const s = monthStats(list, m, { detail });
          s.phase = m < cur ? "past" : m === cur ? "current" : "future";
          months.push(s);
        }
        const sum = months.reduce((t, s) => ({ nights: t.nights + s.nights, gross: t.gross + s.gross, net: t.net + s.net, available: t.available + s.available_nights }), { nights: 0, gross: 0, net: 0, available: 0 });
        return {
          currency: "JPY", rooms: NUM_ROOMS, months,
          total: months.length > 1 ? { nights: sum.nights, gross: sum.gross, net: sum.net, occupancy_pct: Math.round((sum.nights / Math.max(1, sum.available)) * 100) } : undefined,
          data: { ...(await freshness()), refresh: rf || undefined },
        };
      },
    },
  ];

  const instructions = [
    "満竹華庵 (宿・まんちかん) の予約と売上 (読み取り専用)。データは /yado/ と同じ (Beds24 を DB に取り込んだもの)。",
    "- 「来月の予約状況・空き」→ yado_bookings(from, to)。vacant が空き日、bookings が予約。「今泊まっている人・明日の到着」も from=今日で引く",
    "- 「売上・稼働率」→ yado_sales。月ごとに稼働率・売上・net・ADR・チャネル別。1 か月を詳しく見るときは month、前年比は同じ月を去年で引いて比べる",
    "- 売上は予約の総額を泊数で按分してその月にかかる分を計上する (画面と同じ)。未来の月は今入っている予約だけで、今後増える。取消は含まない",
    "- データは Beds24 を取り込んだ DB。最後の同期が 6 時間より古ければ、読む前にサーバーが Beds24 から自動で取り直す (返り値 data.refresh。Beds24 側は読むだけで、予約は変えない)。取り直せなかった (data.refresh.error) ときや、data.note が出たときは「最後の同期は〇時間前」と添えて答え、最新が要るときは人が /yado/ の 🔄 を押す",
    "- 宿泊者名は社内向け。お客さん・関係者への文面に引用しない。金額 (売上・手数料) も社内の数字として扱う",
  ].join("\n");

  return { tools, instructions };
}
