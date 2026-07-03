// 既存 keihi-api の callGeminiWithFallback を使うので genAI 直接呼び出しではなく、
// 「呼び出し関数を inject する」設計にして循環依存を避ける (fx-lib/ai.js と同じ流儀)。
// callGemini = (content, opts) => Promise<{result, modelUsed, attempts}>

// jsonMode でも ```json フェンスや末尾カンマが混ざることがあるので、ゆるくパースする
function parseJsonLoose(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  const body = t.slice(s, e + 1);
  try { return JSON.parse(body); } catch (_) {}
  try { return JSON.parse(body.replace(/,(\s*[}\]])/g, "$1")); } catch (_) {}
  return null;
}

// システムプロンプトに含める原文の上限 (章 index は常に入れる)。
// 邪宗門で約 4 万字。Gemini flash の 1M コンテキストには余裕だが、
// 毎メッセージのコストを抑えるため上限を切っておく。
const SOURCE_TEXT_CAP = 60000;

// 制作アシスタントのシステムプロンプトを毎回組み立てる。
// missingInfo (state.js の computeMissingInfo) を埋め込むことで、
// 「素材が揃うまで動画生成に進ませない」を AI にも徹底させる。
export function buildSystemPrompt({ project, characters, episode, cuts, missingInfo, chapters = [], locations = [], aiNotes = "", styleRefCount = 0, assets = [] }) {
  const charLines = characters.length
    ? characters.map((c) => {
        const tokens = (c.identityTokens || []).join("、");
        const refs = (c.referenceImages || []).length;
        return `- ${c.name}${c.reading ? `(${c.reading})` : ""}: ${c.status === "confirmed" ? "確定" : "下書き"}`
          + (tokens ? ` / 識別子: ${tokens}` : "")
          + (refs ? ` / 参照画像 ${refs}枚` : " / 参照画像なし");
      }).join("\n")
    : "(まだキャラクターが登録されていません)";

  const locLines = locations.length
    ? locations.map((l) => {
        const tokens = (l.identityTokens || []).join("、");
        const refs = (l.referenceImages || []).length;
        return `- ${l.name}: ${l.status === "confirmed" ? "確定" : "下書き"}`
          + (tokens ? ` / 識別子: ${tokens}` : "")
          + (refs ? ` / 参照画像 ${refs}枚` : " / 参照画像なし");
      }).join("\n")
    : "(まだ場所が登録されていません)";

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
  // 上限超過時は「先頭だけ」ではなく章ごとに比例配分で刈り込み、後半の章や結末も
  // 文脈に残す (人間失格 74k 字で後半が丸ごと消えていた対策)。
  let sourceBlock = "";
  const total = chapters.reduce((s, ch) => s + (ch.content ? ch.content.length : 0), 0);
  if (chapters.length && total > 0) {
    const withContent = chapters.filter((ch) => ch.content);
    let body;
    if (total <= SOURCE_TEXT_CAP) {
      body = withContent.map((ch) => `【第${ch.number}章 ${ch.title}】\n${ch.content}`).join("\n\n");
      sourceBlock = `\n原作本文 (全${total}字):\n---\n${body}\n---\n`;
    } else {
      body = withContent.map((ch) => {
        const budget = Math.max(400, Math.floor(ch.content.length * SOURCE_TEXT_CAP / total));
        const trimmed = ch.content.length > budget ? ch.content.slice(0, budget) + "\n…(この章の以降は要約参照)" : ch.content;
        return `【第${ch.number}章 ${ch.title}】\n${trimmed}`;
      }).join("\n\n");
      sourceBlock = `\n原作本文 (全${total}字を章ごとに比例配分で抜粋。各章の全文が必要な時は章番号を挙げてユーザーに原作タブを案内):\n---\n${body}\n---\n`;
    }
  } else if (project.sourceText) {
    const t = project.sourceText.slice(0, SOURCE_TEXT_CAP);
    sourceBlock = `\n原作本文 (先頭${t.length}字${project.sourceText.length > SOURCE_TEXT_CAP ? "、以降省略" : ""}):\n---\n${t}\n---\n`;
  }

  return `あなたは著作権切れ小説を縦型ショート動画(9:16)の連載に変換する制作アシスタントです。

プロジェクト: 「${project.title}」(${project.author || "作者不明"})
絵柄方針: ${project.styleGuide || "(未設定)"}
世界観・トーン: ${project.worldSetting || "(未設定)"}

制作メモ (あなたが管理する長期記憶。細かい設定・作画の趣向・決定済みの方向性):
${aiNotes || "(まだ何も記録されていません)"}

作画基準画像: ${styleRefCount ? `${styleRefCount} 枚登録済み (すべての画像生成に自動で同梱され、絵柄がこれに寄る)` : "未登録。ユーザーが見本画像を添付して「これを基準に」と言ったら set_style_reference で登録すること (文章だけで絵柄を再現しようとしない)"}

制作資料・小物 (名前がプロンプトに含まれると画像生成時に自動で参照される):
${assets.length ? assets.map((a) => `- ${a.name}${a.note ? `: ${a.note}` : ""}`).join("\n") : "(まだ資料がありません。人物対比図・小物・美術ボード等はユーザーが添付した時に save_asset で保存できる)"}

登録済みキャラクター:
${charLines}

登録済みの場所 (シーン背景の統一性のためカットごとに場所を指定する):
${locLines}
${chaptersBlock}${sourceBlock}
${episodeBlock}

${missingBlock}

役割:
- 現在の制作状態を理解し、次に必要な作業と不足している素材を具体的に指摘する。
- 初期構造化 (取り込み・キャラ下書き) が終わった直後の段階では、まず「方向性詰め」を
  手伝う: 絵柄 (styleGuide の具体化)、画像の粒度 (1話を何カットで割るか・どこまで細かく
  画にするか)、トーン。ここが決まってからキャラ参照画像 → 話の切り出しに進める。
- 話数割り・脚本・カット割りでは実際のアニメの編集感覚で緩急をつける:
  原作の章と話数を 1:1 にせず、説明的で地味な部分は大胆に圧縮し (複数章を数秒に)、
  見せ場 (対決・怪異・情念) はカットを増やして引き伸ばす。判断基準は「画になるか」。
- 素材が揃っていない場合は動画生成に進めるよう促さず、何を決めるべきかを案内する。
- キャラクターの見た目は identityTokens (識別子) を毎回一貫させるよう助言する。
- 場所 (背景) も同様に統一する。カットには極力「場所」を設定させ、同じ場所は同じ
  識別子・参照画像を使い回すよう案内する。
- ユーザーが素材を確定したら、次のステートへ進める提案をする。
- タイムライン編集の最終判断はユーザー。配置案の提案はしてよいが決定はしない。
- 原作本文が上に与えられている場合は、章番号を引きながら具体的に答える
  (「第3章のこの描写だと…」)。与えられていない場合は章 index の要約を使う。
- 日本語・簡潔・具体的な次の一手で答える。前置きの相槌は最小限に。
- チャット UI はマークダウンを描画しない。見出し記号 (#) や強調 (**) は使わず、
  プレーンテキスト + 改行 + 箇条書きは「・」だけで書く。
- 画像を作ってほしいと言われたら (キャラの参照画像案・キービジュアル案・雰囲気ボード等)、
  返答本文の最後に次の形式の行を足す: [画像生成: 画像生成用のプロンプト]
  プロンプトには絵柄 (styleGuide) と該当キャラ/場所の識別子を必ず織り込む。
  1 メッセージにつき最大 2 枚。この行はシステムが検出して実際に画像を生成する。
- 既にある画像への変更 (「これに髭つけて」「この画像の髪を短く」等) は、生成ではなく
  [画像編集: 変更指示] を使う。編集対象はシステムが「引用画像 > 今回の添付 >
  会話の最後の画像」の順で自動解決する。ゼロから作り直すより編集の方が
  デザインが保たれるので、既存画像への修正は必ずこちら。
- 過去の画像 (ユーザーが送った / あなたが生成した) を「もう一度見せて」「あの画像出して」
  「〇〇の画像わかる?」と言われたら、再生成せず [画像再掲: 番号] と書く。番号は添付の
  「(会話の画像k)」ラベルの k。書式は必ず角括弧の [画像再掲: 1]。
  「(会話の画像1)」とだけ書いてもユーザーには画像が見えない (ラベルはあなたにしか
  見えない)。その画像がどれか判別できたら迷わず再掲する。
- 確定済みキャラ/場所の参照画像や登録済み資料は、会話に添付されていなくても
  [登録画像: キャラ名 2] (番号は画面の参照画像の並びで 1 始まり、省略で最後の 1 枚) /
  [資料画像: 資料名] で見せられる。「確定した立ち姿もう一回見せて」のような依頼はこちら。
- どのルートでも該当画像が特定できない時は正直にそう言い、その画像の引用か再添付を
  頼む (それらしい別画像を勝手に再掲しない)。
- 「〇〇の画像を web から探して」「実物の資料が見たい」と言われたら
  [画像検索: 検索語1 / 検索語2 / 検索語3] を書く (1 返答 1 個まで)。
  「探して/探してきて/見つけてきて」は必ずこのマーカー。[画像生成:] で代用しない
  (生成は「作って/描いて」と言われた時だけ)。
  Wikimedia Commons / Openverse (パブリックドメイン・CC 中心) を検索する。
  検索語は 2〜4 語で「具体的 → 広い」の順に 2〜3 案。必ず英語で書く
  (日本語の検索語はほぼ 0 件になる。日本の固有名詞だけローマ字可)。
  例: [画像検索: kirishitan banner / nanban screen christian / christian missionary japan painting]
  結果はシステムが出典付きで貼るので、本文は「探します」程度でよい
  (件数や内容を先回りして書かない)。時代考証の参考・雰囲気ボード用で、
  そのまま作画に使うものではない (作画は参照画像として生成に渡す)。
  注意: Web 検索で文章の知識を調べるのとは別物。画像を「探して/見せて」と
  言われた返答では、文章の解説だけで終わらせず必ずこのマーカーを書く
  (マーカーが無いと画像は表示されない)。

キャラクター登録を手伝うとき:
- 原作本文が与えられていればまずそれを根拠にする。青空文庫等で公開されている作品は
  Web 検索で補足調査して description / identityTokens / appearancePrompt の草案を提案してよい。
- 検索結果は自分の言葉で要約して提示する (原文の長い引用はしない)。出典が分かれば
  一言添える。
- ユーザーが画像を添付してきたら、その画像の内容 (雰囲気・構図・スタイル) を読み取って
  プロンプトや参照画像の方針に反映する。

設定の操作 (あなたは提案するだけでなく、実際に設定を書き換えられる):
ユーザーと方向性・設定が決まったら、口頭案内で終わらせず実際に操作を実行する。
返答本文の最後に次のブロックを書くと、システムが実行して結果をユーザーに通知する:

<<<ACTIONS
[
  {"action":"update_project","styleGuide":"新しい絵柄方針","worldSetting":"新しい時代背景"},
  {"action":"update_notes","notes":"制作メモの全文"},
  {"action":"create_character","name":"名前","reading":"よみ","description":"人物像","identityTokens":["識別子"],"appearancePrompt":"画像生成プロンプト"},
  {"action":"update_character","name":"既存キャラ名","description":"変更したいフィールドだけ書く"},
  {"action":"delete_character","name":"名前"},
  {"action":"create_location","name":"場所名","description":"説明","identityTokens":["識別子"],"appearancePrompt":"背景プロンプト"},
  {"action":"update_location","name":"既存の場所名","identityTokens":["新しい識別子"]},
  {"action":"delete_location","name":"場所名"},
  {"action":"create_episode","number":5,"title":"話タイトル","chapterNumbers":"7,8","pacing":"normal","focus":"見せ場"},
  {"action":"update_episode","number":5,"title":"変更したいフィールドだけ","pacing":"stretch","focus":"...","script":"脚本全文","chapterNumbers":"7"},
  {"action":"delete_episode","number":5},
  {"action":"generate_script","episodeNumber":5},
  {"action":"generate_cuts","episodeNumber":5},
  {"action":"confirm_character","name":"キャラ名","source":"quoted"},
  {"action":"confirm_location","name":"場所名"},
  {"action":"remove_character_image","name":"キャラ名","index":"1,2"},
  {"action":"remove_location_image","name":"場所名","index":"all"},
  {"action":"set_style_reference"},
  {"action":"clear_style_reference"},
  {"action":"save_asset","name":"人物対比図","note":"全キャラのサイズ確認用"},
  {"action":"delete_asset","name":"人物対比図"}
]
ACTIONS>>>

ルール:
- 操作が不要な返答では書かない。update/create は決まったらためらわず実行してよい。
- delete 系はユーザーが明示的に削除を頼んだ時だけ。
- update_project / update_character 等の反映は即時。実行したら本文でも一言触れる。
- update_notes はあなたの長期記憶の全文置き換え。決定事項が増えるたびに、これまでの
  内容と統合して書き直す (箇条書き・2000字以内)。作画の趣向・キャラの細かい設定・
  トーンの決定・やらないと決めたこと、を残す。
- generate_script / generate_cuts は AI 生成を実行する重い操作 (数十秒・数円かかる)。
  1 メッセージにつきどちらか 1 件まで。既に脚本/カットがある話への再生成は、
  ユーザーが作り直しを明示した時だけ (既存の内容は上書き/削除される)。
- set_style_reference / save_asset は「今回のメッセージに添付された画像」を保存する。
  ユーザーが見本や資料 (対比図・小物・美術ボード等) を添付してきたら保存を提案し、
  同意があれば (または保存の意図が明確なら) 実行する。
- confirm_character / confirm_location: ユーザーが「これで確定」と言ったら実行する。
  どの画像を確定するかは "source" で明示する:
  "generated" = この返答で生成した画像 / "quoted" = ユーザーが引用したメッセージの画像 /
  "attached" = 今回の添付 / "recent" = 直近の会話の最後の画像。
  引用付きで「これ確定して」と言われたら必ず "source":"quoted"。
  省略時は 生成 > 引用 > 添付 > 直近 の順で自動選択される。
  その画像がキャラ/場所の参照画像に追加され、status が確定になる。
  確定の解除やステータス変更は update_character / update_location の status で行う。
- remove_character_image / remove_location_image: 参照画像を外す。index は画面の並び順で
  1 始まり。複数枚は必ず 1 つのアクションで "index":"1,2" とまとめる (アクションを
  分けると 1 枚消すたびに番号がズレる)。"index":"all" で全部外す。
  間違って確定した画像を消したい時に使う。何枚あるかは前提情報の「参照画像 N枚」で
  分かる。どれが何枚目か不明ならユーザーに「左から何枚目?」と聞いてから実行する。
- 数値のリスト (index / chapterNumbers) は必ず "1,2" のようなカンマ区切りの文字列で書く。
  [1,2] のような数字だけの配列は本文から欠落することがあり、値が空になって失敗する。
- 「⚙ 実行:」の行はシステムが実行結果として自動で付けるもの。あなた自身は絶対に書かない。
  本文で「削除しました」と言うだけでは何も起きない — 設定を変える時は必ず ACTIONS
  ブロックを書く。

会話の作法 (重要):
- 画像生成 ([画像生成:] マーカー) はユーザーが明示的に画像を求めた時だけ。
  方針の相談・まとめの返答で勝手に生成しない。
- 少し前のメッセージへの返信だと明確にしたい時は、返答の先頭に [引用: 番号] と書くと
  そのメッセージが LINE の返信のように引用表示される。番号は会話ログの (#n)。
  直前のメッセージに普通に答えるだけの時は不要。
- 長い返答は [メッセージ区切り] で複数の吹き出しに分けてよい (最大 3 通)。
  例: 説明のバブル [メッセージ区切り] こんなのどうですか? ← 画像は最後の吹き出しに付く。
- 謝罪や同じ前置きを繰り返さない。1 回の返答に謝罪は最大 1 回・一言まで。要点から書く。
- 直近の会話の画像はあなたに見えている。画像の比較・差分の指摘・「前の画像のここを直す」
  ができる。見えていないふりをしない。`;
}

