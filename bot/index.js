const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require("discord.js");
const path = require("path");

// Point to the website's database
const db = require(path.join(__dirname, "..", "database"));

// Ensure discord_id column exists
try {
  db.exec("ALTER TABLE users ADD COLUMN discord_id TEXT UNIQUE");
} catch (e) { /* already exists */ }

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID in environment");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your guild website account")
    .addStringOption(o => o.setName("username").setDescription("Your website username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("dkp")
    .setDescription("Check your DKP balance"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show DKP leaderboard"),

  new SlashCommandBuilder()
    .setName("events")
    .setDescription("List upcoming events"),

  new SlashCommandBuilder()
    .setName("checkin")
    .setDescription("Check in to an event")
    .addIntegerOption(o => o.setName("event_id").setDescription("Event ID from /events").setRequired(true)),

  new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Show guild roster"),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
      console.log("Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
      console.log("Registered global commands");
    }
  } catch (e) { console.error("Failed to register commands:", e); }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`🌙 OEM Bot online as ${client.user.tag}`);
  client.user.setActivity("Order of the Eternal Moon", { type: 3 });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "link": return handleLink(interaction);
      case "dkp": return handleDkp(interaction);
      case "leaderboard": return handleLeaderboard(interaction);
      case "events": return handleEvents(interaction);
      case "checkin": return handleCheckin(interaction);
      case "roster": return handleRoster(interaction);
    }
  } catch (e) {
    console.error(e);
    await interaction.reply({ content: "❌ An error occurred.", ephemeral: true });
  }
});

async function handleLink(interaction) {
  const username = interaction.options.getString("username");
  const user = db.prepare("SELECT id, username, character_name FROM users WHERE username = ?").get(username);
  if (!user) return interaction.reply({ content: `❌ Username "${username}" not found on the website.`, ephemeral: true });

  const existing = db.prepare("SELECT id FROM users WHERE discord_id = ?").get(interaction.user.id);
  if (existing) return interaction.reply({ content: "❌ Your Discord is already linked to an account.", ephemeral: true });

  db.prepare("UPDATE users SET discord_id = ? WHERE id = ?").run(interaction.user.id, user.id);

  const embed = new EmbedBuilder()
    .setColor(0xc8a0e0)
    .setTitle("✅ Discord Linked")
    .setDescription(`You're now linked as **${user.character_name}**`)
    .setFooter({ text: "Order of the Eternal Moon" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDkp(interaction) {
  const member = db.prepare("SELECT id, character_name, class, race FROM users WHERE discord_id = ?").get(interaction.user.id);
  if (!member) return interaction.reply({ content: "❌ Link your account first with `/link`", ephemeral: true });

  const total = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM dkp WHERE user_id = ?").get(member.id).total;
  const recent = db.prepare("SELECT points, reason, created_at FROM dkp WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(member.id);

  const embed = new EmbedBuilder()
    .setColor(0xd4a843)
    .setTitle(`💰 ${member.character_name}'s DKP`)
    .setDescription(`**Total: ${Math.round(total)} DKP**`)
    .addFields(
      { name: "Class", value: member.class || "—", inline: true },
      { name: "Race", value: member.race || "—", inline: true }
    );

  if (recent.length > 0) {
    const lines = recent.map(r => `+${Math.round(r.points)} — ${r.reason} (${new Date(r.created_at).toLocaleDateString()})`).join("\n");
    embed.addFields({ name: "Recent", value: lines });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
  const top = db.prepare(`
    SELECT u.character_name, u.class, COALESCE(SUM(d.points), 0) as total
    FROM users u LEFT JOIN dkp d ON u.id = d.user_id
    WHERE u.role != 'inactive'
    GROUP BY u.id ORDER BY total DESC LIMIT 10
  `).all();

  if (top.length === 0) return interaction.reply("No DKP data yet.");

  const lines = top.map((m, i) => `${i + 1}. **${m.character_name}** (${m.class || "?"}) — ${Math.round(m.total)} DKP`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xd4a843)
    .setTitle("🏆 DKP Leaderboard")
    .setDescription(lines);

  await interaction.reply({ embeds: [embed] });
}

async function handleEvents(interaction) {
  const events = db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM event_attendance WHERE event_id = e.id) as attendees
    FROM events e WHERE e.event_date >= datetime('now')
    ORDER BY e.event_date ASC LIMIT 10
  `).all();

  if (events.length === 0) return interaction.reply("No upcoming events.");

  const lines = events.map(e =>
    `**#${e.id}** ${e.title} — ${e.location || "TBD"}\n📅 ${new Date(e.event_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}\n👥 ${e.attendees}${e.max_attendees ? `/${e.max_attendees}` : ""} signed up`
  ).join("\n\n");

  const embed = new EmbedBuilder()
    .setColor(0x4488cc)
    .setTitle("📅 Upcoming Events")
    .setDescription(lines);

  await interaction.reply({ embeds: [embed] });
}

async function handleCheckin(interaction) {
  const member = db.prepare("SELECT id, character_name FROM users WHERE discord_id = ?").get(interaction.user.id);
  if (!member) return interaction.reply({ content: "❌ Link your account first with `/link`", ephemeral: true });

  const eventId = interaction.options.getInteger("event_id");
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  if (!event) return interaction.reply({ content: "❌ Event not found.", ephemeral: true });

  const existing = db.prepare("SELECT id FROM event_attendance WHERE event_id = ? AND user_id = ?").get(eventId, member.id);
  if (existing) return interaction.reply({ content: "❌ Already checked in to this event.", ephemeral: true });

  db.prepare("INSERT INTO event_attendance (event_id, user_id, checked_in) VALUES (?, ?, 1)").run(eventId, member.id);
  db.prepare("INSERT INTO dkp (user_id, points, reason, awarded_by) VALUES (?, ?, ?, NULL)").run(member.id, 5, `Raid: ${event.title}`);

  const embed = new EmbedBuilder()
    .setColor(0x44bb77)
    .setTitle("✅ Checked In!")
    .setDescription(`**${member.character_name}** checked in to **${event.title}**\n+5 DKP awarded`)
    .setFooter({ text: "Order of the Eternal Moon" });

  await interaction.reply({ embeds: [embed] });
}

async function handleRoster(interaction) {
  const members = db.prepare("SELECT character_name, race, class, level, role FROM users WHERE role != 'inactive' ORDER BY role, character_name").all();

  if (members.length === 0) return interaction.reply("No members found.");

  const officers = members.filter(m => m.role !== "member").map(m => `**${m.character_name}** — ${m.class || "?"} [${m.role}]`).join("\n") || "None";
  const ranks = members.filter(m => m.role === "member").map(m => `${m.character_name} (${m.class || "?"})`).join("\n") || "None";

  const embed = new EmbedBuilder()
    .setColor(0xc8a0e0)
    .setTitle(`👥 Guild Roster (${members.length})`)
    .addFields(
      { name: "⚜️ Officers", value: officers, inline: true },
      { name: "Members", value: ranks.length > 1024 ? ranks.slice(0, 1000) + "..." : ranks, inline: true }
    );

  await interaction.reply({ embeds: [embed] });
}

client.login(TOKEN);
