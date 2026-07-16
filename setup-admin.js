const db = require("./database");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("🌙 Order of the Eternal Moon — Admin Setup\n");

rl.question("Enter your username to promote to Guild Leader: ", (username) => {
  const user = db.prepare("SELECT id, username, character_name, role FROM users WHERE username = ?").get(username);
  if (!user) {
    console.log(`❌ User '${username}' not found.`);
    console.log("   Available users:");
    const users = db.prepare("SELECT username, character_name, role FROM users").all();
    users.forEach(u => console.log(`   - ${u.username} (${u.character_name}) [${u.role}]`));
    rl.close();
    process.exit(1);
  }
  db.prepare("UPDATE users SET role = 'guildleader' WHERE id = ?").run(user.id);
  console.log(`\n✅ ${user.character_name} (${user.username}) is now Guild Leader!`);
  console.log("   Log out and log back in to access the Admin panel.");
  rl.close();
});
