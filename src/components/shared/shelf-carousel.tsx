import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { ShelfCard } from "@/components/shared/shelf-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Shelf } from "@/lib/innertube/types";

type Props = {
  shelf: Shelf;
  /** Optional control rendered at the right of the shelf header (e.g. "Show all"). */
  action?: ReactNode;
};

export function ShelfCarousel({ shelf, action }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const scrollByPage = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  // Make the carousel scroll horizontally with:
  //  - horizontal wheel / trackpad / scrollbar (native, via overflow-x)
  //  - click-and-drag panning, like YouTube Music's own carousels.
  // Vertical wheel deliberately falls through to page scroll so users
  // with a side-wheel mouse (or trackpad) don't get the carousel
  // hijacking their attempts to scroll the page down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Ramp the edge-fade mask in/out per side based on how far the
    // user is from each end. Fully off at the edge, fully on once
    // scrolled past FADE_RAMP px — gives a smooth fade-in instead of
    // a snap when scrolling starts.
    const FADE_RAMP = 56;
    const updateFade = () => {
      const distLeft = el.scrollLeft;
      const distRight = el.scrollWidth - el.clientWidth - el.scrollLeft;
      const alphaL = Math.max(0, 1 - distLeft / FADE_RAMP);
      const alphaR = Math.max(0, 1 - distRight / FADE_RAMP);
      el.style.setProperty("--fade-l", alphaL.toFixed(3));
      el.style.setProperty("--fade-r", alphaR.toFixed(3));
      setCanScrollLeft(distLeft > 1);
      setCanScrollRight(distRight > 1);
    };
    updateFade();
    el.addEventListener("scroll", updateFade, { passive: true });
    const ro = new ResizeObserver(updateFade);
    ro.observe(el);

    // Drag-to-scroll. Only kick in after a small threshold so plain clicks
    // still navigate into cards.
    let isDown = false;
    let dragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let pointerId = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      isDown = true;
      dragging = false;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
      pointerId = e.pointerId;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (!dragging && Math.abs(dx) > 5) {
        dragging = true;
        try {
          el.setPointerCapture(pointerId);
        } catch {
          /* noop */
        }
        el.style.cursor = "grabbing";
        el.style.userSelect = "none";
      }
      if (dragging) {
        e.preventDefault();
        el.scrollLeft = startScrollLeft - dx;
      }
    };
    const onPointerUp = () => {
      if (!isDown) return;
      isDown = false;
      if (dragging) {
        dragging = false;
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          /* noop */
        }
        el.style.cursor = "";
        el.style.userSelect = "";
        // Swallow the click that would otherwise fire on the card we
        // happened to finish the drag over.
        const suppress = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        el.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => {
          el.removeEventListener("click", suppress, { capture: true });
        }, 0);
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("scroll", updateFade);
      ro.disconnect();
    };
  }, []);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="truncate text-xl font-semibold tracking-tight">
          {shelf.title}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {action ? (
            <div>{action}</div>
          ) : shelf.subtitle ? (
            <span className="max-w-64 truncate text-sm text-muted-foreground">
              {shelf.subtitle}
            </span>
          ) : null}
          {(canScrollLeft || canScrollRight) && (
            <div
              className="flex items-center gap-2"
              aria-label="Carousel navigation"
            >
              <Button
                variant="outline"
                size="icon"
                aria-label={`Scroll ${shelf.title} left`}
                disabled={!canScrollLeft}
                onClick={() => scrollByPage(-1)}
                className="rounded-full"
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={`Scroll ${shelf.title} right`}
                disabled={!canScrollRight}
                onClick={() => scrollByPage(1)}
                className="rounded-full"
              >
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="shelf-scroll shelf-edge-fade flex min-w-0 gap-2 overflow-x-auto overflow-y-hidden pb-3"
      >
        {shelf.items.map((item) => {
          // Video covers keep the cover height equal to a square (album)
          // card by widening the slot to 16/9 — preserves the video
          // aspect without making the row visually uneven.
          const isVideo = item.kind === "video";
          return (
            <div
              key={`${item.kind}:${item.id}`}
              className={cn(
                "shrink-0",
                isVideo
                  ? "w-[calc(11rem*16/9)] md:w-[calc(12rem*16/9)] lg:w-[calc(13rem*16/9)]"
                  : "w-44 md:w-48 lg:w-52",
              )}
            >
              <ShelfCard item={item} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
