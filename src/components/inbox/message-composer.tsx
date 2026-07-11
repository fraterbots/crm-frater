"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  MessageSquareText,
  StickyNote,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { CannedResponsePicker } from "./canned-response-picker";
import { useTranslation } from "@/lib/i18n/use-translation";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

const MEDIA_KIND_LABEL_KEY: Record<ComposerMediaKind, "inbox.messageBubble.typeImage" | "inbox.messageBubble.typeVideo" | "inbox.messageBubble.typeAudio" | "inbox.messageBubble.typeDocument"> = {
  image: "inbox.messageBubble.typeImage",
  video: "inbox.messageBubble.typeVideo",
  document: "inbox.messageBubble.typeDocument",
  audio: "inbox.messageBubble.typeAudio",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  /** Internal notes never touch the WhatsApp API, so they ignore sessionExpired. */
  onSendNote: (text: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /** Throttled by the caller's own logic — this just fires on keystrokes,
   *  at most every ~1.5s (see lastTypingSentRef below), for the
   *  per-conversation "agent is typing" presence broadcast. */
  onTyping?: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendNote,
  onOpenTemplates,
  replyTo,
  onClearReply,
  onTyping,
}: MessageComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [cannedPickerOpen, setCannedPickerOpen] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Throttles the typing broadcast to at most once per ~1.5s of active
  // keystrokes, instead of on every single change event.
  const lastTypingSentRef = useRef(0);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  // Notes never touch the WhatsApp API, so — unlike handleSend — this
  // deliberately ignores sessionExpired.
  const handleSendNoteClick = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    onSendNote(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, sending, onSendNote]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (noteMode) {
          handleSendNoteClick();
        } else {
          handleSend();
        }
      }
    },
    [noteMode, handleSendNoteClick, handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      // "/" as the very first (and only) character opens the canned
      // response picker, fulfilling the quickRepliesHint below the
      // textarea. Cleared immediately so it doesn't linger in the draft.
      if (value === "/") {
        setCannedPickerOpen(true);
        setText("");
        adjustHeight();
        return;
      }
      setText(value);
      adjustHeight();

      if (onTyping && value.trim().length > 0) {
        const now = Date.now();
        if (now - lastTypingSentRef.current > 1500) {
          lastTypingSentRef.current = now;
          onTyping();
        }
      }
    },
    [adjustHeight, onTyping]
  );

  const handleInsertCanned = useCallback((body: string) => {
    setText((prev) => (prev ? `${prev} ${body}` : body));
    requestAnimationFrame(() => {
      adjustHeight();
      textareaRef.current?.focus();
    });
  }, [adjustHeight]);

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          t("inbox.composer.fileTooLargeToast", {
            sizeMb: (file.size / 1024 / 1024).toFixed(1),
            kind: t(MEDIA_KIND_LABEL_KEY[kind]),
            limitMb: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("inbox.composer.uploadFailedToast"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("inbox.composer.recordingTooLongToast"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("inbox.composer.uploadFailedToast"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error(t("inbox.composer.voiceNotSupportedToast"));
      return;
    }
    try {
      // Lazy-load the encoder (≈400 KB worker) only when the user records,
      // keeping it out of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t("inbox.composer.micDeniedToast"));
    }
  }, [inputsDisabled, busy, recording, finalizeRecording, t]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-t border-border bg-card p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("inbox.composer.sessionExpiredBanner")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("inbox.composer.templatesButton")}
          </Button>
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
        />
      ) : recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-sm text-foreground">
            {t("inbox.composer.recordingLabel", {
              current: formatDuration(recordSeconds),
              max: formatDuration(MAX_RECORDING_SECONDS),
            })}
          </span>
          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("inbox.composer.cancelRecording")}
          </button>
          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title={t("inbox.composer.stopAndAttachTitle")}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {/* Attach menu — photo / video / document / voice. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t("inbox.composer.readOnlyTooltip")
                  : inputsDisabled
                    ? undefined
                    : t("inbox.composer.attachMediaTitle")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("inbox.composer.attachPhoto")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                <Video className="mr-2 h-4 w-4" />
                {t("inbox.composer.attachVideo")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                <FileText className="mr-2 h-4 w-4" />
                {t("inbox.composer.attachDocument")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void startRecording()}>
                <Mic className="mr-2 h-4 w-4" />
                {t("inbox.composer.attachVoiceNote")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t("inbox.composer.sendTemplateTitle")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t("inbox.composer.cannedResponsesTitle")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setCannedPickerOpen(true)}
          >
            <MessageSquareText className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t("inbox.composer.noteToggleLabel")}
            aria-pressed={noteMode}
            className={cn(
              "h-9 w-9 shrink-0 p-0",
              noteMode
                ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setNoteMode((prev) => !prev)}
          >
            <StickyNote className="h-4 w-4" />
          </GatedButton>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t("inbox.composer.placeholderReadOnly")
                : noteMode
                  ? t("inbox.composer.notePlaceholder")
                  : sessionExpired
                    ? t("inbox.composer.placeholderSessionExpired")
                    : t("inbox.composer.placeholderDefault")
            }
            disabled={(sessionExpired && !noteMode) || readOnly}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={readOnly ? t("inbox.composer.readOnlyTooltip") : undefined}
            className={cn(
              "flex-1 resize-none rounded-xl border px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors",
              noteMode
                ? "border-amber-500/30 bg-amber-500/10 focus:border-amber-500/50"
                : "border-border bg-muted focus:border-primary/50",
              (sessionExpired && !noteMode) || readOnly
                ? "cursor-not-allowed opacity-50"
                : undefined,
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || (sessionExpired && !noteMode) || sending}
            onClick={noteMode ? handleSendNoteClick : handleSend}
            title={noteMode ? t("inbox.composer.sendNoteTitle") : undefined}
            className={cn(
              "h-9 w-9 shrink-0 p-0 disabled:opacity-40",
              noteMode
                ? "bg-amber-500 hover:bg-amber-600"
                : "bg-primary hover:bg-primary/90",
            )}
          >
            {noteMode ? <StickyNote className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </GatedButton>
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. */}
      {!draft && !recording && (
        <p className="mt-1 pl-[5.5rem] text-[10px] text-muted-foreground">
          {t("inbox.composer.quickRepliesHint")}
        </p>
      )}

      <CannedResponsePicker
        open={cannedPickerOpen}
        onOpenChange={setCannedPickerOpen}
        onSelect={handleInsertCanned}
      />
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("inbox.composer.removeAttachmentAria")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("inbox.composer.captionPlaceholder")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
