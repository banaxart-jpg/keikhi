// 現場タブの共通コンポーネント (bottom-sheet.js と同じ流儀: 1ファイル + CSS 自動 inject)。
// kaimono / task / genba-memo / genba-qa で個別実装されていた横スクロールの
// 現場タブ列を統一する。並び順・ラベル・件数はアプリ側の責務 (items で渡す)。
//
// 使い方:
//   import { SiteTabs, fetchSiteNames } from "/site-tabs.js";
//   createApp(App).component("site-tabs", SiteTabs).mount("#app");
//   <site-tabs :items="tabItems" :model-value="activeSite" @update:model-value="selectSite" />
//
// items: (文字列 | { key, label, count }) の配列。文字列なら key=label=その値。
// 色はアプリ側の CSS 変数 (--bg / --sd / --sl / --text2 / --accent / --accent2) を使うので
// アプリごとのアクセントカラーに勝手に馴染む。

const CSS = `
.st-tabs { display: flex; gap: 8px; padding: 4px 18px 14px; overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none; }
.st-tabs::-webkit-scrollbar { display: none; }
.st-tab { padding: 9px 16px; border-radius: 18px; font-size: 13px; font-weight: 700; border: none;
  color: var(--text2); background: var(--bg);
  box-shadow: 4px 4px 10px var(--sd), -4px -4px 10px var(--sl);
  cursor: pointer; flex-shrink: 0; font-family: inherit; transition: all 200ms ease; white-space: nowrap; }
.st-tab.on { color: white; background: linear-gradient(145deg, var(--accent2, var(--accent)), var(--accent));
  box-shadow: 6px 6px 14px color-mix(in srgb, var(--accent) 35%, transparent), -3px -3px 10px var(--sl); }
.st-tab .st-count { font-size: 11px; opacity: 0.75; margin-left: 5px; font-weight: 800; }
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

export const SiteTabs = {
  name: "SiteTabs",
  props: {
    items: { type: Array, default: () => [] },
    modelValue: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  computed: {
    normalized() {
      return this.items.map((it) =>
        typeof it === "string" ? { key: it, label: it, count: 0 } : { count: 0, ...it });
    },
  },
  created() { injectCss(); },
  template: `
    <div class="st-tabs">
      <button v-for="it in normalized" :key="it.key" type="button"
        class="st-tab" :class="{ on: modelValue === it.key }"
        @click="$emit('update:modelValue', it.key)">
        {{ it.label }}<span v-if="it.count" class="st-count">{{ it.count }}</span>
      </button>
    </div>
  `,
};

// /api/sites から「進行中の現場名」を取る共通ヘルパ。
// 完了現場 (doneAt 有り) の除外をここに一本化する (アプリごとの実装漏れ対策 — 実際に漏れた)。
// getJson: パスを受けて JSON を返す関数 (各アプリの認証付き fetch ラッパを渡す)
export async function fetchSiteNames(getJson) {
  const rows = await getJson("/api/sites");
  return (Array.isArray(rows) ? rows : [])
    .filter((x) => x && !x.doneAt)
    .map((x) => x.name)
    .filter(Boolean);
}
