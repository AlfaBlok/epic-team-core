import { useState, type ReactNode } from "react";
import { api } from "@/api";
import type { Pursuit, PursuitKitBody, SocialKit } from "@/api/pursuit-types";
import { useQuery } from "@/lib/data";
import { Link } from "react-router-dom";
import { productHref } from "@/lib/scorecards";

/**
 * A pursuit's social kit, inside the console: the Social kit tab of the pursuit's own page (/pursuits/<id>/social-kit),
 * under the normal top bar, reached from Pursuits in the top bar or the menu, never a page of its own. Every word, colour
 * and size comes from the kit's kit.json in the repo (the pursuit's `kit.dir`), the previews from its previews/ folder
 * (GET /api/pursuits/<id>/kit/...); only the full-size downloads link into the pursuit's file store (`kit.files`).
 */
export const SOCIAL_KIT_TAB = "social-kit";

/**
 * Pursuits now live in the sidebar as goal sets (/sets/<id>), so the kit is a tab of the
 * set's own page, `/sets/<id>?tab=kit`; the old /pursuits/<id>/social-kit address leads there.
 */
export const SET_KIT_TAB = "kit";
export const setKitHref = (setId: string) => `/sets/${encodeURIComponent(setId)}?tab=${SET_KIT_TAB}`;

/**
 * Whose kit a set shows: its own pursuit's when it has one, else the pursuit its "Social kit" totem points at (the
 * testers set shows the product kit). Undefined = no kit in the console (a kit that still lives outside).
 */
export function kitPursuitOf(pursuits: Pursuit[] | undefined, setId: string): string | undefined {
  const p = pursuits?.find((x) => x.id === setId);
  if (!p) return undefined;
  if (p.kit) return p.id;
  const url = p.totems.find((t) => /social kit/i.test(t.label))?.url ?? "";
  const m = /^\/(?:pursuits\/([\w-]+)\/social-kit|sets\/([\w-]+)\?tab=kit)$/.exec(url);
  const id = m?.[1] ?? m?.[2];
  return id && pursuits?.find((x) => x.id === id)?.kit ? id : undefined;
}

/** `id` is the kit's base: `/api/products/<id>` when the kit is its product's, else `/api/pursuits/<id>`. */
const fileUrl = (base: string, kind: "previews" | "fonts", name: string) => `${base}/kit/${kind}/${name}`;
/** where a kit body's files are read: its product's, else its pursuit's. */
export const kitBase = (body: PursuitKitBody) => (body.product ? `/api/products/${encodeURIComponent(body.product.id)}` : `/api/pursuits/${encodeURIComponent(body.pursuit?.id ?? "")}`);

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="grid min-w-0 scroll-mt-20 gap-3 border-t pt-4" data-testid="kit-section" data-part={id}>
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Shot({ id, name, alt, w }: { id: string; name: string; alt: string; w?: number }) {
  return (
    <figure className="grid min-w-0 gap-1">
      <img src={fileUrl(id, "previews", name + ".webp")} alt={alt} loading="lazy" className="h-auto max-w-full rounded-md border bg-muted" style={w ? { width: w } : undefined} data-testid="kit-shot" />
      <figcaption className="text-xs text-muted-foreground">{alt}</figcaption>
    </figure>
  );
}