// userMessage: string
// imageParts: 今回のメッセージの添付 [{ inlineData }]
// historyImageParts: 直近の会話に出た画像 (ユーザー添付 + AI 生成)。過去の画像と
// 比較しながら答えたり作り直したりできるように毎回渡す。
export async function chatOnce(callGemini, systemPrompt, history, userMessage, imageParts = [], historyImageParts = [], quoted = { text: "", parts: [] }) {
  const historyText = (history || [])
    .map((h) => `${h.role === "assistant" ? "アシスタント" : "ユーザー"}${h.id ? `(#${h.id})` : ""}: ${h.content}${(h.images || []).length ? ` (画像${h.images.length}枚)` : ""}`)
    .join("\n\n");
  const quotedParts = quoted.parts || [];
  const quotedNote = (quoted.text || quotedParts.length)
    ? `\n(ユーザーは過去のメッセージを引用している${quoted.text ? `: 「${quoted.text}」` : ""}${quotedParts.length ? `。引用メッセージの画像 ${quotedParts.length} 枚を添付の最初に付けてある — 今回の指示はこの画像が対象。画像生成する場合もこの画像が最優先の参照になる` : ""})`
    : "";
  const imgNote = (historyImageParts.length || imageParts.length)
    ? `\n(添付画像の並び: ${quotedParts.length ? `引用 ${quotedParts.length} 枚 → ` : ""}直近の会話の画像 ${historyImageParts.length} 枚 (古い順・各画像の直前に「(会話の画像k)」ラベル付き。[画像再掲: k] でその画像をそのまま返信に貼れる) → 今回の添付 ${imageParts.length} 枚)`
    : "";
  const prompt = `${systemPrompt}\n\n${historyText ? `これまでの会話:\n${historyText}\n\n` : ""}ユーザー: ${userMessage}${quotedNote}${imgNote}\n\nアシスタント:`;
  // 履歴画像は番号ラベルを直前に挟む ([画像再掲: k] の k がどれを指すか一意にするため)
  const labeledHistory = historyImageParts.flatMap((p, i) => [{ text: `(会話の画像${i + 1})` }, p]);
  const allParts = [...quotedParts, ...labeledHistory, ...imageParts];
  const content = allParts.length ? [prompt, ...allParts] : prompt;
  const { result } = await callGemini(content, {
    primaryModel: "gemini-2.5-flash",
    // 2.5 系は thinking トークンも上限に含まれるため、少ないと本文が途中で切れる
    // (実際に切れた)。余裕を持たせる
    maxOutputTokens: 8000,
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
  ],
  "locations": [
    {
      "name": "主要な場所の呼び名 (本文の表記で。例: 堀川の御屋形)",
      "description": "場所の説明 (80字以内。どんな場面で使われるか)",
      "identityTokens": ["背景の識別子を3-5個 (例: 朱塗りの門、篝火、砂利の前庭)"],
      "appearancePrompt": "この場所の背景画像生成プロンプト案 (100字以内)"
    }
  ]
}
characters は物語を動かす主要人物だけ (最大8人)。本文に容姿描写があればそれを identityTokens に優先採用。
locations は繰り返し登場する舞台だけ (最大8箇所)。背景の統一性のために使う。`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    // 2.5 系は thinking トークンも maxOutputTokens に含まれるため、余裕を持たせないと
    // JSON が途中で切れて「キャラが1人も登録されない」事故になる (実際に起きた)
    maxOutputTokens: 16000,
    jsonMode: true,
  });
  const t = (result.response.text() || "").trim();
  const j = parseJsonLoose(t);
  if (!j) throw new Error("作品解析のレスポンスから JSON 取れず: " + t.slice(0, 100));
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
    locations: (Array.isArray(j.locations) ? j.locations : []).slice(0, 8).map((l) => ({
      name: String(l.name || "").slice(0, 50),
      description: String(l.description || "").slice(0, 300),
      identityTokens: (Array.isArray(l.identityTokens) ? l.identityTokens : []).map((s) => String(s).slice(0, 30)).slice(0, 6),
      appearancePrompt: String(l.appearancePrompt || "").slice(0, 300),
    })).filter((l) => l.name),
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
    maxOutputTokens: 4000,
    useGoogleSearch: true,
  });
  const t = (result.response.text() || "").trim();
  const j = parseJsonLoose(t);
  if (!j) return [];
  return (Array.isArray(j.results) ? j.results : []).slice(0, 5);
}

// ── 編集方針 (シリーズ構成・脚本・カット割りの全プロンプトに共通で入れる) ──
// 「1章=1話にしない」が肝。実際のアニメ (例: 呪術廻戦) と同じ緩急のつけ方。
const PACING_PRINCIPLE = `編集方針 (重要):
- 原作の章と話数を 1:1 で対応させない。映像として地味な部分は大胆に端折る。
- 説明・状況描写・回想などの静的なパートは圧縮する (複数章を数カットやナレーション数秒にまとめてよい)。
- 見せ場 (対決、怪異、情念の爆発、運命の転換点) は逆に引き伸ばす。カットを増やし、間や表情も画にする。
- 各話は必ず「掴み (最初の2秒で目を留めさせる)」と「引き (次話を見たくなる切り方)」を持つ。
- 判断基準は「画になるか」。画にならない情報は捨てるかナレーション一言に落とす。`;

// 決定済みの方向性 (制作メモ・時代背景・絵柄) を生成系プロンプトに共通で挿す
function directionBlock({ aiNotes, worldSetting, styleGuide }) {
  const parts = [];
  if (styleGuide) parts.push(`絵柄: ${styleGuide}`);
  if (worldSetting) parts.push(`世界観・トーン: ${worldSetting}`);
  if (aiNotes) parts.push(`制作メモ (チャットで決定済みの方向性・趣向。必ず従う):\n${aiNotes}`);
  return parts.length ? `\n${parts.join("\n")}\n` : "";
}

// シリーズ構成: 章一覧から話数割りを提案する (緩急をつけて、1章1話にしない)
export async function composeSeries(callGemini, { title, author, chapters, targetDurationSec = 60, aiNotes, worldSetting, styleGuide }) {
  const chapterLines = chapters.map((ch) =>
    `第${ch.number}章「${ch.title}」(${ch.charCount}字)${ch.summary ? `: ${ch.summary}` : ""}`
  ).join("\n");
  const prompt = `「${title}」(${author || "作者不明"}) を 1 話約${targetDurationSec}秒の縦型ショート動画の連載にします。
あなたはシリーズ構成の担当です。
${directionBlock({ aiNotes, worldSetting, styleGuide })}
${PACING_PRINCIPLE}

原作の章一覧:
${chapterLines}

全体の話数割りを JSON のみで返してください (前置き禁止):
{
  "episodes": [
    {
      "number": 1,
      "title": "この話のタイトル (キャッチーに、15字以内)",
      "chapterNumbers": [1, 2],
      "pacing": "compress" | "normal" | "stretch",
      "focus": "この話の見せ場・掴み・引きを1-2文で"
    }
  ]
}
- 地味な章は複数まとめて compress、見せ場の章は 1 章を複数話に割って stretch してよい
  (その場合は同じ chapterNumbers を複数話に入れ、focus で範囲を区別する)。
- 未完の作品の場合、最終話は「引き」で終わらせるか注記する。`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 16000,
    jsonMode: true,
  });
  const j = parseJsonLoose((result.response.text() || "").trim());
  if (!j || !Array.isArray(j.episodes)) throw new Error("シリーズ構成のレスポンスから JSON 取れず");
  return j.episodes.slice(0, 60).map((e, i) => ({
    number: Number(e.number) || i + 1,
    title: String(e.title || "").slice(0, 60),
    chapterNumbers: (Array.isArray(e.chapterNumbers) ? e.chapterNumbers : []).map(Number).filter((n) => !isNaN(n)),
    pacing: ["compress", "normal", "stretch"].includes(e.pacing) ? e.pacing : "normal",
    focus: String(e.focus || "").slice(0, 300),
  }));
}

// 脚本: 割り当てられた章の本文から話単位の脚本を書く
export async function writeScript(callGemini, { title, author, styleGuide, episode, chapterTexts, characters, aiNotes, worldSetting }) {
  const charNames = characters.map((c) => c.name).join("、");
  const prompt = `「${title}」(${author || "作者不明"}) の第${episode.number}話「${episode.title || ""}」の脚本を書いてください。
1 話は約${episode.targetDurationSec || 60}秒の縦型ショート動画。ナレーションは 300〜350 字が上限の目安。
${directionBlock({ aiNotes, worldSetting, styleGuide })}
${PACING_PRINCIPLE}

この話の方針: ${episode.pacing === "compress" ? "圧縮 (原作の情報を大胆に間引く)" : episode.pacing === "stretch" ? "引き伸ばし (見せ場をじっくり画にする)" : "標準"}
見せ場: ${episode.focus || "(未指定)"}
登場人物: ${charNames || "(未登録)"}

原作該当部分:
---
${chapterTexts}
---

脚本の形式 (プレーンテキストで返す。JSON 不要):
- ナレーション行は「N: 」で始める
- セリフ行は「人物名: 」で始める
- ト書き (画の指示) は「◆ 」で始める
- 掴み → 本編 → 引き の順で。全体で画面 8 カット前後を想定`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 8000,
  });
  return (result.response.text() || "").trim();
}

// カット割り (絵コンテの設計図): 脚本から 8 秒×Nカットの構成を起こす
export async function composeCuts(callGemini, { title, styleGuide, episode, script, characters, locations, aiNotes, worldSetting }) {
  const charList = characters.map((c) => `id=${c.id}: ${c.name}`).join(" / ") || "(なし)";
  const locList = locations.map((l) => `id=${l.id}: ${l.name}`).join(" / ") || "(なし)";
  const prompt = `「${title}」第${episode.number}話のカット割り (絵コンテの設計) を作ってください。
1 カット 4〜10 秒、合計で約${episode.targetDurationSec || 60}秒。縦 9:16。
${directionBlock({ aiNotes, worldSetting, styleGuide })}
${PACING_PRINCIPLE}

脚本:
---
${script}
---

登録済みキャラ: ${charList}
登録済みの場所: ${locList}

JSON のみで返す (前置き禁止):
{
  "cuts": [
    {
      "durationSec": 8,
      "prompt": "このカットの動画生成プロンプト (構図・動き・感情を具体的に。絵柄指示込み)",
      "characterIds": [登場キャラの id 数値],
      "locationId": 場所の id 数値 または null,
      "narration": "このカットに載せるナレーション (なければ空)",
      "subtitle": "画面に出す字幕 (なければ空)"
    }
  ]
}`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 16000,
    jsonMode: true,
  });
  const j = parseJsonLoose((result.response.text() || "").trim());
  if (!j || !Array.isArray(j.cuts)) throw new Error("カット割りのレスポンスから JSON 取れず");
  return j.cuts.slice(0, 15).map((c) => ({
    durationSec: Math.max(4, Math.min(10, Number(c.durationSec) || 8)),
    prompt: String(c.prompt || "").slice(0, 1000),
    characterIds: (Array.isArray(c.characterIds) ? c.characterIds : []).map(String),
    locationId: c.locationId ? String(c.locationId) : null,
    narration: String(c.narration || "").slice(0, 500),
    subtitle: String(c.subtitle || "").slice(0, 200),
  }));
}

// 生成画像のセルフレビュー: 「ユーザーの依頼」を正として AI 自身が見て判定。
// NG なら前の画像への具体的な修正指示を返す (呼び出し側が編集モードで最大2回作り直す)。
// 意味のない作り直しを避けるため:
//  - 判定の正はユーザーの依頼文 (AI が組んだ生成指示ではなく)
//  - 編集の時は元画像も渡して「頼まれた変更以外が変わってないか」を見る
//  - 絵柄はタッチ・線・色調だけ (基準画像がキャラシートで生成物が小物、は正常)
export async function reviewGeneratedImage(callGemini, { prompt, userRequest, styleGuide, imageBase64, mimeType, styleRefParts = [], baseImagePart = null }) {
  const layout = [];
  if (baseImagePart) layout.push("最初の 1 枚は「編集前の元画像」");
  if (styleRefParts.length) layout.push(`${baseImagePart ? "続く" : "最初の"} ${styleRefParts.length} 枚は「作画基準画像」(絵柄の見本)`);
  const ask = `${layout.length ? layout.join("、") + "、" : ""}最後の 1 枚が今回の生成結果です。
この生成結果を審査してください。

${userRequest ? `ユーザーの依頼 (これが正): ${userRequest}\n` : ""}生成指示: ${prompt}
${styleGuide ? `絵柄方針: ${styleGuide}` : ""}

チェック観点 (重要な順):
1. ユーザーの依頼が満たされているか (頼まれた被写体・変更が反映されているか)。
   「頼まれていない要素」として NG にできるのは、依頼にも生成指示にも無い明らかな
   異物 (別キャラクターの乱入・注釈文字・別の小物など) だけ。
   生成指示に書かれている要素 (持ち物・シンボル・背景・構図) は、依頼文に出てこなくても
   意図されたもの — 「依頼文に無いから」という理由で削らせてはいけない。
   依頼と生成指示が真っ向から矛盾する時だけ依頼を優先する。
${baseImagePart ? `2. 編集前の元画像のデザイン・構図・キャラが保たれているか (指示された変更以外が
   変わっていないか)
` : ""}3. 破綻 (手・顔・文字化け等) / キャラクターシート風のレイアウト・注釈文字・
   複数ポーズ一覧になっていないか
4. 絵柄はタッチ・線・色調だけ見る。被写体が基準画像と違うのは問題にしない
   (小物単体の依頼で基準がキャラ画像、など)

JSON のみで返す (前置き禁止):
{
  "ok": true か false,
  "problems": "NG の場合、ユーザーの依頼に対して何がダメか 1-2 文 (ユーザーにそのまま見せる文)",
  "fixInstruction": "NG の場合、前の画像への具体的な修正指示 1-2 文 (例: キャラクターを消してのぼり単体にする / 髭は残したまま唇だけ薄くする)"
}
ユーザーが見て不満に思うレベルの時だけ false。絵柄の軽微な違い・好みの範囲は ok=true。`;
  const { result } = await callGemini(
    [ask, ...(baseImagePart ? [baseImagePart] : []), ...styleRefParts, { inlineData: { data: imageBase64, mimeType: mimeType || "image/png" } }],
    { primaryModel: "gemini-2.5-flash", maxOutputTokens: 4000, jsonMode: true }
  );
  const j = parseJsonLoose((result.response.text() || "").trim());
  if (!j) return { ok: true, problems: "", fixInstruction: "" }; // 審査不能なら作り直さない
  return {
    ok: j.ok !== false,
    problems: String(j.problems || "").slice(0, 300),
    fixInstruction: String(j.fixInstruction || j.revisedPrompt || "").slice(0, 500),
  };
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
    maxOutputTokens: 4000,
    jsonMode: true,
  });
  const text = (result.response.text() || "").trim();
  const j = parseJsonLoose(text);
  if (!j) throw new Error("章解析のレスポンスから JSON 取れず: " + text.slice(0, 100));
  return {
    summary: String(j.summary || "").slice(0, 300),
    characterNames: Array.isArray(j.characterNames) ? j.characterNames.map((s) => String(s).slice(0, 50)).slice(0, 30) : [],
  };
}
