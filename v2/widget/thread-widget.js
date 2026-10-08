// Thread — Scriptable home-screen widget
// Shows your upcoming meetings, read from Thread's synced widget feed.
//
// ── SETUP (once) ──────────────────────────────────────────────
// 1. In Thread (the app): Sync → turn ON "Publish a home-screen widget feed",
//    and let it sync once. (Sync must already be set up.)
// 2. Install "Scriptable" from the App Store. Open it → + (new script) →
//    paste this whole file in. Give it a name like "Thread".
// 3. Fill in the two values below:
//      GIST_ID = your Sync code  (Thread → Sync → the "Sync code")
//      TOKEN   = your GitHub token (the same classic, gist-scope token Thread uses)
// 4. Tap ▶ to preview. Then from your home screen: long-press → add a
//    Scriptable widget → long-press it → Edit Widget → Script = "Thread".
//
// Note: the feed is UNENCRYPTED in your (secret) gist — that's what lets the
// widget read it without the slow passphrase step. The rest of your Thread
// data stays encrypted. Turn the feed off in Thread → Sync to stop publishing it.
// Refreshes on iOS's own schedule (roughly every 15–60 min), not in real time.
// ──────────────────────────────────────────────────────────────

const GIST_ID = "PASTE_YOUR_SYNC_CODE";
const TOKEN   = "PASTE_YOUR_GITHUB_TOKEN";

const ACCENT = "#4f46e5";
const THREAD_URL = "https://angela3famuz.github.io/weekly-planner/v2/";

async function loadFeed() {
  const req = new Request(`https://api.github.com/gists/${GIST_ID}`);
  req.headers = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" };
  const gist = await req.loadJSON();
  const file = gist.files && gist.files["thread-widget.json"];
  if (!file) throw new Error("No widget feed yet. In Thread → Sync, turn on the widget feed and sync.");
  let content = file.content;
  if (file.truncated && file.raw_url) content = await new Request(file.raw_url).loadString();
  return JSON.parse(content);
}

function pad(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function fmtTime(min) {
  min = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? "pm" : "am", h12 = (h % 12) || 12;
  return h12 + (m ? ":" + pad(m) : "") + ap;
}
function dayLabel(iso) {
  const p = iso.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color("#f4f4f3"), new Color("#101012"));
  w.setPadding(14, 14, 14, 14);
  const t = w.addText("Thread"); t.font = Font.boldSystemFont(14);
  t.textColor = Color.dynamic(new Color("#17171c"), new Color("#f2f2f4"));
  w.addSpacer(6);
  const e = w.addText(msg); e.font = Font.systemFont(11); e.textColor = Color.gray(); e.lineLimit = 4;
  w.url = THREAD_URL;
  return w;
}

async function build() {
  let feed;
  try { feed = await loadFeed(); } catch (e) { return errorWidget(String(e.message || e)); }

  const today = isoOf(new Date());
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const upcoming = (feed.meetings || [])
    .filter(m => m.date > today || (m.date === today && (m.start + m.dur) > now))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start);

  const ink = Color.dynamic(new Color("#17171c"), new Color("#f2f2f4"));
  const ink2 = Color.dynamic(new Color("#5c5c68"), new Color("#aeaeb8"));

  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color("#f4f4f3"), new Color("#101012"));
  w.setPadding(14, 14, 14, 14);

  // header
  const head = w.addStack(); head.centerAlignContent();
  const dot = head.addText("●"); dot.font = Font.systemFont(9); dot.textColor = new Color(ACCENT);
  head.addSpacer(5);
  const h = head.addText("Thread"); h.font = Font.boldSystemFont(13); h.textColor = ink;
  head.addSpacer();
  const todayLeft = upcoming.filter(m => m.date === today).length;
  const c = head.addText(todayLeft + " left today"); c.font = Font.systemFont(10.5); c.textColor = ink2;
  w.addSpacer(9);

  const fam = config.widgetFamily || "medium";
  const rows = fam === "small" ? 2 : fam === "large" ? 9 : 3;

  if (!upcoming.length) {
    const done = w.addText("Nothing coming up ✓");
    done.font = Font.systemFont(12); done.textColor = ink2;
  } else {
    upcoming.slice(0, rows).forEach((m, i) => {
      if (i) w.addSpacer(7);
      const row = w.addStack(); row.centerAlignContent();
      const bar = row.addStack(); bar.size = new Size(3, 18); bar.cornerRadius = 2;
      bar.backgroundColor = new Color(m.color || "#8a8a96");
      row.addSpacer(8);
      const col = row.addStack(); col.layoutVertically(); col.spacing = 1;
      const nm = col.addText(m.title || "Meeting");
      nm.font = Font.semiboldSystemFont(13); nm.textColor = ink; nm.lineLimit = 1;
      const when = (m.date === today ? "" : dayLabel(m.date) + " ") + fmtTime(m.start) + "–" + fmtTime(m.start + m.dur);
      const tm = col.addText(when); tm.font = Font.systemFont(10); tm.textColor = ink2; tm.lineLimit = 1;
    });
    if (upcoming.length > rows) {
      w.addSpacer(6);
      const more = w.addText("+" + (upcoming.length - rows) + " more");
      more.font = Font.systemFont(10); more.textColor = ink2;
    }
  }

  w.addSpacer();
  const when = feed.updated ? new Date(feed.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const foot = w.addText("synced " + when); foot.font = Font.systemFont(8); foot.textColor = Color.gray();

  w.url = THREAD_URL; // tap to open Thread
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
