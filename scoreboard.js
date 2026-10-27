// Golf Games live scoreboard for the web: for friends without the app, or on Android.
//
// The game code comes after "#" in the link, which browsers never send to any server. The page
// fetches the shared game from Apple's iCloud (CloudKit) public database, unlocks it in the
// browser with a key made from the code (the same AES-GCM encryption the app uses), and shows
// the scoreboard the organizer's phone laid out. It refreshes every 30 seconds.

const GOLF_GAMES_CLOUDKIT = {
  container: "iCloud.com.drjable7.golfgames",
  environment: "production",
  // A read-only CloudKit API token (CloudKit Console > API Access > Tokens). See PUBLISHING.md.
  apiToken: "a9b25b6c1fbbd56b0a000b622cbf514aef8ba596d37096abe457654f013b973b",
};

// How each game files and seals its shared record (must match the app).
const GOLF_GAMES_KINDS = {
  wolf: { prefix: "g", seed: "wolf-record-v1:", salt: "wolf-golf-share", info: "scoreboard-key-v1" },
  scramble: { prefix: "g", seed: "scramble-record-v1:", salt: "scramble-golf-share", info: "scoreboard-key-v1" },
  tournament: {
    prefix: "t", seed: "tournament-event-v1:", salt: "golf-tournament-share", info: "tournament-key-v1",
    sheets: { recordType: "TournamentScores", keySeed: "tournament-key-v1:" },
  },
};

