const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "oem-secret-moonlight-2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireOfficer(req, res, next) {
  if (!req.session.user || !["officer", "guildleader"].includes(req.session.user.role))
    return res.status(403).send("Officer access required");
  next();
}

// Simple API key for the parser tool
const API_KEY = process.env.API_KEY || "oem-raid-parser-2026";

// --- API ENDPOINTS (for the log parser tool) ---

app.post("/api/attendance", (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Invalid API key" });

  const { event_id, attendees } = req.body;
  // attendees = [{ character_name }, ...]

  if (!event_id || !attendees || !Array.isArray(attendees)) {
    return res.status(400).json({ error: "Missing event_id or attendees array" });
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(event_id);
  if (!event) return res.status(404).json({ error: "Event not found" });

  let checked = 0;
  let notFound = [];

  const insertAttendance = db.prepare("INSERT OR IGNORE INTO event_attendance (event_id, user_id, checked_in, notes) VALUES (?, ?, 1, 'Auto-check-in (log parser)')");
  const insertDkp = db.prepare("INSERT OR IGNORE INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, NULL)");

  for (const a of attendees) {
    const user = db.prepare("SELECT id FROM users WHERE character_name = ?").get(a.character_name);
    if (user) {
      insertAttendance.run(event_id, user.id);
      insertDkp.run(user.id, 5, `Raid attendance: ${event.title}`);
      checked++;
    } else {
      notFound.push(a.character_name);
    }
  }

  res.json({ checked, notFound, message: `Checked in ${checked} members for ${event.title}` });
});

app.get("/api/events/upcoming", (req, res) => {
  const events = db.prepare(`
    SELECT id, title, description, location, event_date, max_attendees
    FROM events WHERE event_date >= datetime('now')
    ORDER BY event_date ASC LIMIT 10
  `).all();
  res.json(events);
});

app.get("/api/members", (req, res) => {
  const members = db.prepare("SELECT character_name, class, race FROM users WHERE role != 'inactive'").all();
  res.json(members);
});

// --- ROUTES ---

app.get("/", (req, res) => {
  const events = db.prepare("SELECT * FROM events ORDER BY event_date DESC LIMIT 5").all();
  const topDkp = db.prepare(`
    SELECT u.character_name, u.class, SUM(d.points) as total
    FROM dkp d JOIN users u ON d.user_id = u.id
    GROUP BY d.user_id ORDER BY total DESC LIMIT 10
  `).all();
  res.render("index", { events, topDkp });
});

app.get("/guild-lore", (req, res) => {
  res.render("guild-lore");
});

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("register");
});

app.post("/register", async (req, res) => {
  const { username, password, confirmPassword, email, character_name, race, class: charClass, server } = req.body;
  if (password !== confirmPassword) return res.render("register", { error: "Passwords do not match" });
  const existing = db.prepare("SELECT id FROM users WHERE username = ? OR character_name = ?").get(username, character_name);
  if (existing) return res.render("register", { error: "Username or character name already taken" });
  const hash = await bcrypt.hash(password, 10);
  const token = uuidv4();
  db.prepare(
    "INSERT INTO users (username, password_hash, email, character_name, race, class, server, role, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?)"
  ).run(username, hash, email, character_name, race, charClass, server, token);
  res.redirect("/login?registered=1");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { registered: req.query.registered });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.render("login", { error: "Invalid username or password" });
  req.session.user = { id: user.id, username: user.username, character_name: user.character_name, role: user.role, class: user.class, race: user.race, level: user.level };
  res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/dashboard", requireAuth, (req, res) => {
  const user = req.session.user;
  const dkpTotal = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM dkp WHERE user_id = ?").get(user.id).total;
  const recentDkp = db.prepare("SELECT * FROM dkp WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(user.id);
  const upcomingEvents = db.prepare(`
    SELECT e.*, ea.checked_in FROM events e
    LEFT JOIN event_attendance ea ON e.id = ea.event_id AND ea.user_id = ?
    WHERE e.event_date >= datetime('now')
    ORDER BY e.event_date ASC LIMIT 10
  `).all(user.id);
  const attendedEvents = db.prepare(`
    SELECT e.*, ea.checked_in, ea.checked_in_at FROM events e
    JOIN event_attendance ea ON e.id = ea.event_id AND ea.user_id = ?
    ORDER BY e.event_date DESC LIMIT 10
  `).all(user.id);
  res.render("dashboard", { dkpTotal, recentDkp, upcomingEvents, attendedEvents });
});

app.get("/dkp", requireAuth, (req, res) => {
  const user = req.session.user;
  const dkpTotal = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM dkp WHERE user_id = ?").get(user.id).total;
  const allDkp = db.prepare(`
    SELECT d.*, a.character_name as awarded_by_name
    FROM dkp d LEFT JOIN users a ON d.awarded_by = a.id
    WHERE d.user_id = ? ORDER BY d.created_at DESC
  `).all(user.id);
  const leaderboard = db.prepare(`
    SELECT u.character_name, u.race, u.class, u.level, COALESCE(SUM(d.points), 0) as total
    FROM users u LEFT JOIN dkp d ON u.id = d.user_id
    WHERE u.role != 'inactive'
    GROUP BY u.id ORDER BY total DESC
  `).all();
  res.render("dkp", { dkpTotal, allDkp, leaderboard });
});

