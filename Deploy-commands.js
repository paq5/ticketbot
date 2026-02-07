const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing TOKEN, CLIENT_ID, or GUILD_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Create/manage ticket panels")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a new ticket panel in a channel")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Where to post the panel").setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Category where tickets will be created")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("title").setDescription("Panel title").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("Panel description").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("image").setDescription("Optional image URL").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("button").setDescription("Button label").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole1").setDescription("Claim role").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole2").setDescription("Claim role").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole3").setDescription("Claim role").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("claimroles_add")
        .setDescription("Add a claim role to a panel")
        .addStringOption((opt) =>
          opt.setName("panelid").setDescription("Panel ID").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to add").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("claimroles_remove")
        .setDescription("Remove a claim role from a panel")
        .addStringOption((opt) =>
          opt.setName("panelid").setDescription("Panel ID").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all panels")
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a panel config")
        .addStringOption((opt) =>
          opt.setName("panelid").setDescription("Panel ID").setRequired(true)
        )
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("Deploying slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("Slash commands deployed successfully.");
  } catch (error) {
    console.error(error);
  }
})();
