import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { api, type ChatAttachment } from "@/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";

/**
 * files in Chat. The paperclip by the
 * voice note opens the phone's photo picker and camera (or the file dialog on a computer, where paste and drag-drop work
 * too); each file uploads at once and shows as a thumbnail above the box (× removes it); Send carries their ids with the
 * text or a voice note, and the console adds their links for the desk. The same list as the console (desk/attachments.ts).
 */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_FILES = 8;
export const ATTACH_ACCEPT = [
  "image/*",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/pdf",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".csv",
  ".md",
  ".json",
].join(",");
/**
 * the phone's photo picker. With images and documents in one accept list Android's Chrome opens its general
 * chooser, where a second file needs a long press (three screenshots came in three picks); with only pictures
 * and videos it opens the system photo picker, where each tap adds one (several at once, as on an iPhone's Photos).
 */
export const ATTACH_PHOTOS_ACCEPT = "image/*,video/*";
const TAKEN = /^(image\/(png|jpe?g|webp|gif|heic|heif)|video\/(mp4|quicktime|webm)|application\/(pdf|json)|text\/(plain|csv|markdown)|application\/vnd\.openxmlformats-officedocument\.)/i;
const TAKEN_EXT = /\.(png|jpe?g|webp|gif|heic|heif|mp4|mov|webm|pdf|docx|xlsx|pptx|txt|csv|md|json)$/i;
/** Does Chat take this file (the console checks again, bytes included)? */
export const takesFile = (f: { type: string; name: string }) => (f.type ? TAKEN.test(f.type) || (f.type === "application/octet-stream" && TAKEN_EXT.test(f.name)) : TAKEN_EXT.test(f.name));

