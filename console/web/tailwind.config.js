import animate from "tailwindcss-animate";
import plugin from "tailwindcss/plugin";

/** a phone in either hold: narrow, or a touch screen turned sideways (short). The call controls grow to 64 px there.
 * A variant, not a screen: a raw screen would switch off Tailwind's max-sm: variants everywhere. */
export const PHONE_MEDIA = "(max-width: 639.98px), (pointer: coarse) and (max-height: 540px)";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  // the hosted tree's pages (when it is there) use the same classes
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../../hosted/console/web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      // the wordmark face (Instrument Sans 600, src/polish.css loads it).
      fontFamily: { brand: ['"Instrument Sans"', "Inter", "ui-sans-serif", "sans-serif"] },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
    },
  },
  plugins: [animate, plugin(({ addVariant }) => addVariant("phone", `@media ${PHONE_MEDIA}`))],
};
