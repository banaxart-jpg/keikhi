// 既存 keihi-api の callGeminiWithFallback を使うので genAI 直接呼び出しではなく、
// 「呼び出し関数を inject する」設計にして循環依存を避ける (fx-lib/ai.js と同じ流儀)。
// callGemini = (prompt, opts) => Promise<{result, modelUsed, attempts}>

// 制作アシスタントのシステムプロンプトを毎回組み立てる。
// missingInfo (state.js の computeMissingInfo) を埋め込むことで、
// 「素材が揃うまで動画生成に進ませない」を AI にも徹底させる。
export function buildSystemPrompt({ project, characters, episode, cuts, missingInfo }) {
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

  return `あなたは著作権切れ小説を縦型ショート動画(9:16)の連載に変換する制作アシスタントです。

プロジェクト: 「${project.title}」(${project.author || "作者不明"})
絵柄方針: ${project.styleGuide || "(未設定)"}
世界観・トーン: ${project.worldSetting || "(未設定)"}

登録済みキャラクター:
${charLines}

${episodeBlock}

${missingBlock}

役割:
- 現在の制作状態を理解し、次に必要な作業と不足している素材を具体的に指摘する。
- 素材が揃っていない場合は動画生成に進めるよう促さず、何を決めるべきかを案内する。
- キャラクターの見た目は identityTokens (識別子) を毎回一貫させるよう助言する。
- ユーザーが素材を確定したら、次のステートへ進める提案をする。
- タイムライン編集の最終判断はユーザー。配置案の提案はしてよいが決定はしない。
- 日本語・簡潔・具体的な次の一手で答える。前置きの相槌は最小限に。

キャラクター登録を手伝うとき:
- 原作が青空文庫等で公開されている著作権切れ作品の場合、Web 検索で人物像・容姿・
  関係性を調べて description / identityTokens / appearancePrompt の草案を提案してよい。
- 検索結果は自分の言葉で要約して提示する (原文の長い引用はしない)。出典が分かれば
  一言添える。最終確認と確定操作は必ずユーザーに委ねる。`;
}

export async function chatOnce(callGemini, systemPrompt, history, userMessage) {
  const historyText = (history || [])
    .map((h) => `${h.role === "assistant" ? "アシスタント" : "ユーザー"}: ${h.content}`)
    .join("\n\n");
  const prompt = `${systemPrompt}\n\n${historyText ? `これまでの会話:\n${historyText}\n\n` : ""}ユーザー: ${userMessage}\n\nアシスタント:`;
  const { result } = await callGemini(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: 1500,
    useGoogleSearch: true,
  });
  return (result.response.text() || "").trim();
}
