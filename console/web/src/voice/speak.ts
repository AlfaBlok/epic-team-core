import { useSyncExternalStore } from "react";

/**
 * the app's one reply player. A desk reply is spoken only when he presses Play, or when he switched
 * "Speak replies" on for this device (then only the reply to his own voice note). It speaks in the team's warm local voice
 * (Kokoro Heart, relayed by POST /api/voice/speak, free), one short piece at a time, the next fetched while one plays; when
 * that voice is down it uses the device's best voice, never the robotic default. Pause, Resume and Stop are always there;
 * a new message, another Play, a voice note, a call or a tap anywhere else stops it.
 */

export type SpeakPhase = "idle" | "loading" | "playing" | "paused";
export interface SpeakState {
  phase: SpeakPhase;
  /** The message being spoken. */
  id?: string;
  /** "heart" = the team's voice; "device" = this device's best voice (the team's voice was not reachable). */
  voice?: "heart" | "device";
}

/** What the player needs from the page (tests fake all three). */
export interface SpeakMedia {
  fetchPiece: (text: string, signal: AbortSignal) => Promise<Blob>;
  /** have the worker server speak a piece ahead (nothing comes back), so a later fetchPiece finds it ready. */
  warmPiece?: (text: string) => Promise<void>;
  audio: () => HTMLAudioElement;
  synth: () => SpeechSynthesis | undefined;
}

const SPEAK_KEY = "speakReplies";
/** The old switch is never read again: every device starts at "off". */
export const SPEAK_REPLIES_KEY = SPEAK_KEY;
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** A reply as words to say: no code, no link targets, no markdown marks, at most ~2500 characters. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    // a table's delimiter row and rules say nothing
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
}

/**
 * Short pieces at sentence ends, growing: the first at most 70 characters (a long first sentence is cut at a
 * comma, else between words), so the worker server speaks it in under a second; the second at most 140, the rest at most
 * 220, so each next piece is spoken while the one before plays.
 */
