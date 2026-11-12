import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ClipboardPaste, Image as ImageIcon, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnswerTextarea, PHONE_TAP } from "@/components/common";
import { Button } from "@/components/ui/button";
import { readClipboard, showsPasteButton, type ChatAttach } from "@/components/ChatAttach";

/** how long the paste note shows as a toast. */
export const PASTE_TOAST_MS = 4_000;

/**
 * the one box that takes his words, everywhere:
 * Chat, a campaign's chat, and every card box (Answer, Changes wanted, Decline). The same text area, the paperclip, paste of
 * a screenshot (Ctrl/Cmd+V, a phone's long-press Paste) and drag-drop onto it, the thumbnails above it before sending, and
 * the shared voice note (useNote) in the same place: the voice strip above, the microphone right of the paperclip.
 * The caller keeps its words, its files (useChatAttach) and its voice note (useNote), and adds its own send button.
 */
export function WordsBox({
  value,
  onChange,
  files,
  voice,
  label,
  placeholder,
  rows = 2,
  send,
  above,
  onKeyDown,
  enterKeyHint,
  className,
  boxClassName,
  testid = "words-box",
}: {
  value: string;
  onChange: (v: string) => void;
  /** The box's files: paperclip, tray, paste and drop (useChatAttach). */
  files: ChatAttach;
  /** The shared voice note: its microphone and its strip (useNote, through useVoiceNote or useAnswerVoice). */
  voice?: { button?: ReactNode; strip?: ReactNode };
  /** The box's accessible name. */
  label: string;
  placeholder?: string;
  rows?: number;
  /** The box's own press at the end of the row (Chat's Send, a question's Answer); boxes with several presses put them below. */
  send?: ReactNode;
  /** More between the thumbnails and the row (Chat's live call). */
  above?: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  enterKeyHint?: "enter" | "send";
  className?: string;
  /** Extra classes for the text area (its height). */
  boxClassName?: string;
  testid?: string;
}) {
  // on a phone the long-press menu of a text box
  // has no Paste for a picture alone, so the box has its own Paste: it reads the clipboard (iOS asks with its small Paste
  // bubble), a screenshot joins the files above the box, words go into it. It lives in the
  // paperclip's menu (Paste a screenshot, Choose a photo or file), and what it says comes as a toast that goes by itself.
  const [paste] = useState(showsPasteButton);
  const [menu, setMenu] = useState(false);
  const [pasteNote, setPasteNote] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pasteNote) return;
    const t = setTimeout(() => setPasteNote(undefined), PASTE_TOAST_MS);
    return () => clearTimeout(t);
  }, [pasteNote]);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);
  const pasteNow = async () => {
    setMenu(false);
    setPasteNote(undefined);
    try {
      const got = await readClipboard();
      if (got.files.length) files.add(got.files);
      else if (got.text) onChange(value ? `${value}${/\s$/.test(value) ? "" : " "}${got.text}` : got.text);
      else setPasteNote("Nothing to paste: copy a screenshot first, or use the paperclip.");
    } catch {
      setPasteNote("The phone did not let the page paste. Use the paperclip to pick the screenshot from your photos.");
    }
  };
  const item = "flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-sm hover:bg-accent";
  const clip =
    files.button && paste ? (
      // one paperclip on a phone; its menu holds Paste (the box's own row stays short: paperclip, mic, send)
      <div className="relative shrink-0" ref={menuRef}>
        {files.input}
        <Button
          type="button"
          variant="ghost"
          className={cn(PHONE_TAP, "shrink-0 max-sm:size-11 max-sm:px-0")}
          disabled={!files.canAdd}
          aria-label="Attach a screenshot or file"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="Paste a screenshot, or choose a photo or file"
          data-testid="chat-attach"
          onClick={() => setMenu((m) => !m)}
        >
          <Paperclip /> <span className="sr-only">Attach</span>
        </Button>
        {menu && (
          <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg" data-testid="chat-attach-menu">
            <button type="button" role="menuitem" className={item} data-testid="words-paste" onClick={() => void pasteNow()}>
              <ClipboardPaste className="h-4 w-4 shrink-0" aria-hidden /> Paste a screenshot
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              data-testid="chat-attach-pick"
              onClick={() => {
                setMenu(false);
                files.pick();
              }}
            >
              <ImageIcon className="h-4 w-4 shrink-0" aria-hidden /> Choose a photo or file
            </button>
          </div>
        )}
      </div>
    ) : (
      files.button
    );
  const tools = !!(files.button || voice?.button || send);
  return (
    <div className={cn("grid min-w-0 gap-1", className)} data-testid={testid} {...files.dropProps}>
      {voice?.strip}
      {files.tray}
      {above}
      {/* the words take the whole width, one or two
          lines that grow as he types (to 40% of a phone's height); the paperclip, the voice note and the box's own press sit in
          a short row under them, inside the same frame, on every screen and in every box (the one box everywhere). */}
      <div className="flex min-w-0 flex-col rounded-md border bg-background" data-testid="words-field">
        <AnswerTextarea
          className={cn("min-h-10 w-full min-w-0 resize-none border-0 bg-transparent px-3 py-2 text-sm shadow-none focus-visible:outline-none", "max-sm:min-h-11 max-sm:max-h-[40dvh]", boxClassName)}
          rows={rows}
          placeholder={placeholder}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={files.onPaste}
          enterKeyHint={enterKeyHint}
          onKeyDown={onKeyDown}
        />
        {tools && (
          <div className="flex items-center gap-1 px-1.5 pb-1.5" data-testid="words-tools">
            {clip}
            {voice?.button}
            {send && <div className="ml-auto flex shrink-0 items-center">{send}</div>}
          </div>
        )}
      </div>
      {pasteNote && (
        // a toast over the page, never a line that pushes the box up
        <p
          className="pointer-events-none fixed inset-x-4 bottom-[calc(9rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-sm rounded-md border bg-popover px-3 py-2 text-center text-sm text-popover-foreground shadow-lg"
          role="status"
          data-testid="words-paste-note"
        >
          {pasteNote}
        </p>
      )}
    </div>
  );
}
