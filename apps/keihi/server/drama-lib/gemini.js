// 既存 keihi-api の callGeminiWithFallback を使うので genAI 直接呼び出しではなく、
// 「呼び出し関数を inject する」設計にして循環依存を避ける (fx-lib/ai.js と同じ流儀)。
// callGemini = (content, opts) => Promise<{result, modelUsed, attempts}>

// システムプロンプトに含める原文の上限 (章 index は常に入れる)。
// 邪宗門で約 4 万字。Gemini flash の 1M コンテキストには余裕だが、
// 毎メッセージのコストを抑えるため上限を切っておく。
const SOURCE_TEXT_CAP = 60000;

// 制作アシスタントのシステムプロンプトを毎回組み立てる。
// missingInfo (state.js の computeMissingInfo) を埋め込むことで、
// 「素材が揃うまで動画生成に進ませない」を AI にも徹底させる。
export function buildSystemPrompt({ project, characters, episode, cuts, missingInfo, chapters = [] }) {
  const charLines = characters.length
    ? characters.map((c) => {
        const tokens = (c.identityTokens || []).join("、");
        const refs = (c.referenceImages || []).length;
        return `- ${c.name}${c.reading ? `(${c.reading})` : ""}: ${c.status === "confirmed" ? "確定" : "下書き"}`
          + (tokens ? ` / 識別子: ${tokens}` : "")
          + (refs ? ` / 参照画像 ${refs}枚` : " / 参照画像なし");
      }).join("\n")
    : "(まだキャラクターが登録されていません)";

  const episodeBlock = episode
    ? `現在編集中の話: 第${episode.number}話「${episode.title || "(無題)"}」
状態: ${episode.state}
登場キャラ: ${(episode.appearingCharacterIds || []).map((id) => characters.find((c) => String(c.id) === String(id))?.name).filter(Boolean).join("、") || "未設定"}
キービジュアル: ${episode.keyVisual?.url ? "設定済み" : "未設定"}
カット数: ${cuts.length}`
    : "(現在特定の話は選択されていません)";

  const missingBlock = missingInfo.length
    ? `不足している情報 (これが埋まるまで動画生成には進めない):\n${missingInfo.map((m) => `- ${m}`).join("\n")}`
    : "現時点で不足している情報はありません。動画生成に進めます。";

  // 章 index: 番号 / 見出し / (あれば) AI 解析済みの要約と出演キャラ名
  let chaptersBlock = "";
  if (chapters.length) {
    const lines = chapters.map((ch) => {
      const names = (ch.characterNames || []).join("、");
      return `- 第${ch.number}章「${ch.title}」(${ch.charCount}字)`
        + (ch.summary ? ` — ${ch.summary}` : "")
        + (names ? ` / 出演: ${names}` : "");
    });
    chaptersBlock = `\n原作の章 index (${chapters.length}章):\n${lines.join("\n")}\n`;
  }

  // 原文全文 (上限内なら)。章見出し付きで並べて「章ごとに確認」できる形にする。
  let sourceBlock = "";
  const total = chapters.reduce((s, ch) => s + (ch.content ? ch.content.length : 0), 0);
  if (chapters.length && total > 0 && total <= SOURCE_TEXT_CAP) {
    const body = chapters
      .filter((ch) => ch.content)
      .map((ch) => `【第${ch.number}章 ${ch.title}】\n${ch.content}`)
      .join("\n\n");
    sourceBlock = `\n原作本文 (全${total}字):\n---\n${body}\n---\n`;
  } else if (project.sourceText) {
    const t = project.sourceText.slice(0, SOURCE_TEXT_CAP);
    sourceBlock = `\n原作本文 (先頭${t.length}字${project.sourceText.length > SOURCE_TEXT_CAP ? "、以降省略" : ""}):\n---\n${t}\n---\n`;
  }

  return `あなたは著作権切れ小説を縦型ショート動画(9:16)の連載に変換する制作アシスタントです。

プロジェクト: 「${project.title}」(${project.author || "作者不明"})
絵柄方針: ${project.styleGuide || "(未設定)"}
世界観・トーン: ${project.worldSetting || "(未設定)"}

登録済みキャラクター:
${charLines}
${chaptersBlock}${sourceBlock}
${episodeBlock}

${missingBlock}

役割:
- 現在の制作状態を理解し、次に必要な作業と不足している素材を具体的に指摘する。
- 初期構造化 (取り込み・キャラ下書き) が終わった直後の段階では、まず「方向性詰め」を
  手伝う: 絵柄 (styleGuide の具体化)、画像の粒度 (1話を何カットで割るか・どこまで細かく
  画にするか)、トーン。ここが決まってからキャラ参照画像 → 話の切り出しに進める。
- 素材が揃っていない場合は動画生成に進めるよう促さず、何を決めるべきかを案内する。
- キャラクターの見た目は identityTokens (識別子) を毎回一貫させるよう助言する。
- ユーザーが素材を確定したら、次のステートへ進める提案をする。
- タイムライン編集の最終判断はユーザー。配置案の提案はしてよいが決定はしない。
- 原作本文が上に与えられている場合は、章番号を引きながら具体的に答える
  (「第3章のこの描写だと…」)。与えられていない場合は章 index の要約を使う。
- 日本語・簡潔・具体的な次の一手で答える。前置きの相槌は最小限に。

キャラクター登録を手伝うとき:
- 原作本文が与えられていればまずそれを根拠にする。青空文庫等で公開されている作品は
  Web 検索で補足調査して description / identityTokens / appearancePrompt の草案を提案してよい。
- 検索結果は自分の言葉で要約して提示する (原文の長い引用はしない)。出典が分かれば
  一言添える。最終確認と確定操作は必ずユーザーに委ねる。
- ユーザーが画像を添付してきたら、その画像の内容 (雰囲気・構図・スタイル) を読み取って
  プロンプトや参照画像の方針に反映する。`;
}

