/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens driven by CSS variables → enables light/dark
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        // Accents (constant across themes, tuned to read on both)
        brand: "#5B8DEF",
        cyan: "#22C5E0",
        buy: "#16C784",
        sell: "#F0526B",
        hold: "#F2A93B",
        violet: "#8B7CF6",
      },
      fontFamily: {
        display: ["Sora", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        soft: "0 8px 30px rgba(0,0,0,0.12)",
      },
    },
  },
  plugins: [],
};
