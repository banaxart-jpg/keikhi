// Web 画像検索 (API キー不要のソースだけで構成)
// - Wikimedia Commons: 歴史資料・パブリックドメイン系に強い。ホットリンク可
// - Openverse: CC ライセンス画像の横断検索。Commons で薄い時のフォールバック
// 用途はチャットの [画像検索: クエリ] マーカー (資料・雰囲気参考)。

const UA = "keihi-auto-drama/1.0 (production reference search)";

// queries: 文字列 or 文字列配列 (具体的 → 広い の順の候補。上から順に足りるまで検索)。
// 語が多いと AND 検索で 0 件になりがちなので、候補を複数もらって順に試すのが前提
export async function searchWebImages(queries, limit = 4) {
  const qs = (Array.isArray(queries) ? queries : [queries])
    .map((s) => String(s || "").trim()).filter(Boolean).slice(0, 3);
  const out = [];
  const pushUnique = (items) => {
    for (const r of items) {
      if (out.length >= limit) return;
      if (!out.some((o) => o.imageUrl === r.imageUrl)) out.push(r);
    }
  };
  for (const q of qs) {
    if (out.length >= limit) break;
    try { pushUnique(await searchCommons(q, limit - out.length)); } catch (e) {
      console.warn("[drama] commons search failed:", e.message);
    }
  }
  for (const q of qs) {
    if (out.length >= limit) break;
    try { pushUnique(await searchOpenverse(q, limit - out.length)); } catch (e) {
      console.warn("[drama] openverse search failed:", e.message);
    }
  }
  return out.slice(0, limit);
}

async function searchCommons(query, limit) {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("format", "json");
  u.searchParams.set("generator", "search");
  u.searchParams.set("gsrsearch", `filetype:bitmap ${query}`);
  u.searchParams.set("gsrnamespace", "6"); // File:
  u.searchParams.set("gsrlimit", String(limit + 4)); // mime で落ちる分の余裕
  u.searchParams.set("prop", "imageinfo");
  u.searchParams.set("iiprop", "url|mime");
  u.searchParams.set("iiurlwidth", "1024"); // 原寸ではなくサムネ URL をもらう (数十MBの原画対策)
  const res = await fetch(u, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`commons HTTP ${res.status}`);
  const j = await res.json();
  const pages = Object.values(j?.query?.pages || {});
  pages.sort((a, b) => (a.index || 0) - (b.index || 0)); // 検索の関連度順
  return pages
    .map((p) => ({ info: p.imageinfo?.[0], title: String(p.title || "").replace(/^File:/, "") }))
    .filter((x) => x.info && /image\/(jpeg|png|webp)/.test(x.info.mime || ""))
    .slice(0, limit)
    .map((x) => ({
      imageUrl: x.info.thumburl || x.info.url,
      pageUrl: x.info.descriptionurl || "",
      title: x.title,
      source: "Wikimedia Commons",
    }));
}

async function searchOpenverse(query, limit) {
  const u = new URL("https://api.openverse.org/v1/images/");
  u.searchParams.set("q", query);
  u.searchParams.set("page_size", String(Math.max(1, limit)));
  const res = await fetch(u, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`openverse HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || [])
    .map((r) => ({
      imageUrl: r.thumbnail || r.url,
      pageUrl: r.foreign_landing_url || r.url || "",
      title: r.title || "",
      source: `Openverse (${r.license ? "CC " + String(r.license).toUpperCase() : "CC"})`,
    }))
    .filter((r) => r.imageUrl);
}