function Downloads({ files, names }: { files?: string; names: string[] }) {
  if (!files) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="kit-downloads">
      <span>Full-size files:</span>
      {names.map((n) => (
        <a key={n} href={files + n} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-4 hover:text-foreground [overflow-wrap:anywhere]">
          {n.replace(/\.(png|svg)$/, "").replace(/^(avatar|banner|post)-/, "")}
        </a>
      ))}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => {
        const ok = () => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        };
        // a browser that refuses the clipboard (no permission, an old phone) still copies through a hidden selection.
        const fallback = () => {
          const t = document.createElement("textarea");
          t.value = text;
          t.setAttribute("readonly", "");
          t.style.position = "fixed";
          t.style.opacity = "0";
          document.body.appendChild(t);
          t.select();
          try {
            if (document.execCommand("copy")) ok();
          } catch {
            /* nothing more to try: the text stays on screen to select by hand */
          }
          t.remove();
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
        else fallback();
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** The kit's own type, loaded from its fonts in the repo, so the specimen and tagline show the product's look. */
function KitFonts({ id, kit }: { id: string; kit: SocialKit }) {
  const faces = [kit.fonts?.display, kit.fonts?.body].filter((f): f is { family: string; file: string } => !!f?.family && /^[\w-]+\.woff2$/.test(f.file ?? ""));
  if (!faces.length) return null;
  const css = faces.map((f) => `@font-face{font-family:"kit ${f.family}";src:url("${fileUrl(id, "fonts", f.file)}") format("woff2");font-display:swap;}`).join("");
  return <style>{css}</style>;
}

export function SocialKitBody({ body }: { body: PursuitKitBody }) {
  const { kit, files } = body;
  const id = kitBase(body);
  const display = kit.fonts?.display?.family ? `"kit ${kit.fonts.display.family}", system-ui, sans-serif` : undefined;
  const bodyFont = kit.fonts?.body?.family ? `"kit ${kit.fonts.body.family}", system-ui, sans-serif` : undefined;
  const accent = kit.page?.accent;
  const parts: [string, string][] = [
    ["accounts", "Link and accounts"],
    ["picture", "Profile picture"],
    ["banners", "Banners"],
    ["bios", "Bio lines"],
    ["colours", "Colours"],
    ["type", "Type"],
    ["templates", "Post templates"],
  ];
  return (
    <div className="grid min-w-0 gap-4" data-testid="social-kit" data-kit={kit.id}>
      <KitFonts id={id} kit={kit} />
      <div className="flex min-w-0 items-center gap-4 rounded-xl border bg-card p-4">
        <img src={fileUrl(id, "previews", "avatars-round.webp")} alt="" className="hidden h-16 w-auto shrink-0 sm:block" />
        <div className="grid min-w-0 gap-1">
          <div className="text-xs text-muted-foreground">{kit.name} social kit · one place for every picture, banner, bio line and post template</div>
          {kit.tagline && (
            <p className="text-xl font-medium leading-snug text-foreground [overflow-wrap:anywhere]" style={{ fontFamily: display }} data-testid="kit-tagline">
              {kit.tagline}
            </p>
          )}
          {kit.taglineSub && <p className="text-sm text-muted-foreground">{kit.taglineSub}</p>}
        </div>
      </div>
      {/* the kit's parts, one tap each, so the long page is easy to walk on a phone. */}
      <nav className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Kit parts" data-testid="kit-parts">
        {parts.map(([pid, label]) => (
          <a key={pid} href={`#${pid}`} className="text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">
            {label}
          </a>
        ))}
      </nav>

      <Section id="accounts" title="Link and accounts">
        {kit.link && (
          <a href={kit.link} target="_blank" rel="noreferrer" className="text-sm text-foreground underline decoration-border underline-offset-4">
            {kit.domain ?? kit.link}
          </a>
        )}
        <ul className="divide-y rounded-lg border">
          {(kit.accounts ?? []).map((a) => (
            <li key={a.platform} className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2 text-sm">
              {/* the account and its handle stay on one line; a long note beside it wraps instead */}
              <span className="max-w-full shrink-0 whitespace-nowrap">
                <span className="text-muted-foreground">{a.platform} </span>
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-4">
                    {a.handle}
                  </a>
                ) : (
                  a.handle
                )}
              </span>
              {a.state && <span className="min-w-0 text-right text-xs text-muted-foreground">{a.state}</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="picture" title="Profile picture">
        <Shot id={id} name="avatars-round" alt="The mark at avatar sizes, round and square" w={640} />
        {kit.avatar?.note && <p className="text-sm text-muted-foreground">{kit.avatar.note}</p>}
        <Downloads files={files} names={["avatar-400.png", "avatar-800.png", "avatar-1024.png", "avatar-1080.png", "avatar.svg"]} />
      </Section>

      <Section id="banners" title="Banners">
        <h3 className="text-sm font-medium">X</h3>
        <Shot id={id} name="banner-x" alt="X header, 1500 × 500" />
        <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
          <Shot id={id} name="x-profile-desktop" alt="On a computer" />
          <Shot id={id} name="x-profile-phone" alt="On a phone" />
        </div>
        <h3 className="text-sm font-medium">YouTube</h3>
        <Shot id={id} name="banner-youtube" alt="YouTube banner, 2560 × 1440, the words inside the safe area" />
        <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
          <Shot id={id} name="youtube-desktop" alt="On a computer" />
          <Shot id={id} name="youtube-phone" alt="On a phone" />
        </div>
        <h3 className="text-sm font-medium">LinkedIn</h3>
        <Shot id={id} name="linkedin-page" alt="LinkedIn page with cover and logo, 1128 × 191" />
        <Downloads files={files} names={["banner-x-1500x500.png", "banner-youtube-2560x1440.png", "banner-linkedin-1128x191.png"]} />
      </Section>

      <Section id="bios" title="Bio lines">
        <ul className="grid gap-2">
          {(kit.bios ?? []).map((b) => (
            <li key={b.where} className="grid gap-1 rounded-lg border p-3" data-testid="kit-bio">
              <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>{b.where}</span>
                <span>{[...b.text].length} letters</span>
              </div>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <p className="min-w-0 whitespace-pre-line text-sm text-foreground [overflow-wrap:anywhere]">{b.text}</p>
                <CopyLine text={b.text} />
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="colours" title="Colours">
        <ul className="grid gap-2 sm:grid-cols-2">
          {(kit.colours ?? []).map((c) => (
            <li key={c.hex + c.name} className="flex min-w-0 items-center gap-3 rounded-lg border p-2" data-testid="kit-colour">
              <span className="h-10 w-10 shrink-0 rounded-md border" style={{ background: /^#[0-9a-f]{3,8}$/i.test(c.hex) ? c.hex : undefined }} aria-hidden="true" />
              <span className="grid min-w-0">
                <span className="text-sm font-medium">
                  {c.name} <span className="font-normal text-muted-foreground">{c.hex}</span>
                </span>
                {c.use && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{c.use}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="type" title="Type">
        {kit.fonts?.display && (
          <div className="grid gap-1">
            <div className="text-xs text-muted-foreground">Headlines: {kit.fonts.display.family}</div>
            <p className="text-2xl leading-tight [overflow-wrap:anywhere]" style={{ fontFamily: display, fontWeight: kit.fonts.display.use, color: accent }}>
              {kit.claim ?? kit.tagline}
            </p>
          </div>
        )}
        {kit.fonts?.body && (
          <div className="grid gap-1">
            <div className="text-xs text-muted-foreground">Text: {kit.fonts.body.family}</div>
            <p className="text-base [overflow-wrap:anywhere]" style={{ fontFamily: bodyFont, fontWeight: kit.fonts.body.use }}>
              {kit.line ?? kit.taglineSub}
            </p>
          </div>
        )}
      </Section>

      <Section id="templates" title="Post templates">
        <div className="grid gap-4 sm:grid-cols-3">
          {(kit.templates ?? []).map((t) => (
            <div key={t.id} className="grid content-start gap-1" data-testid="kit-template">
              <Shot id={id} name={`post-${t.id}`} alt={`${t.title}, ${t.w} × ${t.h}`} />
              {t.for && <div className="text-xs text-muted-foreground">{t.for}</div>}
              <Downloads files={files} names={[`post-${t.id}-${t.w}x${t.h}.png`]} />
            </div>
          ))}
        </div>
        {(kit.postTexts ?? []).length > 0 && (
          <ul className="grid gap-2">
            {kit.postTexts!.map((t) => (
              <li key={t.title} className="grid gap-1 rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{t.title}</span>
                  <CopyLine text={t.text} />
                </div>
                <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">{t.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(kit.versions ?? []).length > 0 && (
        <Section id="versions" title="Versions">
          <ul className="grid gap-1 text-sm">
            {kit.versions!.map((v) => (
              <li key={v.version} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{v.version}</span> <span className="text-muted-foreground">{v.date}:</span> {v.what}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function SocialKitView({ id }: { id: string }) {
  const { data, error, loading } = useQuery<PursuitKitBody>(() => api.getPursuitKit(id), [id]);
  if (loading && !data) return <div className="text-sm text-muted-foreground">Opening the kit…</div>;
  if (error || !data) return <div className="text-sm text-destructive">Could not open the social kit{error ? `: ${error.message}` : ""}.</div>;
  return (
    <div className="grid min-w-0 gap-3">
      {/* the kit is the product's, written once there; every objective on the product shows the same one. */}
      {data.product && (
        <p className="text-sm text-muted-foreground" data-testid="kit-of-product">
          {data.product.name}&rsquo;s kit, kept once on its product.{" "}
          <Link to={productHref(data.product.id)} className="underline decoration-border underline-offset-4 hover:text-foreground">
            Open {data.product.name}
          </Link>
        </p>
      )}
      <SocialKitBody body={data} />
    </div>
  );
}
