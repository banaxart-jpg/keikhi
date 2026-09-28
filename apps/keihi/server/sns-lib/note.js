// note: 公開記事一覧は RSS (https://note.com/<urlname>/rss) から取る。ログイン不要・規約的にも安全。
// 投稿 (下書き作成・公開) は headless ブラウザが要るので、ここには入れない。
// keihi-api に Chromium を載せると経費等まで巻き添えで落ちるため、別サービスで後から足す。

const decode = (s) => String(s || "")
  .replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

export async function noteRss(urlname) {
  if (!urlname) throw new Error("note の urlname が未設定です (sns-config)");
  const res = await fetch(`https://note.com/${encodeURIComponent(urlname)}/rss`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`note RSS ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    const link = tag(it, "link");
    const key = (link.match(/\/n\/([a-z0-9]+)/i) || [])[1] || link;
    const pub = tag(it, "pubDate");
    return {
      id: key,
      title: tag(it, "title"),
      url: link,
      summary: tag(it, "description").replace(/<[^>]+>/g, "").slice(0, 300),
      postedAt: pub ? new Date(pub).toISOString() : null,
    };
  });
}
