// 自動ドラマ作成: 制作の進み具合と「不足している素材」を判定する。
// AI チャットのシステムプロンプトにも、UI のチェックリスト表示にも同じ結果を使う。

export const EPISODE_STATES = [
  { id: "key_visual", label: "キービジュアル待ち" },
  { id: "cuts",        label: "カット割り待ち" },
  { id: "generating",  label: "動画生成中" },
  { id: "review",      label: "レビュー中" },
  { id: "timeline",    label: "タイムライン編集中" },
  { id: "exported",    label: "書き出し済み" },
];

// エピソードの実データから「今どの段階か」を導出する (state 列はこれで都度上書きする)。
export function recomputeEpisodeState(episode, cuts, timeline) {
  if (!episode?.keyVisual?.url) return "key_visual";
  if (!cuts.length) return "cuts";
  const anyGenerated = cuts.some((c) => (c.generations || []).length > 0);
  if (!anyGenerated) return "generating";
  const allSelected = cuts.every((c) => (c.generations || []).length > 0 && c.selectedGenerationIndex >= 0);
  if (!allSelected) return "review";
  if (timeline?.exportedVideoUrl) return "exported";
  return "timeline";
}

// 不足している素材・情報を日本語の箇条書きで返す。空配列 = 動画生成に進める状態。
export function computeMissingInfo({ project, characters, episode, cuts, locations = [] }) {
  const missing = [];
  const byId = new Map(characters.map((c) => [String(c.id), c]));
  const locById = new Map(locations.map((l) => [String(l.id), l]));

  const confirmed = characters.filter((c) => c.status === "confirmed");
  if (!confirmed.length) missing.push("確定済みのキャラクターがまだ1人もいません");

  if (!episode) return missing;

  const appearing = episode.appearingCharacterIds || [];
  if (!appearing.length) {
    missing.push(`第${episode.number}話: 登場キャラクターが未設定です`);
  }
  for (const cid of appearing) {
    const c = byId.get(String(cid));
    if (!c) continue;
    if (c.status !== "confirmed") missing.push(`「${c.name}」のキャラ設定がまだ確定していません`);
    else if (!(c.referenceImages || []).length) missing.push(`「${c.name}」の参照画像がまだありません`);
  }

  if (!episode.keyVisual?.url) missing.push(`第${episode.number}話: キービジュアルが未設定です`);
  if (!cuts.length) missing.push(`第${episode.number}話: カット割りがまだです`);

  for (const cut of cuts) {
    if (!cut.prompt) missing.push(`第${episode.number}話 カット${cut.order}: プロンプトが未設定です`);
    for (const cid of cut.characterIds || []) {
      const c = byId.get(String(cid));
      if (c && !(c.referenceImages || []).length) {
        missing.push(`第${episode.number}話 カット${cut.order}: 「${c.name}」の参照画像が無いため一貫性が保てません`);
      }
    }
    if (!cut.locationId) {
      missing.push(`第${episode.number}話 カット${cut.order}: 場所が未設定です (背景の統一性のため設定推奨)`);
    } else {
      const l = locById.get(String(cut.locationId));
      if (l && !(l.referenceImages || []).length) {
        missing.push(`第${episode.number}話 カット${cut.order}: 場所「${l.name}」の参照画像が無いため背景がブレます`);
      }
    }
  }
  return missing;
}

// このカットを動画生成に進めてよいか。
// キャラ: 確定済み + 参照画像必須。場所: 設定されている場合は参照画像必須
// (場所未設定は警告どまりで生成は通す)。
export function cutIsReadyForGeneration(cut, characters, locations = []) {
  const byId = new Map(characters.map((c) => [String(c.id), c]));
  const locById = new Map(locations.map((l) => [String(l.id), l]));
  const reasons = [];
  if (!cut.prompt) reasons.push("プロンプトが未設定です");
  for (const cid of cut.characterIds || []) {
    const c = byId.get(String(cid));
    if (!c) continue;
    if (c.status !== "confirmed") reasons.push(`「${c.name}」のキャラ設定が未確定です`);
    else if (!(c.referenceImages || []).length) reasons.push(`「${c.name}」の参照画像がありません`);
  }
  if (cut.locationId) {
    const l = locById.get(String(cut.locationId));
    if (l && !(l.referenceImages || []).length) reasons.push(`場所「${l.name}」の参照画像がありません`);
  }
  return { ready: reasons.length === 0, reasons };
}
