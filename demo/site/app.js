/*
 * Lamppost — the whole of the product's behaviour.
 *
 * One array of services drives every row of lamps. Nothing here reads the
 * clock or a random number, so the site looks the same on every run: the only
 * things that change are the ones a person presses.
 */

const SERVICES = ["API", "Dashboard", "Webhooks", "Email", "Search"];
// The link is wherever this page is being served from: the recording runs
// Lamppost on another port, and a link that named 9350 on camera would be
// wrong for the whole of the settings beats.
const STATUS_LINK = `${location.origin}/`;
const THEME_KEY = "lp-theme";

/** Draw the five lamps into every row on the page. */
function renderLamps() {
  for (const row of document.querySelectorAll("[data-lamps]")) {
    row.replaceChildren(
      ...SERVICES.map(name => {
        const lamp = document.createElement("div");
        lamp.className = "lamp";
        const bulb = document.createElement("span");
        bulb.className = "bulb";
        bulb.dataset.state = "green";
        const label = document.createElement("span");
        label.className = "lamp-name";
        label.textContent = name;
        lamp.append(bulb, label);
        return lamp;
      }),
    );
  }
}

function setLamps(state) {
  for (const bulb of document.querySelectorAll("[data-lamps] .bulb")) bulb.dataset.state = state;
}

/** The maintenance lock: amber lamps, a banner, and the post button off. */
function wireMaintenance() {
  const toggle = document.querySelector("#maintenance");
  if (!toggle) return;
  const banner = document.querySelector("#banner");
  const post = document.querySelector("#post");
  // Chrome restores a checkbox's checked state across a reload; the lock is
  // meant to clear itself so the demo starts from the same place every time.
  toggle.checked = false;
  const apply = () => {
    const on = toggle.checked;
    setLamps(on ? "amber" : "green");
    banner.hidden = !on;
    post.disabled = on;
  };
  toggle.addEventListener("change", apply);
  apply();
}

function wirePost() {
  const post = document.querySelector("#post");
  if (!post) return;
  const list = document.querySelector("#posted");
  post.addEventListener("click", () => {
    if (post.disabled) return;
    const line = document.createElement("p");
    line.className = "posted";
    line.textContent = "Update posted.";
    list.append(line);
  });
}

/** Copy the status link, and say so for two seconds. */
function wireShare() {
  const share = document.querySelector("#share");
  if (!share) return;
  const label = share.textContent;
  let back = null;
  share.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(STATUS_LINK);
    } catch {
      /* A browser that refuses the clipboard still gets the same reply. */
    }
    share.textContent = "Copied";
    clearTimeout(back);
    back = setTimeout(() => { share.textContent = label; }, 2000);
  });
}

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  for (const b of document.querySelectorAll("[data-theme-set]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themeSet === choice));
  }
}

function wireTheme() {
  let choice = "system";
  try { choice = localStorage.getItem(THEME_KEY) ?? "system"; } catch { /* private window */ }
  applyTheme(choice);
  for (const b of document.querySelectorAll("[data-theme-set]")) {
    b.addEventListener("click", () => {
      applyTheme(b.dataset.themeSet);
      try { localStorage.setItem(THEME_KEY, b.dataset.themeSet); } catch { /* private window */ }
    });
  }
}

/** The one key this fictional product knows. */
const GOOD_KEY = "lp_live_4f9c2a7e1d0b8c6e";

function wireKey() {
  const verify = document.querySelector("#verify");
  if (!verify) return;
  const field = document.querySelector("#key");
  const result = document.querySelector("#keyresult");
  verify.addEventListener("click", () => {
    result.textContent = field.value === GOOD_KEY ? "Key accepted." : "That key is not one of ours.";
  });
}

/** The status link, printed wherever a page shows it. */
function fillStatusLink() {
  for (const el of document.querySelectorAll("[data-status-link]")) el.textContent = STATUS_LINK;
}

renderLamps();
fillStatusLink();
wireMaintenance();
wirePost();
wireShare();
wireTheme();
wireKey();
