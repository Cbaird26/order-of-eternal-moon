#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const https = require("https");

const API_BASE = process.env.API_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "oem-raid-parser-2026";
const WHO_TRIGGER = process.env.WHO_TRIGGER || "/who guild";

function apiPost(endpoint, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const mod = url.protocol === "https:" ? https : http;
    const body = JSON.stringify(data);
    const opt = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = mod.request(opt, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const mod = url.protocol === "https:" ? https : http;
    const opt = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: { "x-api-key": API_KEY },
    };
    const req = mod.request(opt, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function extractName(line) {
  // [LEVEL CLASS] CharacterName (Tag)  or  [ANONYMOUS] CharacterName
  const match = line.match(/\]\s+(\S+)/);
  return match ? match[1] : null;
}

async function parseLog(logPath, eventId) {
  console.log(`\n📖 Parsing: ${path.basename(logPath)}`);

  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");

  const attendees = [];
  let collecting = false;

  for (const line of lines) {
    if (line.includes("Your search returned")) {
      collecting = true;
      continue;
    }
    if (collecting) {
      if (line.trim() === "" || line.includes("--") || !line.includes("]")) {
        collecting = false;
        break;
      }
      const name = extractName(line);
      if (name && !name.includes("You")) {
        attendees.push({ character_name: name });
      }
    }
  }

  if (attendees.length === 0) {
    console.log("   No attendees found. Run `/who guild` in-game then try again.");
    return;
  }

  console.log(`   Found ${attendees.length} guild members in zone`);

  if (eventId) {
    const result = await apiPost("/api/attendance", { event_id: eventId, attendees });
    console.log(`   ✅ ${result.message}`);
    if (result.notFound && result.notFound.length > 0) {
      console.log(`   ⚠️ Not registered on website: ${result.notFound.join(", ")}`);
    }
  } else {
    console.log("\n   Attendees detected:");
    attendees.forEach((a) => console.log(`     - ${a.character_name}`));
    console.log("\n   Run with --event <id> to auto-check-in (use --list-events to see events)");
  }
}

async function watchLog(logPath) {
  if (!fs.existsSync(logPath)) {
    console.error(`❌ Log not found: ${logPath}`);
    process.exit(1);
  }

  console.log(`\n👁️  Watching: ${path.basename(logPath)}`);
  console.log(`   Looking for "${WHO_TRIGGER}" in log...\n`);

  let lastSize = fs.statSync(logPath).size;
  let buffer = "";

  fs.watch(logPath, async (eventType) => {
    if (eventType !== "change") return;

    const stats = fs.statSync(logPath);
    if (stats.size < lastSize) { lastSize = stats.size; return; }

    const stream = fs.createReadStream(logPath, { start: lastSize, end: stats.size });
    lastSize = stats.size;

    let attendees = [];
    let collecting = false;
    let triggeredBy = "";

    for await (const chunk of stream) {
      buffer += chunk.toString();
    }

    const newLines = buffer.split("\n");
    buffer = newLines.pop() || "";

    for (const line of newLines) {
      const trimmed = line.trim();
      if (trimmed.includes(WHO_TRIGGER)) {
        collecting = true;
        triggeredBy = trimmed;
        attendees = [];
        console.log(`\n🔍 Detected: /who guild — collecting...`);
        continue;
      }
      if (collecting) {
        if (trimmed === "" || trimmed.includes("--") || !trimmed.includes("]")) {
          collecting = false;
          console.log(`   Found ${attendees.length} members`);

          // Fetch upcoming events and pick the latest
          try {
            const events = await apiGet("/api/events/upcoming");
            if (events.length > 0) {
              const eventId = events[0].id;
              const result = await apiPost("/api/attendance", { event_id: eventId, attendees });
              console.log(`   ✅ ${result.message}`);
              if (result.notFound && result.notFound.length > 0) {
                console.log(`   ⚠️ Not registered: ${result.notFound.join(", ")}`);
              }
            } else {
              console.log("   ⚠️ No upcoming events to assign attendance to");
            }
          } catch (e) {
            console.log(`   ⚠️ API error: ${e.message}`);
          }
          break;
        }
        const name = extractName(trimmed);
        if (name && !name.includes("You")) {
          attendees.push({ character_name: name });
        }
      }
    }
  });

  console.log("   Waiting for in-game `/who guild` command...");
}

async function listEvents() {
  const events = await apiGet("/api/events/upcoming");
  if (events.length === 0) {
    console.log("No upcoming events.");
    return;
  }
  console.log("\n📅 Upcoming Events:");
  events.forEach((e) => {
    console.log(`   #${e.id} — ${e.title} @ ${e.location || "TBD"} (${new Date(e.event_date).toLocaleDateString()})`);
  });
}

function findLogFile(charName) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crossoverBase = `${home}/Library/Application Support/CrossOver/Bottles/EverQuest Legends/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs`;

  const searchPaths = [
    process.env.EQ_LOG_PATH,
    charName ? `${crossoverBase}/eqlog_${charName}_Rivervale.txt` : null,
    `${crossoverBase}/eqlog_${charName}_Rivervale.txt`,
    `./logs/eqlog_${charName}_Rivervale.txt`,
    `./eqlog_${charName}_Rivervale.txt`,
  ];

  for (const p of searchPaths) {
    if (p && fs.existsSync(p)) return p;
  }

  const dirs = [
    process.env.EQ_LOG_PATH && path.dirname(process.env.EQ_LOG_PATH),
    crossoverBase,
    "./logs",
  ];

  for (const d of dirs) {
    if (d && fs.existsSync(d)) {
      const files = fs.readdirSync(d).filter((f) => f.startsWith("eqlog_") && f.endsWith(".txt"));
      if (files.length > 0) return path.join(d, files[0]);
    }
  }

  // CrossOver bottle drive root
  const searchRoot = `${home}/Library/Application Support/CrossOver/Bottles/EverQuest Legends/drive_c`;
  if (fs.existsSync(searchRoot)) {
    const result = require("child_process").execSync(
      `find '${searchRoot}' -name 'eqlog_*.txt' -type f 2>/dev/null | head -1`
    ).toString().trim();
    if (result) return result;
  }

  return null;
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--list-events" || cmd === "-e") {
    await listEvents();
    return;
  }

  if (cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(`
🌙 Order of the Eternal Moon — EQ Legends Raid Attendance Parser

USAGE:
  node parser/index.js <logfile> --event <id>    Parse a log file and check in attendees
  node parser/index.js <logfile>                  Parse a log file (dry-run, no check-in)
  node parser/index.js --watch <logfile>          Watch a log file in real-time
  node parser/index.js --auto                     Auto-detect log file and watch
  node parser/index.js --list-events              Show upcoming events

ENV VARS:
  API_URL          Website URL (default: http://localhost:3000)
  API_KEY          API key (default: oem-raid-parser-2026)
  EQ_LOG_PATH      Direct path to log file
  WHO_TRIGGER      Trigger text (default: /who guild)
    `);
    return;
  }

  if (cmd === "--auto") {
    const charName = args[1] || "";
    const logPath = findLogFile(charName);
    if (!logPath) {
      console.error("❌ Could not auto-detect log file. Set EQ_LOG_PATH or specify a character name.");
      process.exit(1);
    }
    console.log(`   Auto-detected: ${logPath}`);
    return watchLog(logPath);
  }

  if (cmd === "--watch") {
    const logPath = args[1];
    if (!logPath) { console.error("❌ Specify a log file path"); process.exit(1); }
    return watchLog(logPath);
  }

  const logPath = cmd;
  const eventIdx = args.indexOf("--event");
  const eventId = eventIdx !== -1 ? parseInt(args[eventIdx + 1]) : null;

  if (!fs.existsSync(logPath)) {
    console.error(`❌ File not found: ${logPath}`);
    console.error("   Tip: Run with --auto to auto-detect your log file");
    process.exit(1);
  }

  await parseLog(logPath, eventId);
}

main().catch(console.error);
