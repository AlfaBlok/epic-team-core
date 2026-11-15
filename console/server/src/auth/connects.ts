/**
 * One-button connects: an account the team needs, connected by its owner with one tap.
 *
 * Each connect is one config entry (sites().connects): the provider, the scopes, the exact account to pick, the channel
 * or page it reaches and the store names its keys go to. The console shows it as a card with one button in the inbox and
 * on the Connections page (GET /api/connects); the button opens the provider's own consent page in the browser the owner
 * is in, with the account named (`login_hint`). The provider returns to the console, which stores the keys in its secret
 * store (never shown, never in git) and the card says Connected.
 *
 *   GET /api/connects                              the cards: who, what, connected or not, the button's address
 *   GET /api/access/oauth/connect/<id>/start       to the provider's consent page (on the customer site whose callback
 *                                                  the provider's web client lists: auth/oauth.ts)
 *
 * A new Google connect is one more entry: the console's own Google web client carries it, whose project must have that
 * API switched on (the YouTube connect switches its own on: auth/youtubeConnect.ts).
 */

export interface ConnectSpec {
  /** the address part: /api/access/oauth/connect/<id>/start */
  id: string;
  provider: "google";
  /** the button and card title, e.g. "Connect Sam YouTube" */
  title: string;
  /** one plain line: what the team does with it */
  what: string;
  /** the exact account to pick on the provider's page (sent as its account hint) */
  account: string;
  /** the channel or page it reaches, when there is one */
  channel?: { name: string; handle: string; id?: string };
  scopes: string[];
  /** the console store names the three keys go to */
  keys: { clientId: string; clientSecret: string; refreshToken: string };
  /** an extra check before storing: `youtube-channel` = the Allow must reach one of sites().youtubeChannels */
  check?: "youtube-channel";
  /** the inbox shows the card while not connected (default true) */
  inbox?: boolean;
}

export interface ConnectView {
  id: string;
  title: string;
  what: string;
  account: string;
  channel?: ConnectSpec["channel"];
  /** plain names of what the Allow gives, for the card */
  gives: string[];
  connected: boolean;
  at?: string;
  /** the button's address (absolute: the customer site that carries the callback) */
  startUrl: string;
  inbox: boolean;
}

/** a scope's plain name for the card (unknown scopes show their last part) */
export function scopeName(scope: string): string {
  const last = scope.split("/").pop() ?? scope;
  const names: Record<string, string> = {
    "youtube.upload": "upload videos",
    "youtube.force-ssl": "manage videos and comments",
    "youtube.readonly": "read the channel",
    "yt-analytics.readonly": "read the channel's numbers",
    "gmail.readonly": "read mail",
    "gmail.send": "send mail",
    "drive.file": "files it makes in Drive",
    "calendar.readonly": "read the calendar",
  };
  return names[last] ?? last;
}

/** the connects with a usable shape (a bad entry is dropped, not fatal) */
export function validConnects(list: unknown): ConnectSpec[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is ConnectSpec =>
      !!c &&
      typeof c === "object" &&
      /^[a-z0-9-]{2,40}$/.test((c as ConnectSpec).id) &&
      (c as ConnectSpec).provider === "google" &&
      typeof (c as ConnectSpec).title === "string" &&
      typeof (c as ConnectSpec).account === "string" &&
      Array.isArray((c as ConnectSpec).scopes) &&
      (c as ConnectSpec).scopes.length > 0 &&
      !!(c as ConnectSpec).keys?.refreshToken,
  );
}