const GolfScoreboard = (() => {
  const REFRESH_SECONDS = 30;
  // Swift dates count seconds from January 1, 2001.
  const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
  const utf8 = (text) => new TextEncoder().encode(text);

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", utf8(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function recordName(prefix, seed, code) {
    return prefix + (await sha256Hex(seed + code)).slice(0, 40);
  }

  async function keyFor(code, salt, info) {
    const base = await crypto.subtle.importKey("raw", utf8(code), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: utf8(salt), info: utf8(info) },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // CryptoKit's sealed box: 12-byte nonce, then the ciphertext with its 16-byte tag.
  async function open(sealed, key) {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, key, sealed.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const appleDate = (seconds) => new Date(APPLE_EPOCH_MS + seconds * 1000);

  function endpoint(action) {
    const c = GOLF_GAMES_CLOUDKIT;
    return `https://api.apple-cloudkit.com/database/1/${c.container}/${c.environment}/public/records/${action}?ckAPIToken=${encodeURIComponent(c.apiToken)}`;
  }

  async function post(action, body) {
    const response = await fetch(endpoint(action), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("network");
    return response.json();
  }

  async function lookup(name) {
    const result = await post("lookup", { records: [{ recordName: name }] });
    const record = result.records && result.records[0];
    if (!record || record.serverErrorCode) return null;
    return record.fields && record.fields.payload ? base64ToBytes(record.fields.payload.value) : null;
  }

  async function query(recordType, field, value) {
    const result = await post("query", {
      query: { recordType, filterBy: [{ fieldName: field, comparator: "EQUALS", fieldValue: { value } }] },
      resultsLimit: 200,
    });
    return (result.records || [])
      .filter((r) => r.fields && r.fields.payload)
      .map((r) => base64ToBytes(r.fields.payload.value));
  }

  /// The newest scoreboard for a code: the organizer's, or for a tournament, whichever
  /// phone's copy is newest. Returns { board, updatedAt, expiresAt } or throws a message.
  async function fetchBoard(kind, code) {
    const k = GOLF_GAMES_KINDS[kind];
    const key = await keyFor(code, k.salt, k.info);
    const sealed = await lookup(await recordName(k.prefix, k.seed, code));
    if (!sealed) throw problem("notFound", "This scoreboard wasn't found. It may have ended, or sharing was stopped.");
    let shared;
    try { shared = await open(sealed, key); } catch { throw problem("notFound", "This code doesn't match the scoreboard. Check the link with the organizer."); }

    let best = { board: shared.web, updatedAt: appleDate(shared.updatedAt), expiresAt: appleDate(shared.expiresAt) };
    if (k.sheets) {
      const tournamentKey = (await sha256Hex(k.sheets.keySeed + code)).slice(0, 40);
      const sheets = await query(k.sheets.recordType, "tournament", tournamentKey).catch(() => []);
      for (const sealedSheet of sheets) {
        try {
          const sheet = await open(sealedSheet, key);
          const updated = appleDate(sheet.updatedAt);
          if (sheet.web && updated > best.updatedAt) best = { ...best, board: sheet.web, updatedAt: updated };
        } catch { /* a sheet that can't be read is skipped */ }
      }
    }
    return best;
  }

  function problem(kind, message) {
    const error = new Error(message);
    error.kind = kind;
    return error;
  }

  // MARK: Drawing

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function drawSection(section) {
    const wrap = element("section", section.isScorecard ? "board-section scorecard-section" : "board-section");
    wrap.appendChild(element("h2", null, section.title));
    if (section.isScorecard && section.columns.length > 12) wrap.appendChild(element("p", "swipe-hint", "Swipe the card for every hole, or turn your phone sideways for the full scorecard."));
    const scroller = element("div", section.isScorecard ? "table-scroll scorecard" : "table-scroll");
    const table = element("table");
    const head = element("tr");
    section.columns.forEach((c) => head.appendChild(element("th", null, c)));
    table.appendChild(element("thead")).appendChild(head);
    const body = element("tbody");
    section.rows.forEach((row, index) => {
      // The par row on a scorecard; the leader (1st, or tied for 1st) on a leaderboard.
      const leader = !section.isScorecard && (row[0] === "1" || row[0] === "T1" || row[0] === "1st");
      const tr = element("tr", section.isScorecard && index === 0 ? "par-row" : leader ? "leader" : null);
      row.forEach((cell) => tr.appendChild(element("td", null, cell)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    if (section.note) wrap.appendChild(element("p", "note", section.note));
    return wrap;
  }

  /// A friendly, branded card for when the scoreboard can't be shown, with a place to type
  /// a code again and the other ways to get the link.
  const PROBLEMS = {
    noCode: ["🏌️", "Enter your group's code", "Type the 12-character code the organizer gave you, like 7K2Q-XM9F-PAT4."],
    notFound: ["⛳", "We couldn't open this scoreboard", "The code may have expired (games are shared for 48 hours after the last score, tournaments for 7 days), sharing may have been stopped, or a character was mistyped. Check the code and try again."],
    ended: ["🏆", "This round has wrapped up", "This scoreboard has expired. Shared games stay up for 48 hours after the last score, tournaments for 7 days."],
    oldApp: ["📲", "Almost there", "This game was shared from an older version of Golf Games. Ask the organizer to update the app, then refresh this page."],
    notReady: ["🛠️", "Web scoring is warming up", "Live scoring in the browser isn't switched on yet. The organizer can still share the game with the Golf Games app."],
  };

  function drawProblem(root, kind, code) {
    const [flag, title, message] = PROBLEMS[kind] || PROBLEMS.notFound;
    const card = element("div", "problem");
    card.appendChild(element("div", "flag", flag));
    card.appendChild(element("h2", null, title));
    card.appendChild(element("p", null, message));
    const form = element("form", "code-form");
    const input = element("input");
    Object.assign(input, { placeholder: "7K2Q-XM9F-PAT4", autocapitalize: "characters", autocomplete: "off", spellcheck: false, value: code ? code.match(/.{1,4}/g).join("-") : "" });
    input.setAttribute("aria-label", "Game code");
    const button = element("button", null, "Open");
    button.type = "submit";
    form.append(input, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const typed = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (typed.length !== 12) { input.focus(); input.select(); return; }
      location.hash = typed;
      location.reload();
    });
    card.appendChild(form);
    card.appendChild(element("p", null, "Still stuck? Ask the organizer to send the link again:"));
    const ways = element("ul", "ways");
    [["📡", "AirDrop it to you from their share screen"], ["💬", "Text you the join link"], ["🔳", "Show the QR code to scan with your Camera"]].forEach(([icon, text]) => {
      const li = element("li");
      li.append(element("span", null, icon), element("span", null, text));
      ways.appendChild(li);
    });
    card.appendChild(ways);
    root.replaceChildren(card);
  }

  function draw(root, result) {
    root.replaceChildren();
    const { board } = result;
    const header = element("div", "board-header");
    header.appendChild(element("div", "board-game", board.game));
    header.appendChild(element("h1", "board-title", board.title));
    header.appendChild(element("div", "board-status", board.status));
    root.appendChild(header);
    board.sections.forEach((s) => root.appendChild(drawSection(s)));
    // The slim header shown when the phone is sideways.
    const bar = document.getElementById("landscape-status");
    if (bar) bar.textContent = `${board.title} · ${board.status}`;
  }

  /// Starts the live scoreboard in `root` for the game kind, refreshing on its own.
  /// `onBoard` is called with each new scoreboard (to match the page to the game).
  function start(root, kind, code, statusLine, onBoard) {
    const dot = document.getElementById("live-dot");
    const setLive = (on) => { if (dot) dot.hidden = !on; };
    setLive(false);
    if (!code) { drawProblem(root, "noCode"); return; }
    if (GOLF_GAMES_CLOUDKIT.apiToken.startsWith("YOUR_")) { drawProblem(root, "notReady", code); return; }
    root.replaceChildren(element("p", "retrying", "Loading the live scoreboard…"));
    let lastUpdate = null;
    let timer = null;

    const tick = () => {
      if (!lastUpdate) return;
      const seconds = Math.max(0, Math.round((Date.now() - lastUpdate.updatedAt) / 1000));
      const ago = seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : lastUpdate.updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      statusLine.textContent = `LIVE · last score ${ago} · updates every ${REFRESH_SECONDS} seconds`;
    };

    const refresh = async () => {
      try {
        const result = await fetchBoard(kind, code);
        if (result.expiresAt < new Date() || !result.board) {
          drawProblem(root, result.board ? "ended" : "oldApp", code);
          statusLine.textContent = "";
          setLive(false);
          if (result.board) clearInterval(timer);
          return;
        }
        lastUpdate = result;
        draw(root, result);
        setLive(true);
        tick();
        if (onBoard) onBoard(result.board);
      } catch (error) {
        if (error.kind) {
          drawProblem(root, error.kind, code);
          statusLine.textContent = "";
          setLive(false);
          clearInterval(timer);
        } else if (!lastUpdate) {
          root.replaceChildren(element("p", "retrying", "Couldn't reach the scoreboard. Trying again…"));
        } else {
          statusLine.textContent = "Couldn't refresh. Trying again in 30 seconds…";
        }
      }
    };

    refresh();
    timer = setInterval(refresh, REFRESH_SECONDS * 1000);
    setInterval(tick, 5000);
    // Catch up as soon as the page is looked at again.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    return refresh;
  }

  return { start, drawProblem, fetchBoard, recordName, keyFor, open, sha256Hex, appleDate };
})();

if (typeof module !== "undefined") module.exports = { GolfScoreboard, GOLF_GAMES_KINDS, GOLF_GAMES_CLOUDKIT };