// userMessage: string、imageParts: [{ inlineData: { data(base64), mimeType } }]
export async function chatOnce(callGemini, systemPrompt, history, userMessage, imageParts = []) {
  const historyText = (history || [])
    .map((h) => `${h.role === "assistant" ? "アシスタント" : "ユーザー"}: ${h.content}${(h.images || []).length ? ` (画像${h.images.length}枚添付)` : ""}`)
    .join("\n\n");
  const prompt = `${systemPrompt}\n\n${historyText ? `これまでの会話:\n${historyText}\n\n` : ""}ユーザー: ${userMessage}${imageParts.length ? "\n(このメッセージには画像が添付されています。内容を確認して答えてください)" : ""}\n\nアシスタント:`;
  const content = imageParts.length ? [prompt, ...imageParts] : prompt;
  const { result } = await callGemini(content, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 1500,
    // Gemini は googleSearch tool と画像 (inlineData) の併用が不安定なため、
    // 画像付きメッセージの時だけ検索を切る
    useGoogleSearch: imageParts.length === 0,
  });
  return (result.response.text() || "").trim();
}

// 作品全体の初期構造化: URL 取り込み直後に 1 回だけ呼ぶ。
// 時代背景 (worldSetting)・絵柄提案 (styleGuide)・主要キャラ一式を JSON で返す。
export async function analyzeWorkSetup(callGemini, { title, author, text }) {
  const excerpt = text.slice(0, 30000);
  const prompt = `「${title}」(${author || "作者不明"}) を縦型ショート動画 (9:16) の連載ドラマにします。
本文${text.length > 30000 ? "冒頭 30000 字" : "全文"}:

---
${excerpt}
---

制作の初期設定を JSON のみで返してください (前置き禁止):
{
  "worldSetting": "時代背景・舞台・トーンのまとめ (200字以内。時代、場所、社会状況、物語の語り口)",
  "styleGuide": "この作品に合う映像の絵柄・画風の提案 (50字以内。例: 劇画・浮世絵×シネマティック)",
  "characters": [
    {
      "name": "主要人物の呼び名 (本文の表記で)",
      "reading": "よみがな",
      "description": "人物像 (100字以内。立場・性格・物語での役割)",
      "identityTokens": ["見た目の識別子を3-5個 (毎カットの画像生成で一貫させる特徴。例: 渦巻く長髪)"],
      "appearancePrompt": "この人物の画像生成プロンプト案 (100字以内)"
    }
  ]
}
characters は物語を動かす主要人物だけ (最大8人)。本文に容姿描写があればそれを identityTokens に優先採用。`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 4000,
    jsonMode: true,
  });
  const t = (result.response.text() || "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("作品解析のレスポンスから JSON 取れず: " + t.slice(0, 100));
  const j = JSON.parse(m[0]);
  return {
    worldSetting: String(j.worldSetting || "").slice(0, 500),
    styleGuide: String(j.styleGuide || "").slice(0, 200),
    characters: (Array.isArray(j.characters) ? j.characters : []).slice(0, 8).map((c) => ({
      name: String(c.name || "").slice(0, 50),
      reading: String(c.reading || "").slice(0, 50),
      description: String(c.description || "").slice(0, 300),
      identityTokens: (Array.isArray(c.identityTokens) ? c.identityTokens : []).map((s) => String(s).slice(0, 30)).slice(0, 6),
      appearancePrompt: String(c.appearancePrompt || "").slice(0, 300),
    })).filter((c) => c.name),
  };
}

// 青空文庫の作品検索: Google 検索グラウンディングで候補 URL を探す
export async function searchAozora(callGemini, query) {
  const prompt = `青空文庫 (aozora.gr.jp) で「${query}」に該当する作品を Google 検索で探してください。

JSON のみで返す (前置き禁止):
{
  "results": [
    { "title": "作品名", "author": "作者名", "cardUrl": "https://www.aozora.gr.jp/cards/XXXXXX/cardYY.html" }
  ]
}
- 最大 5 件。確実に青空文庫に存在する作品だけ
- cardUrl は図書カードページ (cards/番号/cardYY.html 形式)。不明なら null`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 1500,
    useGoogleSearch: true,
  });
  const t = (result.response.text() || "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return (Array.isArray(j.results) ? j.results : []).slice(0, 5);
  } catch (_) { return []; }
}

// 章の AI 解析: 要約 + 出演キャラ名を JSON で返す
export async function analyzeChapter(callGemini, { projectTitle, author, chapter, knownCharacterNames = [] }) {
  const prompt = `「${projectTitle}」(${author || "作者不明"}) の第${chapter.number}章「${chapter.title}」の本文です。

---
${chapter.content}
---

この章を分析して JSON のみ返してください (前置き禁止):
{
  "summary": "この章で起きることの要約 (100字以内、ネタバレ可)",
  "characterNames": ["この章に登場・言及される人物名 (呼び名で。既知: ${knownCharacterNames.join("、") || "なし"}。既知の人物は同じ表記で)"]
}`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash-lite",
    maxOutputTokens: 1000,
    jsonMode: true,
  });
  const text = (result.response.text() || "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("章解析のレスポンスから JSON 取れず: " + text.slice(0, 100));
  const j = JSON.parse(m[0]);
  return {
    summary: String(j.summary || "").slice(0, 300),
    characterNames: Array.isArray(j.characterNames) ? j.characterNames.map((s) => String(s).slice(0, 50)).slice(0, 30) : [],
  };
}