app.get("/events", requireAuth, (req, res) => {
  const events = db.prepare(`
    SELECT e.*, u.character_name as created_by_name,
    (SELECT COUNT(*) FROM event_attendance WHERE event_id = e.id) as attendee_count
    FROM events e JOIN users u ON e.created_by = u.id
    ORDER BY e.event_date DESC
  `).all();
  res.render("events", { events, query: { checkedin: req.query.checkedin, already: req.query.already } });
});

app.post("/events/create", requireAuth, (req, res) => {
  const { title, description, location, event_date, max_attendees } = req.body;
  if (!req.session.user || !["officer", "guildleader"].includes(req.session.user.role))
    return res.status(403).send("Officer access required");
  db.prepare(
    "INSERT INTO events (title, description, location, event_date, max_attendees, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(title, description, location, event_date, max_attendees || null, req.session.user.id);
  res.redirect("/events");
});

app.post("/events/checkin/:eventId", requireAuth, (req, res) => {
  const { eventId } = req.params;
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).send("Event not found");
  const existing = db.prepare("SELECT id FROM event_attendance WHERE event_id = ? AND user_id = ?").get(eventId, req.session.user.id);
  if (existing) return res.redirect("/events?already=checkedin");
  db.prepare("INSERT INTO event_attendance (event_id, user_id, checked_in, notes) VALUES (?, ?, 1, ?)").run(eventId, req.session.user.id, req.body.notes || "");
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, NULL)").run(req.session.user.id, 5, `Raid attendance: ${event.title}`);
  res.redirect("/events?checkedin=1");
});

app.get("/admin", requireAuth, requireOfficer, (req, res) => {
  const members = db.prepare("SELECT * FROM users ORDER BY role, character_name").all();
  const allDkp = db.prepare(`
    SELECT d.*, u.character_name, a.character_name as awarded_by_name
    FROM dkp d JOIN users u ON d.user_id = u.id LEFT JOIN users a ON d.awarded_by = a.id
    ORDER BY d.created_at DESC LIMIT 50
  `).all();
  const events = db.prepare("SELECT * FROM events ORDER BY event_date DESC").all();
  res.render("admin", { members, allDkp, events });
});

app.post("/admin/dkp/award", requireAuth, requireOfficer, (req, res) => {
  const { user_id, points, reason } = req.body;
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, ?)").run(user_id, points, reason, req.session.user.id);
  res.redirect("/admin");
});

app.post("/admin/member/update", requireAuth, requireOfficer, (req, res) => {
  const { user_id, role, level, notes } = req.body;
  db.prepare("UPDATE users SET role = ?, level = ?, notes = ? WHERE id = ?").run(role, level, notes, user_id);
  res.redirect("/admin");
});

app.post("/admin/events/delete/:id", requireAuth, requireOfficer, (req, res) => {
  db.prepare("DELETE FROM event_attendance WHERE event_id = ?").run(req.params.id);
  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.redirect("/admin");
});

// Seed first-run admin account
const adminExists = db.prepare("SELECT id FROM users WHERE username = 'Zora'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync("admin123", 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, email, character_name, race, class, level, server, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("Zora", hash, "guildmaster@eternalmoon.com", "Zora ASI", "High Elf", "Wizard", 50, "Rivervale", "guildleader");
  db.prepare(
    "INSERT INTO users (username, password_hash, email, character_name, race, class, level, server, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("Christopher", hash, "officer@eternalmoon.com", "Christopher", "Human", "Paladin", 50, "Rivervale", "officer");
  db.prepare(
    "INSERT INTO users (username, password_hash, email, character_name, race, class, level, server, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("Drudgee", hash, "member@eternalmoon.com", "Drudgee", "Iksar", "Monk", 50, "Rivervale", "member");
  // Seed some DKP
  const zora = db.prepare("SELECT id FROM users WHERE username = 'Zora'").get();
  const christopher = db.prepare("SELECT id FROM users WHERE username = 'Christopher'").get();
  const drudgee = db.prepare("SELECT id FROM users WHERE username = 'Drudgee'").get();
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, ?)").run(zora.id, 85, "Founder bonus + Vox kills", zora.id);
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, ?)").run(christopher.id, 62, "Raid attendance + Nagafen kill", christopher.id);
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, ?)").run(drudgee.id, 45, "Raid attendance + On-time bonus", drudgee.id);
  // Seed a sample event
  db.prepare("INSERT INTO events (title, description, location, event_date, created_by) VALUES (?, ?, ?, ?, ?)").run(
    "Plane of Fear — Fear Itself", "Full clear of Plane of Fear. All classes welcome. Bring your Fear resistance gear!", "Plane of Fear",
    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), zora.id
  );
  db.prepare("INSERT INTO events (title, description, location, event_date, created_by) VALUES (?, ?, ?, ?, ?)").run(
    "Nagafen's Lair Run", "Taking down Lord Nagafen. Need tanks and healers!", "Lava Storm",
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), zora.id
  );
  console.log("✅ Seeded admin accounts and sample data");
  console.log("   Admin: Zora / admin123 (Guild Leader)");
  console.log("   Officer: Christopher / admin123");
  console.log("   Member: Drudgee / admin123");
}

app.listen(PORT, () => {
  console.log(`\n🌙 Order of the Eternal Moon — EverQuest Legends Guild`);
  console.log(`   Website: http://localhost:${PORT}`);
  console.log(`   API Key: ${API_KEY}`);
  console.log(`   Parser:  node parser/index.js --auto\n`);
});
