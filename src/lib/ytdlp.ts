import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { usePremiumStore } from "@/lib/store/premium";

type YtdlpState = {
  phase:
    "downloading" | "runtime" | "provider" | "ready" | "error" | "cancelled";
  message?: string | null;
};

const TOAST_ID = "ytdlp-setup";

function retryOfflineSetup(): void {
  const entitlement = usePremiumStore.getState();
  if (entitlement.status !== "premium" || entitlement.source !== "live") {
    toast.info(
      "Reconnect and verify YouTube Music Premium before retrying an offline download.",
    );
    return;
  }
  void invoke("ensure_ytdlp");
}

/**
 * Mount once in AppShell to mirror explicit offline-download setup events.
 * Merely opening Goosic never installs yt-dlp, Deno, or the PO provider; the
 * native playlist downloader starts that work only after the user asks for a
 * playlist download.
 *
 * The listener stays silent until native setup actually begins, so opening
 * the app or playing online never shows downloader setup UI.
 */
export function useYtdlpSetup(): void {
  // True only after a "downloading" event — gates the success toast.
  const sawDownloadRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;

    void listen<YtdlpState>("ytdlp-state", (e) => {
      const { phase, message } = e.payload;
      if (phase === "downloading") {
        sawDownloadRef.current = true;
        toast.loading("Setting up offline downloads (downloading yt-dlp)…", {
          id: TOAST_ID,
          duration: Infinity,
        });
      } else if (phase === "runtime") {
        sawDownloadRef.current = true;
        toast.loading("Setting up offline downloads (downloading Deno)...", {
          id: TOAST_ID,
          duration: Infinity,
          description:
            "One-time download for current YouTube signature challenges.",
        });
      } else if (phase === "provider") {
        sawDownloadRef.current = true;
        toast.loading("Setting up reliable offline downloads...", {
          id: TOAST_ID,
          duration: Infinity,
          description:
            "Installing the pinned managed PO-token provider. This only happens on first setup.",
        });
      } else if (phase === "ready") {
        const showedSetup = sawDownloadRef.current;
        sawDownloadRef.current = false;
        if (message) {
          toast.warning("Offline download engine is ready with limitations", {
            id: TOAST_ID,
            duration: 8000,
            description: message,
            action: {
              label: "Retry setup",
              onClick: retryOfflineSetup,
            },
          });
        } else if (showedSetup) {
          toast.success("Offline downloads are ready", {
            id: TOAST_ID,
            duration: 4000,
          });
        }
      } else if (phase === "error") {
        sawDownloadRef.current = false;
        toast.error("Couldn't set up offline downloads", {
          id: TOAST_ID,
          duration: Infinity,
          description: message ?? undefined,
          action: {
            label: "Retry",
            onClick: retryOfflineSetup,
          },
        });
      } else if (phase === "cancelled") {
        sawDownloadRef.current = false;
        toast.dismiss(TOAST_ID);
      }
    }).then((un) => {
      if (cancelled) {
        un();
        return;
      }
      dispose = un;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}
