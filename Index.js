const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

// ========== Config / Storage ==========
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env vars. Required: TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

const PANELS_FILE = path.join(__dirname, "panels.json");

function ensureFile(filePath, defaultJson) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(defaultJson, null, 2));
}

function loadJson(filePath, fallback) {
  ensureFile(filePath, fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function safeChannelName(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9- ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 90) || "ticket";
}

function parseClaimed(topic) {
  // topic format: ticket:<panelId>:<openerId>|claimed=<claimerId>
  if (!topic) return null;
  const m = topic.match(/\|claimed=(\d{10,30})/);
  return m ? m[1] : null;
}

function setClaimed(topic, claimerId) {
  if (!topic) return null;
  if (topic.includes("|claimed=")) return topic; // already claimed
  return `${topic}|claimed=${claimerId}`;
}

function isTicketTopicForPanel(topic, panelId) {
  return typeof topic === "string" && topic.startsWith(`ticket:${panelId}:`);
}

function getOpenerIdFromTopic(topic, panelId) {
  // ticket:<panelId>:<openerId>...
  const prefix = `ticket:${panelId}:`;
  if (!topic?.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  const opener = rest.split("|")[0];
  return /^\d{10,30}$/.test(opener) ? opener : null;
}

// ========== Discord Client ==========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

// ========== Slash Commands ==========
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
          opt
            .setName("image")
            .setDescription("Optional image URL (acts like a background banner)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("button")
            .setDescription('Button label (default "Open Ticket")')
            .setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole1").setDescription("Role allowed to see/claim tickets").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole2").setDescription("Optional extra claim role").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("claimrole3").setDescription("Optional extra claim role").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("claimroles_add")
        .setDescription("Add a claim role to a panel")
        .addStringOption((opt) => opt.setName("panelid").setDescription("Panel ID").setRequired(true))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to add").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("claimroles_remove")
        .setDescription("Remove a claim role from a panel")
        .addStringOption((opt) => opt.setName("panelid").setDescription("Panel ID").setRequired(true))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to remove").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List all panels")
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a panel config (does not delete the posted message)")
        .addStringOption((opt) => opt.setName("panelid").setDescription("Panel ID").setRequired(true))
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

// ========== Panel Posting ==========
async function postPanelMessage(channel, panel) {
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setColor(panel.color ?? 0x2b2d31);

  if (panel.imageUrl) embed.setImage(panel.imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`open_ticket:${panel.panelId}`)
      .setLabel(panel.buttonLabel || "Open Ticket")
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  return msg;
}

// ========== Permissions helpers ==========
function buildTicketOverwrites({ guild, openerId, claimRoleIds }) {
  // Only opener + claim roles can VIEW.
  // Opener can SEND. Claim roles can VIEW but cannot SEND until claim.
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: openerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
  ];

  for (const roleId of claimRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
      deny: [
        PermissionsBitField.Flags.SendMessages, // until claimed
      ],
    });
  }

  return overwrites;
}

