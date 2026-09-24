import { onScopeDispose, ref, watch, type Ref } from 'vue';

const BOTTOM_TOLERANCE = 2;

/**
 * 只在用户停留底部时跟随内容增长。用户向上滚动会立即取消待执行的滚动，
 * 回到底部或主动点击“最新”后恢复；对话与工具日志使用同样的交互规则。
 */
export function useFollowScroll(
  viewport: Readonly<Ref<HTMLElement | null>>,
  content: Readonly<Ref<HTMLElement | null>>,
) {
  const following = ref(true);
  let frame: number | undefined;
  let lastTop = 0;
  let touchY: number | undefined;

  function pause() {
    following.value = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  function schedule() {
    if (!following.value || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const element = viewport.value;
      if (!following.value || !element) return;
      element.scrollTop = element.scrollHeight;
      lastTop = element.scrollTop;
    });
  }

  function scrollToLatest() {
    following.value = true;
    schedule();
  }

  function onScroll() {
    const element = viewport.value;
    if (!element) return;
    const top = element.scrollTop;
    if (element.scrollHeight - top - element.clientHeight <= BOTTOM_TOLERANCE) following.value = true;
    else if (top < lastTop) pause();
    lastTop = top;
  }

  function onWheel(event: WheelEvent) {
    // wheel 先于 scroll 到达，避免同一帧的流式更新抢先把位置拉回底部。
    if (event.deltaY < 0 && viewport.value?.scrollTop) pause();
  }

  function onTouchStart(event: TouchEvent) {
    touchY = event.touches[0]?.clientY;
  }

  function onTouchMove(event: TouchEvent) {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next > touchY && viewport.value?.scrollTop) pause();
    touchY = next;
  }

  function onKeydown(event: KeyboardEvent) {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pause();
  }

  watch(
    [viewport, content],
    ([element, body], _previous, cleanup) => {
      lastTop = element?.scrollTop ?? 0;
      const observer = new ResizeObserver(schedule);
      if (element) observer.observe(element);
      if (body) observer.observe(body);
      schedule();
      cleanup(() => observer.disconnect());
    },
    { flush: 'post' },
  );
  onScopeDispose(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  return {
    following,
    scrollToLatest,
    pause,
    onScroll,
    onWheel,
    onTouchStart,
    onTouchMove,
    onKeydown,
  };
}
