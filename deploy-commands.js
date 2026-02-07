const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing TOKEN, CLIENT_ID, or GUILD_ID");
  process.exit(1);
}

const commands = [
  {
    name: "panel",
    description: "Ticket panels",
    type: 1,
    options: [
      {
        name: "create",
        description: "Create a ticket panel",
        type: 1,
        options: [
          { name: "channel", description: "Channel for panel", type: 7, required: true },
          { name: "category", description: "Category for tickets", type: 7, required: true },
          { name: "title", description: "Panel title", type: 3, required: true },
          { name: "description", description: "Panel description", type: 3, required: true },
          { name: "claimrole1", description: "First claim role", type: 9, required: true },
          { name: "ticketname", description: "Ticket name (e.g. lava, candy)", type: 3, required: true },
          { name: "disclaimer", description: "Disclaimer shown inside ticket", type: 3, required: false },
          { name: "transcriptchannel", description: "Channel to send transcripts to", type: 7, required: false },
          { name: "image", description: "Panel image (banner)", type: 3, required: false },
          { name: "thumbnail", description: "Panel thumbnail URL", type: 3, required: false },
          { name: "availability", description: "Availability text", type: 3, required: false },
          { name: "button", description: "Button text", type: 3, required: false },
          { name: "claimrole2", description: "Second claim role", type: 9, required: false },
          { name: "claimrole3", description: "Third claim role", type: 9, required: false }
        ]
      },
      {
        name: "claimroles_add",
        description: "Add a claim role to a panel",
        type: 1,
        options: [
          { name: "panelid", description: "Panel ID", type: 3, required: true },
          { name: "role", description: "Role to add", type: 9, required: true }
        ]
      },
      {
        name: "claimroles_remove",
        description: "Remove a claim role from a panel",
        type: 1,
        options: [
          { name: "panelid", description: "Panel ID", type: 3, required: true },
          { name: "role", description: "Role to remove", type: 9, required: true }
        ]
      },
      { name: "list", description: "List all panels", type: 1 },
      {
        name: "delete",
        description: "Delete a panel config",
        type: 1,
        options: [{ name: "panelid", description: "Panel ID", type: 3, required: true }]
      }
    ]
  },
  {
    name: "vouch",
    description: "Post vouch instructions",
    type: 1,
    options: [{ name: "channel", description: "Channel to vouch in", type: 7, required: true }]
  }
];

(async () => {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(commands)
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Failed to deploy commands:", res.status, text);
      process.exit(1);
    }

    console.log("Commands deployed.");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
