import { h } from "preact";
import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";

const TOAST_MS = 6000;

export const toast = signal(null);

export function showToast(message, { onClick } = {}) {
  toast.value = { message, onClick, id: Date.now() };
}

export function Toast() {
  const t = toast.value;

  // Start the countdown only once the page is visible, so a toast raised while
  // the reader is in another tab is still there when they come back.
  useEffect(() => {
    if (!t) return;
    let timer = null;
    const start = () => {
      if (document.hidden || timer) return;
      timer = setTimeout(() => {
        if (toast.value?.id === t.id) toast.value = null;
      }, TOAST_MS);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", start);
    };
  }, [t?.id]);

  if (!t) return null;

  const handleClick = () => {
    toast.value = null;
    t.onClick?.();
  };

  return (
    <div className="toast" role="status" aria-live="polite" key={t.id} onClick={handleClick}>
      {t.message}
    </div>
  );
}