export const FIRST_PIECE = 70;
export function pieces(text: string): string[] {
  const out: string[] = [];
  const cap = () => (out.length === 0 ? FIRST_PIECE : out.length === 1 ? 140 : 220);
  const sentences = text.match(/[^.!?;:]+(?:[.!?;:]+|$)\s*/g) ?? [text];
  let cur = "";
  for (const s0 of sentences) {
    let s = s0.trim();
    if (!s) continue;
    if (cur && cur.length + 1 + s.length > cap()) out.push(cur), (cur = "");
    // a sentence longer than the piece it starts: cut at a comma (else between words) inside the cap
    while (!cur && s.length > cap()) {
      const c = cap();
      const comma = s.lastIndexOf(", ", c - 1);
      const space = s.lastIndexOf(" ", c);
      const cut = comma >= 15 ? comma + 1 : space > c / 3 ? space : c;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (!s) continue;
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.filter((p) => /\w/.test(p));
}

/** How many pieces a new reply has spoken ahead on the worker server (warm), so Play and the next piece start at once. */
export const WARM_PIECES = 2;

/** The device's best English voice: a natural, neural or enhanced one first; the novelty and compact voices never. */
export function bestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    if (/^en[-_]/i.test(v.lang) || v.lang === "en") s += 20;
    else return -100;
    if (/natural|neural|premium|enhanced|siri/i.test(v.name)) s += 12;
    if (/^Google (UK|US) English/i.test(v.name)) s += 8;
    if (/samantha|ava|allison|serena|karen|moira|tessa|aria|jenny|sonia|libby|zira|susan|kate|fiona/i.test(v.name)) s += 5;
    if (/compact|espeak|robot|fred|albert|zarvox|trinoids|novelty|bad news|good news|bells|bubbles|boing|cellos|whisper|jester|organ|superstar|wobble|ralph|junior/i.test(v.name)) s -= 40;
    if (/en[-_]GB|en[-_]US/i.test(v.lang)) s += 2;
    return s;
  };
  return voices.map((v) => [v, score(v)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Every chat (the Team desk, a world's, a milestone's) asks the one route, /api/voice/speak. */
function browserMedia(): SpeakMedia {
  let el: HTMLAudioElement | undefined;
  return {
    async fetchPiece(text, signal) {
      const r = await fetch("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal });
      if (!r.ok) throw new Error(`reply voice ${r.status}`);
      return r.blob();
    },
    async warmPiece(text) {
      await fetch("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, warm: true }) });
    },
    audio: () => (el ??= new Audio()),
    synth: () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : undefined),
  };
}

export function createSpeaker(media: SpeakMedia) {
  let state: SpeakState = { phase: "idle" };
  const subs = new Set<() => void>();
  let run = 0;
  let abort: AbortController | undefined;
  let resumeWait: (() => void) | undefined;
  const set = (s: SpeakState) => {
    state = s;
    subs.forEach((f) => f());
  };
  const live = (r: number) => r === run;

  const playBlob = (r: number, blob: Blob) =>
    new Promise<void>((resolve, reject) => {
      const a = media.audio();
      const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
      const done = () => {
        a.onended = a.onerror = null;
        if (url) URL.revokeObjectURL?.(url);
        resolve();
      };
      a.onended = done;
      a.onerror = () => {
        a.onended = a.onerror = null;
        reject(new Error("could not play"));
      };
      a.src = url;
      if (!live(r)) return done();
      void a.play().then(
        () => {
          if (live(r) && state.phase === "loading") set({ ...state, phase: "playing" });
        },
        (e: unknown) => {
          a.onended = a.onerror = null;
          reject(e);
        },
      );
    });

  const speakDevice = async (r: number, parts: string[]) => {
    const synth = media.synth();
    if (!synth) throw new Error("no voice on this device");
    const voice = bestVoice(synth.getVoices());
    set({ ...state, voice: "device", phase: "playing" });
    for (const p of parts) {
      if (!live(r)) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(p);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = 0.95;
        u.pitch = 1;
        u.onend = u.onerror = () => resolve();
        synth.speak(u);
      });
    }
  };

  // iPhone plays sound only from a tap: start the one player inside the tap (Play, or the note's Send), so later pieces may play.
  const unlock = () => {
    try {
      const a = media.audio();
      a.src = SILENT_WAV;
      void a.play()?.catch?.(() => undefined);
    } catch {
      /* no audio element */
    }
  };

  const play = async (id: string, text: string) => {
    stop();
    const r = run;
    const parts = pieces(speakable(text));
    if (!parts.length) return;
    unlock();
    set({ phase: "loading", id, voice: "heart" });
    abort = new AbortController();
    const signal = abort.signal;
    let next: Promise<Blob> | undefined = media.fetchPiece(parts[0], signal);
    try {
      for (let i = 0; i < parts.length; i++) {
        const blob = await next!;
        if (!live(r)) return;
        next = i + 1 < parts.length ? media.fetchPiece(parts[i + 1], signal) : undefined;
        next?.catch(() => undefined);
        // paused while the piece was on its way: wait for Resume (or Stop) before it plays
        while (live(r) && state.phase === "paused") await new Promise<void>((res) => (resumeWait = res));
        if (!live(r)) return;
        await playBlob(r, blob);
        if (!live(r)) return;
      }
    } catch {
      if (!live(r)) return;
      // the team's voice is down or the piece would not play: the device's best voice says the rest, from the start
      try {
        await speakDevice(r, parts);
      } catch {
        /* nothing can speak here */
      }
    }
    if (live(r)) set({ phase: "idle" });
  };

  function stop() {
    run++;
    if (state.phase === "idle" && !abort) return;
    abort?.abort();
    abort = undefined;
    try {
      const a = media.audio();
      a.onended = a.onerror = null;
      a.pause();
    } catch {
      /* no audio element */
    }
    try {
      media.synth()?.cancel();
    } catch {
      /* no voice */
    }
    resumeWait?.();
    resumeWait = undefined;
    if (state.phase !== "idle") set({ phase: "idle" });
  }

  const pause = () => {
    if (state.phase !== "playing" && state.phase !== "loading") return;
    if (state.voice === "device") media.synth()?.pause();
    else media.audio().pause();
    set({ ...state, phase: "paused" });
  };
  const resume = () => {
    if (state.phase !== "paused") return;
    set({ ...state, phase: "playing" });
    if (state.voice === "device") media.synth()?.resume();
    else {
      const a = media.audio();
      if (a.src && !a.ended && a.src !== SILENT_WAV) void a.play()?.catch?.(() => undefined);
      resumeWait?.();
      resumeWait = undefined;
    }
  };

  // a new reply's first pieces are spoken ahead, one after the other, once per reply (the last 50 remembered).
  const warmed = new Set<string>();
  const warm = (id: string, text: string) => {
    if (!media.warmPiece || warmed.has(id)) return;
    warmed.add(id);
    if (warmed.size > 50) warmed.delete(warmed.values().next().value as string);
    const ahead = pieces(speakable(text)).slice(0, WARM_PIECES);
    void ahead.reduce((p, piece) => p.then(() => media.warmPiece!(piece)).catch(() => undefined), Promise.resolve());
  };

  return {
    play: (id: string, text: string) => void play(id, text),
    warm,
    pause,
    resume,
    stop,
    unlock: () => {
      if (state.phase === "idle") unlock();
    },
    get: () => state,
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

export type Speaker = ReturnType<typeof createSpeaker>;

let speaker: Speaker | undefined;
/** The page's one player (one sound at a time across every chat). */
export function replySpeaker(): Speaker {
  return (speaker ??= createSpeaker(browserMedia()));
}
/** Tests: a player with fake media. */
export function setReplySpeaker(s: Speaker | undefined) {
  speaker = s;
}

export function useSpeakState(): SpeakState {
  const s = replySpeaker();
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

/** "Speak replies: off / on", remembered on this device; off until he turns it on. */
const prefSubs = new Set<() => void>();
export function speakRepliesOn(): boolean {
  try {
    return localStorage.getItem(SPEAK_KEY) === "on";
  } catch {
    return false;
  }
}
export function setSpeakReplies(on: boolean) {
  try {
    localStorage.setItem(SPEAK_KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  if (!on) replySpeaker().stop();
  prefSubs.forEach((f) => f());
}
export function useSpeakReplies(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (f) => {
      prefSubs.add(f);
      return () => void prefSubs.delete(f);
    },
    speakRepliesOn,
    () => false,
  );
  return [on, setSpeakReplies];
}

/** A tap anywhere but a reply's own controls stops the reply (the controls carry data-speak-control). */
export function stopOnTapOutside(doc: Document = document) {
  const onTap = (e: Event) => {
    const s = replySpeaker();
    if (s.get().phase === "idle") return;
    const t = e.target as Element | null;
    if (t?.closest?.("[data-speak-control]")) return;
    s.stop();
  };
  doc.addEventListener("click", onTap, true);
  return () => doc.removeEventListener("click", onTap, true);
}

/** iPhone plays sound only after a tap: called from his voice note's Send, when Speak replies is on. */
export function unlockReplyAudio() {
  replySpeaker().unlock();
}
