/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#dbe6ff",
          200: "#bfd2ff",
          300: "#93b3ff",
          400: "#6089ff",
          500: "#3a63ff",
          600: "#2245f5",
          700: "#1a35d0",
          800: "#1a2fa0",
          900: "#1c2d7f"
        }
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif"
        ]
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 24px -8px rgba(15, 23, 42, 0.08)"
      }
    }
  },
  plugins: []
}