async function applyClaimPermissions({ channel, guild, openerId, claimRoleIds, claimerId }) {
  // After claim:
  // - opener can send
  // - claimer can send
  // - claim roles can still view but cannot send
  // - @everyone denied view
  // We update overwrites explicitly.
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: openerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
    {
      id: claimerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
  ];

  for (const roleId of claimRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
      deny: [
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }

  await channel.permissionOverwrites.set(overwrites);
}

// ========== Interactions ==========
client.on("interactionCreate", async (interaction) => {
  try {
    // ------- Slash commands -------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "panel") return;

      // basic admin gate
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "Admin only.", ephemeral: true });
      }

      const panels = loadJson(PANELS_FILE, {});
      const sub = interaction.options.getSubcommand();

      if (sub === "create") {
        const channel = interaction.options.getChannel("channel", true);
        const category = interaction.options.getChannel("category", true);
        const title = interaction.options.getString("title", true);
        const description = interaction.options.getString("description", true);
        const imageUrl = interaction.options.getString("image", false);
        const buttonLabel = interaction.options.getString("button", false) || "Open Ticket";

        const r1 = interaction.options.getRole("claimrole1", true);
        const r2 = interaction.options.getRole("claimrole2", false);
        const r3 = interaction.options.getRole("claimrole3", false);

        const claimRoleIds = [r1.id, r2?.id, r3?.id].filter(Boolean);

        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
          return interaction.reply({ content: "Panel channel must be a text channel.", ephemeral: true });
        }

        const panelId = makeId();
        const panel = {
          panelId,
          guildId: interaction.guildId,
          channelId: channel.id,
          categoryId: category.id,
          title,
          description,
          imageUrl: imageUrl || null,
          buttonLabel,
          claimRoleIds,
          color: 0x2b2d31,
        };

        const msg = await postPanelMessage(channel, panel);
        panel.messageId = msg.id;

        panels[panelId] = panel;
        saveJson(PANELS_FILE, panels);

        return interaction.reply({
          content: `✅ Panel created.\nPanel ID: \`${panelId}\`\nPosted in: ${channel}`,
          ephemeral: true,
        });
      }

      if (sub === "claimroles_add") {
        const panelId = interaction.options.getString("panelid", true);
        const role = interaction.options.getRole("role", true);

        const panel = panels[panelId];
        if (!panel) return interaction.reply({ content: "Panel not found.", ephemeral: true });

        panel.claimRoleIds = Array.isArray(panel.claimRoleIds) ? panel.claimRoleIds : [];
        if (!panel.claimRoleIds.includes(role.id)) panel.claimRoleIds.push(role.id);

        panels[panelId] = panel;
        saveJson(PANELS_FILE, panels);

        return interaction.reply({ content: `✅ Added ${role} to panel \`${panelId}\` claim roles.`, ephemeral: true });
      }

      if (sub === "claimroles_remove") {
        const panelId = interaction.options.getString("panelid", true);
        const role = interaction.options.getRole("role", true);

        const panel = panels[panelId];
        if (!panel) return interaction.reply({ content: "Panel not found.", ephemeral: true });

        panel.claimRoleIds = (panel.claimRoleIds || []).filter((id) => id !== role.id);

        panels[panelId] = panel;
        saveJson(PANELS_FILE, panels);

        return interaction.reply({ content: `✅ Removed ${role} from panel \`${panelId}\` claim roles.`, ephemeral: true });
      }

      if (sub === "list") {
        const entries = Object.values(panels);
        if (!entries.length) return interaction.reply({ content: "No panels yet.", ephemeral: true });

        const lines = entries.map((p) => {
          return `• \`${p.panelId}\` — **${p.title}** (channel <#${p.channelId}>, category <#${p.categoryId}>, claim roles: ${p.claimRoleIds?.map((x) => `<@&${x}>`).join(" ") || "none"})`;
        });

        return interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
      }

      if (sub === "delete") {
        const panelId = interaction.options.getString("panelid", true);
        if (!panels[panelId]) return interaction.reply({ content: "Panel not found.", ephemeral: true });

        delete panels[panelId];
        saveJson(PANELS_FILE, panels);
        return interaction.reply({ content: `✅ Deleted panel config \`${panelId}\`.`, ephemeral: true });
      }
    }

    // ------- Button interactions -------
    if (interaction.isButton()) {
      const panels = loadJson(PANELS_FILE, {});
      const [action, panelId] = interaction.customId.split(":");
      const panel = panels[panelId];

      // ---------- Open Ticket ----------
      if (action === "open_ticket") {
        if (!panel) return interaction.reply({ content: "This panel no longer exists.", ephemeral: true });

        // Optional: prevent duplicates per panel+user (checks topic)
        const existing = interaction.guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            c.topic &&
            c.topic.startsWith(`ticket:${panelId}:${interaction.user.id}`)
        );
        if (existing) {
          return interaction.reply({ content: `You already have a ticket: ${existing}`, ephemeral: true });
        }

        const claimRoleIds = Array.isArray(panel.claimRoleIds) ? panel.claimRoleIds : [];
        if (!claimRoleIds.length) {
          return interaction.reply({ content: "Panel misconfigured: no claim roles set.", ephemeral: true });
        }

        const category = interaction.guild.channels.cache.get(panel.categoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: "Panel misconfigured: category missing.", ephemeral: true });
        }

        const channelName = safeChannelName(`ticket-${interaction.user.username}`);
        const topic = `ticket:${panelId}:${interaction.user.id}`;

        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
          topic,
          permissionOverwrites: buildTicketOverwrites({
            guild: interaction.guild,
            openerId: interaction.user.id,
            claimRoleIds,
          }),
        });

        const info = new EmbedBuilder()
          .setTitle(`Ticket: ${panel.title}`)
          .setDescription(
            `**What this is:** ${panel.description}\n\n` +
              `✅ **Opener:** ${interaction.user}\n` +
              `🧑‍💼 **Staff:** Only roles ${claimRoleIds.map((r) => `<@&${r}>`).join(" ")} can see/claim this ticket.\n\n` +
              `Press **Claim** to take ownership. Once claimed, only the opener + claimer can talk.`
          )
          .setColor(0x57f287);

        const controls = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`claim_ticket:${panelId}`)
            .setLabel("Claim")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`close_ticket:${panelId}`)
            .setLabel("Close")
            .setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({ embeds: [info], components: [controls] });

        return interaction.reply({ content: `✅ Ticket created: ${ticketChannel}`, ephemeral: true });
      }

      // ---------- Claim Ticket ----------
      if (action === "claim_ticket") {
        if (!panel) return interaction.reply({ content: "Panel config missing.", ephemeral: true });

        const topic = interaction.channel?.topic || "";
        if (!isTicketTopicForPanel(topic, panelId)) {
          return interaction.reply({ content: "This button only works inside that ticket.", ephemeral: true });
        }

        // Role gate: only claimRoleIds can claim (and see ticket already due to perms)
        const claimRoleIds = Array.isArray(panel.claimRoleIds) ? panel.claimRoleIds : [];
        if (!claimRoleIds.length) {
          return interaction.reply({ content: "No claim roles configured for this panel.", ephemeral: true });
        }

        const member = interaction.member; // GuildMember
        const hasClaimRole = claimRoleIds.some((rid) => member.roles.cache.has(rid));
        if (!hasClaimRole) {
          return interaction.reply({ content: "You don't have permission to claim this ticket.", ephemeral: true });
        }

        const already = parseClaimed(topic);
        if (already) {
          return interaction.reply({ content: `Already claimed by <@${already}>.`, ephemeral: true });
        }

        const openerId = getOpenerIdFromTopic(topic, panelId);
        if (!openerId) return interaction.reply({ content: "Ticket topic is invalid.", ephemeral: true });

        // Mark claimed in topic
        const newTopic = setClaimed(topic, interaction.user.id);
        await interaction.channel.setTopic(newTopic).catch(() => {});

        // Permission change: only opener + claimer can SEND
        await applyClaimPermissions({
          channel: interaction.channel,
          guild: interaction.guild,
          openerId,
          claimRoleIds,
          claimerId: interaction.user.id,
        });

        // Disable claim button on the message you clicked (if possible)
        const updatedRows = interaction.message.components.map((row) => {
          const r = ActionRowBuilder.from(row);
          r.components = r.components.map((btn) => {
            const b = ButtonBuilder.from(btn);
            if (b.data.custom_id?.startsWith("claim_ticket:")) b.setDisabled(true);
            return b;
          });
          return r;
        });

        return interaction.update({
          content: `✅ Claimed by ${interaction.user}. Only the opener + claimer can speak now.`,
          components: updatedRows,
        });
      }

      // ---------- Close Ticket ----------
      if (action === "close_ticket") {
        const topic = interaction.channel?.topic || "";
        if (!panel || !isTicketTopicForPanel(topic, panelId)) {
          return interaction.reply({ content: "This close button only works inside that ticket.", ephemeral: true });
        }

        const openerId = getOpenerIdFromTopic(topic, panelId);
        const claimerId = parseClaimed(topic);

        const isOpener = openerId && interaction.user.id === openerId;
        const isClaimer = claimerId && interaction.user.id === claimerId;

        // Allow opener or claimer to close. (Admins can always close.)
        const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
        if (!isOpener && !isClaimer && !isAdmin) {
          return interaction.reply({ content: "Only the opener or claimer can close this ticket.", ephemeral: true });
        }

        await interaction.reply({ content: "Closing ticket in 5 seconds...", ephemeral: true });
        setTimeout(() => interaction.channel?.delete().catch(() => {}), 5000);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      } catch {}
    }
  }
});

// ========== Boot ==========
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  ensureFile(PANELS_FILE, {});
  client.login(TOKEN);
})();
