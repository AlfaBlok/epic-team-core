// @vitest-environment jsdom
// A 402 KB phone screenshot took 54 s to reach the console (the link, not the server): on a phone a photo
// is shrunk to 1600 px JPEG 0.8 before it leaves, and the thumbnail shows how much has been sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/api";
import { uploadWithProgress, ApiError } from "@/api/real";
import { fitImage, PHONE_PHOTO_PX, PHONE_PHOTO_QUALITY, useChatAttach } from "@/components/ChatAttach";

const bytes = (n: number, type: string, name: string) => new File([new Uint8Array(n)], name, { type });

describe("a phone photo is shrunk before it leaves", () => {
  let drawn: { w: number; h: number; type?: string; q?: number; filled: boolean } | undefined;
  let outSize = 100 * 1024;
  const bitmap = vi.fn();
  beforeEach(() => {
    drawn = undefined;
    outSize = 100 * 1024;
    bitmap.mockReset();
    vi.stubGlobal("createImageBitmap", bitmap);
    const make = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag !== "canvas") return make(tag);
      const c = { width: 0, height: 0, filled: false } as any;
      c.getContext = () => ({ fillStyle: "", fillRect: () => (c.filled = true), drawImage: () => undefined });
      c.toBlob = (cb: (b: Blob | null) => void, type: string, q: number) => {
        drawn = { w: c.width, h: c.height, type, q, filled: c.filled };
        cb(new Blob([new Uint8Array(outSize)], { type }));
      };
      return c;
    }) as typeof document.createElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("his 1080x2400 screenshot (520 KB) leaves as a 720x1600 JPEG at 0.8, white behind any clear parts", async () => {
    bitmap.mockResolvedValue({ width: 1080, height: 2400, close: () => undefined });
    const out = await fitImage(bytes(520 * 1024, "image/png", "Screenshot_2026-11-13.png"), true);
    expect(drawn).toEqual({ w: 720, h: PHONE_PHOTO_PX, type: "image/jpeg", q: PHONE_PHOTO_QUALITY, filled: true });
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("Screenshot_2026-11-13.jpg");
    expect(out.size).toBe(100 * 1024);
  });

  it("a small picture within 1600 px goes as it is; a redraw that is not smaller is dropped", async () => {
    bitmap.mockResolvedValue({ width: 800, height: 1200 });
    const small = bytes(200 * 1024, "image/jpeg", "s.jpg");
    expect(await fitImage(small, true)).toBe(small);
    expect(drawn).toBeUndefined();
    bitmap.mockResolvedValue({ width: 1000, height: 1600 });
    outSize = 900 * 1024;
    const dense = bytes(800 * 1024, "image/jpeg", "d.jpg");
    expect(await fitImage(dense, true)).toBe(dense);
  });

  it("on a computer a file under the limit is never redrawn; a GIF never is", async () => {
    const png = bytes(800 * 1024, "image/png", "image.png");
    expect(await fitImage(png, false)).toBe(png);
    const gif = bytes(800 * 1024, "image/gif", "a.gif");
    expect(await fitImage(gif, true)).toBe(gif);
    expect(bitmap).not.toHaveBeenCalled();
  });
});

describe("the upload reports how much has been sent", () => {
  class FakeXhr {
    static last: FakeXhr;
    upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
    headers: Record<string, string> = {};
    status = 0;
    responseText = "";
    timeout = 0;
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    url = "";
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send() {
      FakeXhr.last = this;
    }
  }
  beforeEach(() => vi.stubGlobal("XMLHttpRequest", FakeXhr));
  afterEach(() => vi.unstubAllGlobals());

  it("progress events reach the caller and the console's answer resolves it", async () => {
    const seen: number[] = [];
    const p = uploadWithProgress<{ attachment: { id: string } }>("/chat/attachments", new Blob([new Uint8Array(100)]), { "x-filename": "a.jpg" }, (s, t) => seen.push(s / t));
    const x = FakeXhr.last;
    expect(x.url).toBe("/api/chat/attachments");
    expect(x.headers["x-filename"]).toBe("a.jpg");
    x.upload.onprogress!({ loaded: 40, total: 100, lengthComputable: true });
    x.upload.onprogress!({ loaded: 100, total: 100, lengthComputable: true });
    x.status = 201;
    x.responseText = JSON.stringify({ attachment: { id: "att_1" } });
    x.onload!();
    expect((await p).attachment.id).toBe("att_1");
    expect(seen).toEqual([0.4, 1]);
  });

  it("a refusal carries the console's own message and code", async () => {
    const p = uploadWithProgress("/chat/attachments", new Blob([new Uint8Array(1)]), {}, () => undefined);
    const x = FakeXhr.last;
    x.status = 413;
    x.responseText = JSON.stringify({ error: { code: "too_big", message: "a file is at most 10 MB" } });
    x.onload!();
    const e = (await p.catch((err: unknown) => err)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("too_big");
    expect(e.message).toBe("a file is at most 10 MB");
  });
});

function Harness() {
  const a = useChatAttach({ enabled: true });
  return (
    <div>
      {a.button}
      {a.tray}
    </div>
  );
}

describe("the thumbnail shows the percent sent", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("shows 0%, then 45% as bytes leave, then the file is ready", async () => {
    let progress: ((s: number, t: number) => void) | undefined;
    let finish: (() => void) | undefined;
    vi.spyOn(api, "uploadChatAttachment").mockImplementation(
      (f, name, onProgress) =>
        new Promise((ok) => {
          progress = onProgress;
          finish = () => ok({ attachment: { id: "att_7", name, mime: f.type, bytes: f.size, createdAt: "", path: "/x" } });
        }),
    );
    render(<Harness />);
    fireEvent.change(screen.getByTestId("chat-attach-input"), { target: { files: [bytes(10, "application/pdf", "a.pdf")] } });
    await waitFor(() => expect(screen.getByTestId("chat-attach-progress").textContent).toBe("0%"));
    act(() => progress!(45, 100));
    expect(screen.getByLabelText("Uploading, 45% sent")).toBeTruthy();
    await act(async () => finish!());
    await waitFor(() => expect(screen.getByTestId("chat-attach-item").getAttribute("data-state")).toBe("ready"));
    expect(screen.queryByTestId("chat-attach-progress")).toBeNull();
  });
});
