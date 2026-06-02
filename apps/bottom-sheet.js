// 共通 BottomSheet コンポーネント (Vue 3 esm-browser 用)。
//
// 機能:
// - v-model でモーダル開閉。backdrop タップで閉じる
// - title プロップでヘッダー表示
// - 上部ハンドルを下にドラッグで閉じる (距離 / 速度しきい値)
// - body はスクロール可能 (overflow-y: auto)
// - 中身は <slot> で自由
//
// 使い方:
//   import { BottomSheet } from "/bottom-sheet.js";
//   createApp(App).component('bottom-sheet', BottomSheet).mount('#app');
//   <bottom-sheet v-model="open" title="アーカイブ"> ...slot... </bottom-sheet>

import { ref, computed, watch } from "https://unpkg.com/vue@3.4.27/dist/vue.esm-browser.prod.js";

// グローバル CSS は 1 回だけ inject
const STYLE_ID = "_bottomsheet_styles_v1";
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
  transform: translateY(100%); transition: transform 200ms cubic-bezier(.2,.8,.2,1); }
.bs-modal.open .bs-sheet { transform: translateY(0); }
.bs-handle-area { padding: 8px 0; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.bs-handle-area:active { cursor: grabbing; }
.bs-handle { width: 46px; height: 5px; border-radius: 3px; background: rgba(168,172,192,0.45); margin: 0 auto; }
.bs-title { font-size: 17px; font-weight: 800; margin: 2px 4px 14px; }
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
  },
  emits: ["update:modelValue"],
  template: `
    <div class="bs-modal" :class="{ open: modelValue }" @click="onBgClick">
      <div class="bs-sheet" :style="sheetStyle" @click.stop>
        <div class="bs-handle-area"
             @pointerdown="onDown"
             @pointermove="onMove"
             @pointerup="onUp"
             @pointercancel="onUp">
          <div class="bs-handle"></div>
        </div>
        <div v-if="title" class="bs-title">{{ title }}</div>
        <slot></slot>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const dragY = ref(0);
    const dragging = ref(false);
    let startY = null;

    // dragY > 0 のときだけ inline transform を当てる。
    // 閉じてる時 (modelValue=false) は何も当てない → CSS の translateY(100%) が走って下に消える。
    const sheetStyle = computed(() => {
      if (!props.modelValue) return {};
      if (dragging.value || dragY.value > 0) {
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
      dragging.value = true;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch (_) {}
    }
    function onMove(e) {
      if (startY === null) return;
      const dy = e.clientY - startY;
      dragY.value = Math.max(0, dy);   // 上方向はクランプ
    }
    function onUp() {
      if (startY === null) return;
      const shouldClose = dragY.value > props.dismissThreshold;
      dragging.value = false;
      startY = null;
      if (shouldClose) {
        emit("update:modelValue", false);
        // dragY はそのまま残し、CSS の translateY(100%) が引き継いで close 続行
      } else {
        dragY.value = 0;  // スナップバック (computed の transition で 200ms)
      }
    }

    return { sheetStyle, onBgClick, onDown, onMove, onUp };
  },
};
