// 共通 BottomSheet コンポーネント (Vue 3 esm-browser 用)。
//
// 機能:
// - v-model でモーダル開閉。backdrop タップで閉じる
// - title プロップでヘッダー表示
// - 上部ハンドル / タイトル領域を下にドラッグで閉じる (距離しきい値)
// - expandable=true のとき: ハンドルを上に引っ張ると expanded=true をエミット
//   (parent は v-model:expanded で受けて、追加 UI を v-if で出す想定)
// - body はスクロール可能 (overflow-y: auto)
// - 中身は <slot> で自由
//
// 使い方:
//   import { BottomSheet } from "/bottom-sheet.js";
//   createApp(App).component('bottom-sheet', BottomSheet).mount('#app');
//   <bottom-sheet v-model="open" title="アーカイブ"> ...slot... </bottom-sheet>
//   <bottom-sheet v-model="open" expandable v-model:expanded="full"> ... </bottom-sheet>

import { ref, computed, watch } from "https://unpkg.com/vue@3.4.27/dist/vue.esm-browser.prod.js";

// グローバル CSS は 1 回だけ inject
const STYLE_ID = "_bottomsheet_styles_v2";
const CSS = `
.bs-modal { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center;
  background: rgba(180,184,205,0); visibility: hidden; opacity: 0; pointer-events: none; z-index: 50;
  transition: background 200ms ease, opacity 200ms ease, visibility 0s linear 200ms; }
.bs-modal.open { background: rgba(180,184,205,0.42); visibility: visible; opacity: 1; pointer-events: auto;
  transition: background 200ms ease, opacity 200ms ease, visibility 0s linear 0s; }
.bs-sheet { background: var(--bg, #e4e6ee); border-radius: 28px 28px 0 0;
  box-shadow: -2px -10px 30px rgba(148,152,176,0.35);
  width: 100%; max-width: 600px; max-height: 88vh; overflow-y: auto;
  padding: 6px 18px calc(28px + env(safe-area-inset-bottom));
  transform: translateY(100%);
  transition: transform 200ms cubic-bezier(.2,.8,.2,1), max-height 200ms ease, border-radius 200ms ease; }
.bs-modal.open .bs-sheet { transform: translateY(0); }
/* fullscreenOnExpand: 上スワイプ展開で全画面化 (opt-in) */
.bs-sheet.bs-full { height: 100dvh; max-height: 100dvh; border-radius: 0;
  padding-top: calc(6px + env(safe-area-inset-top)); }
/* grab area: handle + (あれば) title をまとめて掴める広い領域に。
   margin: 0 -18px で .bs-sheet の左右 padding を打ち消し、端まで掴める。 */
.bs-grab { padding: 14px 18px 10px; margin: 0 -18px 8px; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.bs-grab:active { cursor: grabbing; }
.bs-handle { width: 46px; height: 5px; border-radius: 3px; background: rgba(168,172,192,0.45); margin: 0 auto; }
.bs-title { font-size: 17px; font-weight: 800; margin: 10px 4px 0; }
`;
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export const BottomSheet = {
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: "" },
    // 閉じるしきい値 (px)。これより下にドラッグされたら close emit。
    dismissThreshold: { type: Number, default: 100 },
    // true のとき、ハンドルを上に引っ張ると expanded=true を emit。
    expandable: { type: Boolean, default: false },
    // 展開状態 (v-model:expanded)。expandable=true のときだけ意味を持つ。
    expanded: { type: Boolean, default: false },
    // 展開しきい値 (px、上方向の生の指移動量)。
    expandThreshold: { type: Number, default: 40 },
    // true のとき、expanded で sheet 自体を全画面化する (チャット等の没入 UI 用)。
    // kaimono の「展開で追加フォームを出す」用途は false のままで挙動不変。
    fullscreenOnExpand: { type: Boolean, default: false },
  },
  emits: ["update:modelValue", "update:expanded"],
  template: `
    <div class="bs-modal" :class="{ open: modelValue }" @click="onBgClick">
      <div class="bs-sheet" :class="{ 'bs-full': fullscreenOnExpand && expandable && expanded }" :style="sheetStyle" @click.stop>
        <div class="bs-grab"
             @pointerdown="onDown"
             @pointermove="onMove"
             @pointerup="onUp"
             @pointercancel="onUp">
          <div class="bs-handle"></div>
          <div v-if="title" class="bs-title">{{ title }}</div>
        </div>
        <slot></slot>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const dragY = ref(0);
    const dragging = ref(false);
    let startY = null;
    let rawDy = 0;  // 指の生移動量 (上下しきい値判定に使う)

    // dragY != 0 のときだけ inline transform を当てる。
    // 閉じてる時 (modelValue=false) は何も当てない → CSS の translateY(100%) が走る。
    const sheetStyle = computed(() => {
      if (!props.modelValue) return {};
      if (dragging.value || dragY.value !== 0) {
        return {
          transform: `translateY(${dragY.value}px)`,
          transition: dragging.value ? "none" : "transform 200ms cubic-bezier(.2,.8,.2,1)",
        };
      }
      return {};
    });

    // 閉じた後にドラッグ位置をリセット
    watch(() => props.modelValue, (v) => {
      if (!v) setTimeout(() => { dragY.value = 0; }, 240);
    });

    function onBgClick() { emit("update:modelValue", false); }

    function onDown(e) {
      startY = e.clientY;
      rawDy = 0;
      dragging.value = true;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch (_) {}
    }
    function onMove(e) {
      if (startY === null) return;
      rawDy = e.clientY - startY;
      if (rawDy >= 0) {
        dragY.value = rawDy;          // 下方向はそのまま追従
      } else if (props.expandable && !props.expanded) {
        dragY.value = rawDy / 3;      // 上方向は 1/3 抵抗で「引っ張れる」感
      } else {
        dragY.value = 0;              // expanded 中 or expandable=false は上に動かない
      }
    }
    function onUp() {
      if (startY === null) return;
      dragging.value = false;
      startY = null;
      if (rawDy > props.dismissThreshold) {
        // 下方向超過
        if (props.expandable && props.expanded) {
          // expanded → collapsed (1 段だけ閉じる)
          emit("update:expanded", false);
          dragY.value = 0;
        } else {
          // close (CSS translateY(100%) が引き継ぐので dragY は残す)
          emit("update:modelValue", false);
        }
      } else if (rawDy < -props.expandThreshold && props.expandable && !props.expanded) {
        // 上方向超過 → expand
        emit("update:expanded", true);
        dragY.value = 0;
      } else {
        // スナップバック
        dragY.value = 0;
      }
      rawDy = 0;
    }

    return { sheetStyle, onBgClick, onDown, onMove, onUp };
  },
};
