// The light or dark theme for screenshots (#276). Setting `data-theme` on
// <html> is not enough on its own: a screenshot taken right after it can
// still show the old theme (style not recomputed, or not painted yet), and
// the app may set `data-theme` again from its settings. These helpers return
// only once the attribute holds, the page background has the theme's colour,
// and two frames have been painted with it.

/** True for "light", false for "dark", the system's choice for null. */
async function wantsLight(app, theme) {
  if (theme === "light") return true;
  if (theme === "dark") return false;
  return app.js("return matchMedia('(prefers-color-scheme: light)').matches");
}

/** The page background's relative luminance, 0 (black) to 1 (white). */
export function backgroundLuminance(app) {
  return app.js(`
    const m = getComputedStyle(document.body).backgroundColor.match(/[\\d.]+/g) ?? [];
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;`);
}

/** Resolve after the browser has painted two more frames. */
function twoFrames(app) {
  return app.driver.executeAsyncScript(
    "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()));",
  );
}

/**
 * Wait until the page shows `theme` ("light", "dark", or null for the
 * system's): `data-theme` is that value (absent for null), the body's
 * computed background is light or dark to match, and two frames have been
 * painted since. With `reapply`, set the attribute again whenever something
 * else changed it.
 */
export async function waitTheme(app, theme, { timeout = 10_000, reapply = false } = {}) {
  const light = await wantsLight(app, theme);
  const want = theme ?? "";
  let last = "";
  try {
    await app.waitFor(
      async () => {
        const attr = await app.js("return document.documentElement.dataset.theme ?? ''");
        if (attr !== want) {
          last = `data-theme="${attr}"`;
          if (reapply) await apply(app, theme);
          return false;
        }
        const lum = await backgroundLuminance(app);
        last = `background luminance ${lum.toFixed(2)}`;
        if (light ? lum < 0.6 : lum > 0.2) return false;
        await twoFrames(app);
        // Still the same after the frames (the app did not set it back).
        return (await app.js("return document.documentElement.dataset.theme ?? ''")) === want;
      },
      { timeout, interval: 100, message: `the ${theme ?? "system"} theme to apply` },
    );
  } catch (e) {
    throw new Error(`${e.message} (last seen: ${last})`);
  }
}

function apply(app, theme) {
  return app.js(
    `if (arguments[0]) document.documentElement.dataset.theme = arguments[0];
     else delete document.documentElement.dataset.theme;`,
    theme,
  );
}

/**
 * Force the light or dark theme (what Settings > Theme sets on <html>), or
 * follow the system with null, and wait until it shows.
 */
export async function setTheme(app, theme) {
  await apply(app, theme);
  await waitTheme(app, theme, { reapply: true });
}
