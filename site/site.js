// Two things, both the pane's own gestures. Nothing else on the page runs
// script, and the page is complete without it: the strip stays hidden and the
// five clips stack; the command is plain text.

// 1. The strip: one clip at a time. Only the chosen clip's gif loads (a hidden
//    lazy image is never fetched), and the next one is fetched once the chosen
//    one has decoded, so the arrow key lands on a picture, not a blank.
const strip = document.querySelector(".strip");
if (strip) {
  const tabs = [...strip.querySelectorAll("[role=tab]")];
  const panels = tabs.map(t => document.getElementById(t.getAttribute("aria-controls")));
  const src = panel => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const s = panel.querySelector("source");
    return dark && s ? s.srcset : panel.querySelector("img").src;
  };
  const show = (i, focus) => {
    tabs.forEach((t, k) => {
      const on = k === i;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    });
    if (focus) tabs[i].focus();
    const next = panels[(i + 1) % panels.length];
    panels[i].querySelector("img").decode()
      .then(() => { new Image().src = src(next); })
      .catch(() => {});
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(i, false));
    t.addEventListener("keydown", e => {
      const n = tabs.length;
      const to = e.key === "ArrowRight" ? (i + 1) % n
        : e.key === "ArrowLeft" ? (i - 1 + n) % n
        : e.key === "Home" ? 0
        : e.key === "End" ? n - 1 : -1;
      if (to >= 0) { e.preventDefault(); show(to, true); }
    });
  });
  strip.hidden = false;
  show(0, false);
}

// 2. A Copy button beside the command, the way the pane's own command row has
//    one.
for (const pre of document.querySelectorAll(".install pre")) {
  const row = document.createElement("div");
  row.className = "command";
  pre.replaceWith(row);
  row.append(pre);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Copy";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy"; }, 1600);
    } catch {
      /* The clipboard refused (an insecure origin, a denied permission); the
         text is still there to select. */
    }
  });
  row.append(b);
}
