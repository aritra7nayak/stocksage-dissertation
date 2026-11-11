import base from "../../frontend/tailwind.config.js";

/** The web app's design tokens, scanning both the shared and the mobile sources. */
export default {
  ...base,
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../frontend/src/**/*.{ts,tsx}"],
};
