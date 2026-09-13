/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Gumroad-inspired palette
        ink: "#000000",
        paper: "#FFFFFF",
        canvas: "#FDF7F2", // warm cream app background
        pink: {
          DEFAULT: "#FF90E8",
          dark: "#FC4AD8",
        },
        lime: "#90A8ED", // periwinkle accent
        sun: "#FFC900",
        mint: "#23A094",
        coral: "#FF7051",
        violet: "#B23386",
        sky: "#90DDFF",
        peach: "#FFC3A0",
        lavender: "#DAD3FF",
        success: "#23A094",
        warning: "#FFC900",
        danger: "#E03131",
        muted: "#6B6B6B",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        hard: "4px 4px 0 0 #000000",
        "hard-sm": "2px 2px 0 0 #000000",
        "hard-lg": "6px 6px 0 0 #000000",
        "hard-pink": "4px 4px 0 0 #FF90E8",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "pop-in": "pop-in 0.15s ease-out",
      },
    },
  },
  plugins: [],
};