export interface PendingFile {
  key: string;
  name: string;
  type: string;
  size: number;
  /** A local preview (object URL) of an image. */
  preview?: string;
  state: "uploading" | "ready" | "failed";
  attachment?: ChatAttachment;
  error?: string;
  /** how much of it has left the phone, 0 to 1, while uploading. */
  sent?: number;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const objectUrl = (f: Blob) => (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : undefined);
const dropUrl = (u?: string) => {
  if (u && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(u);
};

/** a photo leaving a phone is drawn again at most this many px on its long side, as JPEG of this quality. */
export const PHONE_PHOTO_PX = 1600;
export const PHONE_PHOTO_QUALITY = 0.8;
/** a phone photo already this small and within PHONE_PHOTO_PX goes as it is (redrawing it would only lose detail). */
export const PHONE_PHOTO_KEEP_BYTES = 300 * 1024;
/** a finger is the pointer: a phone or a tablet, where the upload rides a mobile link. */
export const onPhone = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/**
 * the picture as it leaves. on his phone a 402 KB screenshot took 54 s to upload while the console
 * wrote it in milliseconds (the link, not the server), so on a phone every PNG, JPEG or WebP over 1600 px or 300 KB is drawn
 * again at most 1600 px as JPEG 0.8 (a 1080x2400 screenshot: about 520 KB down to about 100 KB), kept only when smaller.
 * On a computer only a file over the 10 MB limit is redrawn (2560 px, JPEG 0.85). GIF, HEIC and other files stay as they are.
 */
export async function fitImage(f: File, phone = onPhone()): Promise<File> {
  const over = f.size > ATTACH_MAX_BYTES;
  if ((!over && !phone) || !/^image\/(png|jpe?g|webp)$/i.test(f.type) || typeof createImageBitmap !== "function") return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, (phone ? PHONE_PHOTO_PX : 2560) / Math.max(bmp.width, bmp.height));
    if (!over && scale === 1 && f.size <= PHONE_PHOTO_KEEP_BYTES) return f;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const g = c.getContext("2d");
    if (!g) return f;
    // a PNG's clear parts turn black in a JPEG: paint them white first
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", phone ? PHONE_PHOTO_QUALITY : 0.85));
    if (!blob || (!over && blob.size >= f.size)) return f;
    return new File([blob], f.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return f;
  }
}

export interface ChatAttach {
  /** The paperclip (by the voice note), or undefined when this chat takes no files. */
  button?: ReactNode;
  /** the paperclip's hidden file input alone, and what opens its picker, for a box that draws its own paperclip (a phone's menu). */
  input?: ReactNode;
  pick: () => void;
  /** opens the photo picker (pictures and videos only), where several are chosen in one go. */
  pickPhotos: () => void;
  /** another file may be added now (not sending, under the limit). */
  canAdd: boolean;
  /** The thumbnails above the box, while there are files. */
  tray?: ReactNode;
  /** Every file is uploaded (none still going). */
  ready: boolean;
  /** Uploaded files to send. */
  ids: string[];
  files: PendingFile[];
  clear: () => void;
  /** adds files (the box's Paste button reads them from the clipboard); a no-op when this box takes no files. */
  add: (list: FileList | File[] | null | undefined) => void;
  /** Paste into the box: files pasted (a screenshot) are attached. */
  onPaste: (e: ClipboardEvent) => void;
  /** Drag-drop onto the chat box. */
  dropProps: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
}

export function useChatAttach({ enabled, disabled }: { enabled: boolean; disabled?: boolean }): ChatAttach {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const live = useRef(files);
  live.current = files;
  useEffect(() => () => live.current.forEach((f) => dropUrl(f.preview)), []);
  const patch = (key: string, p: Partial<PendingFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const add = useCallback((list: FileList | File[] | null | undefined) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const room = Math.max(0, ATTACH_MAX_FILES - live.current.length);
    for (const [i, raw] of picked.entries()) {
      const key = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const base: PendingFile = { key, name: raw.name || "file", type: raw.type, size: raw.size, state: "uploading", ...(raw.type.startsWith("image/") ? { preview: objectUrl(raw) } : {}) };
      const refuse = (error: string) => setFiles((fs) => [...fs, { ...base, state: "failed", error }]);
      if (i >= room) {
        refuse(`At most ${ATTACH_MAX_FILES} files in one message.`);
        continue;
      }
      if (!takesFile(raw)) {
        refuse("Chat takes images, screen recordings, PDF, Office and text files.");
        continue;
      }
      setFiles((fs) => [...fs, base]);
      void (async () => {
        const f = await fitImage(raw);
        if (f.size > ATTACH_MAX_BYTES) return patch(key, { state: "failed", error: `Too big: ${kb(f.size)} (10 MB at most).` });
        try {
          patch(key, { size: f.size, sent: 0 });
          const r = await api.uploadChatAttachment(f, f.name || base.name, (sent, total) => patch(key, { sent: total ? Math.min(1, sent / total) : 0 }));
          patch(key, { state: "ready", attachment: r.attachment, size: f.size, sent: 1 });
        } catch (e) {
          patch(key, { state: "failed", error: (e as Error).message });
        }
      })();
    }
  }, []);

  const remove = (key: string) =>
    setFiles((fs) => {
      dropUrl(fs.find((f) => f.key === key)?.preview);
      return fs.filter((f) => f.key !== key);
    });
  const clear = useCallback(() => {
    live.current.forEach((f) => dropUrl(f.preview));
    setFiles([]);
  }, []);

  if (!enabled) return { ready: true, ids: [], files: [], clear, pick: () => undefined, pickPhotos: () => undefined, canAdd: false, add: () => undefined, onPaste: () => undefined, dropProps: { onDragOver: () => undefined, onDrop: () => undefined } };

  const ready = files.every((f) => f.state !== "uploading");
  const ids = files.flatMap((f) => (f.state === "ready" && f.attachment ? [f.attachment.id] : []));
  const canAdd = !disabled && files.length < ATTACH_MAX_FILES;
  const pick = () => input.current?.click();
  const pickPhotos = () => photos.current?.click();
  const fileInput = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        className="hidden"
        data-testid="chat-attach-input"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={photos}
        type="file"
        multiple
        accept={ATTACH_PHOTOS_ACCEPT}
        className="hidden"
        data-testid="chat-attach-photos"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
  const button = (
    <>
      {fileInput}
      <Button
        type="button"
        variant="ghost"
        className={cn(PHONE_TAP, "shrink-0 max-sm:size-11 max-sm:px-0")}
        disabled={!canAdd}
        aria-label="Attach a screenshot or file"
        title="Attach screenshots, photos or files, several at once (you can also paste or drop them here)"
        data-testid="chat-attach"
        onClick={pick}
      >
        <Paperclip /> <span className="sr-only">Attach</span>
      </Button>
    </>
  );
  const tray = files.length ? (
    <ul className="mb-1 flex gap-3 overflow-x-auto pb-1 pr-2 pt-2" aria-label="Files to send" data-testid="chat-attach-tray">
      {files.map((f) => (
        <li key={f.key} className="relative shrink-0" data-testid="chat-attach-item" data-state={f.state}>
          <div
            className={cn("flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted text-muted-foreground", f.state === "failed" && "border-destructive")}
            title={f.error ? `${f.name}: ${f.error}` : `${f.name} · ${kb(f.size)}`}
          >
            {f.preview ? <img src={f.preview} alt={f.name} className="h-full w-full object-cover" /> : <FileText className="h-6 w-6" aria-hidden />}
            {f.state === "uploading" && (
              <span
                className="absolute inset-0 flex flex-col items-center justify-center rounded-md bg-background/60"
                aria-label={f.sent !== undefined ? `Uploading, ${Math.round(f.sent * 100)}% sent` : "Uploading"}
                data-testid="chat-attach-progress"
              >
                <Loader2 className="h-5 w-5 animate-spin" />
                {f.sent !== undefined && <span className="mt-0.5 text-[10px] font-medium tabular-nums text-foreground">{Math.round(f.sent * 100)}%</span>}
              </span>
            )}
          </div>
          {!f.preview && <span className="mt-0.5 block w-16 truncate text-[10px] text-muted-foreground">{f.name}</span>}
          {f.state === "failed" && <span className="mt-0.5 block w-16 truncate text-[10px] text-destructive" data-testid="chat-attach-error">{f.error}</span>}
          <button
            type="button"
            className="absolute -right-2 -top-2 flex size-7 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-accent"
            aria-label={`Remove ${f.name}`}
            data-testid="chat-attach-remove"
            onClick={() => remove(f.key)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  ) : undefined;
  return {
    button,
    input: fileInput,
    pick,
    pickPhotos,
    canAdd,
    tray,
    ready,
    ids,
    files,
    clear,
    add,
    onPaste: (e) => {
      // a phone's long-press Paste may hand the screenshot only as a clipboard item, not in `files`
      const listed = Array.from(e.clipboardData?.files ?? []);
      const pasted = listed.length
        ? listed
        : Array.from(e.clipboardData?.items ?? []).flatMap((i) => (i.kind === "file" ? [i.getAsFile()].filter((f): f is File => !!f) : []));
      if (!pasted.length) return;
      add(pasted);
      // a pasted screenshot is a file, not text: keep it out of the box
      if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    },
    dropProps: {
      onDragOver: (e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
      },
      onDrop: (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        add(e.dataTransfer.files);
      },
    },
  };
}

/**
 * on his iPhone a text box offers no Paste while
 * the clipboard holds only a picture (iOS pastes plain text into a text area), so the long-press menu never reaches onPaste.
 * The box's Paste button reads the clipboard itself (iOS shows its own small Paste bubble to allow it): pictures and files
 * become attachments, plain text goes into the box (both empty when it holds neither).
 */
export async function readClipboard(clip: Pick<Clipboard, "read"> | undefined = typeof navigator !== "undefined" ? navigator.clipboard : undefined): Promise<{ files: File[]; text: string }> {
  if (!clip?.read) throw new Error("this browser does not let the page read the clipboard");
  const items = await clip.read();
  const files: File[] = [];
  let text = "";
  for (const [i, it] of items.entries()) {
    const type = it.types.find((t) => !t.startsWith("text/") && takesFile({ type: t, name: "" }));
    if (type) {
      const blob = await it.getType(type);
      const ext = type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^\w].*$/, "") || "png";
      files.push(new File([blob], `pasted-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}${items.length > 1 ? `-${i + 1}` : ""}.${ext}`, { type }));
    } else if (it.types.includes("text/plain")) text += await blobText(await it.getType("text/plain"));
  }
  return { files, text };
}

/** A Blob's text (older WebKit has no Blob.text). */
const blobText = (b: Blob) =>
  typeof b.text === "function"
    ? b.text()
    : new Promise<string>((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result ?? ""));
        r.onerror = () => fail(r.error);
        r.readAsText(b);
      });

/** The box's Paste button shows where a finger is the pointer (a phone, a tablet) and the page may read the clipboard. */
export const showsPasteButton = () =>
  typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function" && typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/**
 * his words with the links of the files he added, for a box whose own route takes only words (Send to, Steer, Run
 * now, a slide's note, a post's or an idea's feedback): the console names each file on one line after his words.
 */
export async function wordsWithFiles(text: string, ids: string[]): Promise<string> {
  if (!ids.length) return text;
  const { line } = await api.attachmentLine(ids);
  const words = text.trim();
  return `${words}${words ? " " : ""}${line}`;
}

/** One file of a sent message, read back from the console's `📎 Attachments` block. */
export interface SentFile {
  name: string;
  mime: string;
  size: string;
  /** Where the page opens it: the console path (same origin), whatever host the desk's link names. */
  href: string;
}

/** Splits the console's attachments block off a message: his words, and the files to show under them. */
export function splitAttachments(text: string): { text: string; files: SentFile[] } {
  const at = text.search(/(^|\n)📎 Attachments \(\d+\)/u);
  if (at < 0) return { text, files: [] };
  const files: SentFile[] = [];
  for (const line of text.slice(at).split("\n")) {
    const m = /^- (.+?) · ([\w.+/-]+) · ([\d.]+ [KM]B) · (\S+)\s*$/.exec(line);
    if (!m) continue;
    let href = m[4];
    try {
      const u = new URL(href);
      if (u.pathname.startsWith("/api/chat/attachments/")) href = u.pathname;
    } catch {
      /* already a path */
    }
    files.push({ name: m[1], mime: m[2], size: m[3], href });
  }
  return { text: text.slice(0, at).trimEnd(), files };
}

/** The files under a chat bubble: image thumbnails (tap opens it full size) and a chip for anything else. */
export function SentFiles({ files }: { files: SentFile[] }) {
  const [open, setOpen] = useState<SentFile | undefined>();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(undefined);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  if (!files.length) return null;
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="chat-files">
        {files.map((f, i) =>
          f.mime.startsWith("image/") && !/hei[cf]/.test(f.mime) ? (
            <button key={i} type="button" className="overflow-hidden rounded-md border bg-background" onClick={() => setOpen(f)} aria-label={`Open ${f.name}`} data-testid="chat-file-image">
              <img src={f.href} alt={f.name} loading="lazy" className="h-28 max-w-[12rem] object-cover sm:h-36 sm:max-w-[16rem]" />
            </button>
          ) : (
            <a
              key={i}
              href={f.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
              data-testid="chat-file"
            >
              <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{f.size}</span>
            </a>
          ),
        )}
      </div>
      {open && (
        <div role="dialog" aria-label={open.name} className="fixed inset-0 z-50 flex flex-col bg-black/90" onClick={() => setOpen(undefined)} data-testid="chat-file-viewer">
          <div className="flex items-center justify-between gap-2 p-2 text-sm text-white">
            <a href={open.href} target="_blank" rel="noreferrer" className="truncate underline" onClick={(e) => e.stopPropagation()}>
              {open.name}
            </a>
            <button type="button" className="flex size-11 items-center justify-center rounded-full hover:bg-white/10" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <img src={open.href} alt={open.name} className="min-h-0 flex-1 object-contain p-2" />
        </div>
      )}
    </>
  );
}
