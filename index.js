const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require("discord.js");

const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN) process.exit(1);

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
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9- ]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 90) || "ticket"
  );
}
function parseClaimed(topic) {
  if (!topic) return null;
  const m = topic.match(/\|claimed=(\d{10,30})/);
  return m ? m[1] : null;
}
function setClaimed(topic, claimerId) {
  if (!topic) return null;
  if (topic.includes("|claimed=")) return topic;
  return `${topic}|claimed=${claimerId}`;
}
function isTicketTopicForPanel(topic, panelId) {
  return typeof topic === "string" && topic.startsWith(`ticket:${panelId}:`);
}
function getOpenerIdFromTopic(topic, panelId) {
  const prefix = `ticket:${panelId}:`;
  if (!topic?.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  const opener = rest.split("|")[0];
  return /^\d{10,30}$/.test(opener) ? opener : null;
}
function escapeText(s) {
  return (s ?? "").toString().replace(/\r/g, "");
}

function buildTicketOverwrites({ guild, openerId, claimRoleIds }) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
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
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
      deny: [PermissionsBitField.Flags.SendMessages],
    });
  }
  return overwrites;
}

async function applyClaimPermissions({ channel, guild, openerId, claimRoleIds, claimerId }) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
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
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
      deny: [PermissionsBitField.Flags.SendMessages],
    });
  }
  await channel.permissionOverwrites.set(overwrites);
}

function buildModernPanelEmbed(panel, guild) {
  const claimRoles = (panel.claimRoleIds || []).map((r) => `<@&${r}>`).join(" ") || "None";
  const e = new EmbedBuilder()
    .setTitle(panel.title || "Support Tickets")
    .setDescription(panel.description || "Open a ticket and we’ll help you out.")
    .setColor(panel.color ?? 0x5865f2)
    .addFields(
      { name: "Availability", value: panel.availability || "We’ll respond as soon as possible.", inline: false },
      { name: "Who can handle tickets", value: claimRoles, inline: false }
    )
    .setFooter({ text: `${guild?.name || "Server"} • Ticket System` })
    .setTimestamp();

  if (panel.imageUrl) e.setImage(panel.imageUrl);
  if (panel.thumbnailUrl) e.setThumbnail(panel.thumbnailUrl);
  return e;
}

async function postPanelMessage(channel, panel, guild) {
  const embed = buildModernPanelEmbed(panel, guild);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`open_ticket:${panel.panelId}`)
      .setLabel(panel.buttonLabel || "Open Ticket")
      .setStyle(ButtonStyle.Primary)
  );
  return channel.send({ embeds: [embed], components: [row] });
}

async function fetchAllMessagesText(channel, maxTotal = 2000) {
  let lastId = null;
  const all = [];
  while (all.length < maxTotal) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (!batch.size) break;
    const arr = [...batch.values()];
    all.push(...arr);
    lastId = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = all.map((m) => {
    const ts = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author?.tag || "Unknown"} (${m.author?.id || "?"})`;
    const content = escapeText(m.content || "");
    const attachments = m.attachments?.size
      ? ` [attachments: ${[...m.attachments.values()].map((a) => a.url).join(" ")}]`
      : "";
    const embeds = m.embeds?.length ? ` [embeds: ${m.embeds.length}]` : "";
    return `[${ts}] ${author}: ${content}${attachments}${embeds}`;
  });

  return lines.join("\n");
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
          { name: "claimrole3", description: "Third claim role", type: 9, required: false },
        ],
      },
      {
        name: "claimroles_add",
        description: "Add a claim role to a panel",
        type: 1,
        options: [
          { name: "panelid", description: "Panel ID", type: 3, required: true },
          { name: "role", description: "Role to add", type: 9, required: true },
        ],
      },
      {
        name: "claimroles_remove",
        description: "Remove a claim role from a panel",
        type: 1,
        options: [
          { name: "panelid", description: "Panel ID", type: 3, required: true },
          { name: "role", description: "Role to remove", type: 9, required: true },
        ],
      },
      { name: "list", description: "List all panels", type: 1 },
      {
        name: "delete",
        description: "Delete a panel config",
        type: 1,
        options: [{ name: "panelid", description: "Panel ID", type: 3, required: true }],
      },
    ],
  },
  {
    name: "vouch",
    description: "Post vouch instructions",
    type: 1,
    options: [{ name: "channel", description: "Channel to vouch in", type: 7, required: true }],
  },
];

async function deployCommands() {
  if (!CLIENT_ID || !GUILD_ID) return;
  const url = `https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Command deploy failed:", res.status, txt);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "vouch") {
        const channel = interaction.options.getChannel("channel", true);
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
          return interaction.reply({ content: "Pick a text channel.", ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle("Vouches")
          .setDescription(`Please vouch your indexer in ${channel}.\n\nKeep it honest and specific.`)
          .setColor(0x57f287)
          .setFooter({ text: "Thanks for supporting the team." })
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (interaction.commandName !== "panel") return;

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
        const thumbnailUrl = interaction.options.getString("thumbnail", false);
        const availability = interaction.options.getString("availability", false);
        const buttonLabel = interaction.options.getString("button", false) || "Open Ticket";

        const ticketName = interaction.options.getString("ticketname", true);
        const disclaimer = interaction.options.getString("disclaimer", false);
        const transcriptChannel = interaction.options.getChannel("transcriptchannel", false);

        const r1 = interaction.options.getRole("claimrole1", true);
        const r2 = interaction.options.getRole("claimrole2", false);
        const r3 = interaction.options.getRole("claimrole3", false);
        const claimRoleIds = [r1.id, r2?.id, r3?.id].filter(Boolean);

        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
          return interaction.reply({ content: "Panel channel must be text.", ephemeral: true });
        }
        if (category.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: "Category must be category.", ephemeral: true });
        }
        if (transcriptChannel && ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(transcriptChannel.type)) {
          return interaction.reply({ content: "Transcript channel must be text.", ephemeral: true });
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
          thumbnailUrl: thumbnailUrl || null,
          availability: availability || null,
          buttonLabel,
          claimRoleIds,
          ticketName: ticketName || "ticket",
          disclaimer: disclaimer || null,
          transcriptChannelId: transcriptChannel?.id || null,
          color: 0x5865f2,
        };

        const msg = await postPanelMessage(channel, panel, interaction.guild);
        panel.messageId = msg.id;

        panels[panelId] = panel;
        saveJson(PANELS_FILE, panels);

        return interaction.reply({ content: `✅ Panel created. ID: \`${panelId}\``, ephemeral: true });
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

        return interaction.reply({ content: "✅ Done.", ephemeral: true });
      }

      if (sub === "claimroles_remove") {
        const panelId = interaction.options.getString("panelid", true);
        const role = interaction.options.getRole("role", true);
        const panel = panels[panelId];
        if (!panel) return interaction.reply({ content: "Panel not found.", ephemeral: true });

        panel.claimRoleIds = (panel.claimRoleIds || []).filter((id) => id !== role.id);
        panels[panelId] = panel;
        saveJson(PANELS_FILE, panels);

        return interaction.reply({ content: "✅ Done.", ephemeral: true });
      }

      if (sub === "list") {
        const entries = Object.values(panels);
        if (!entries.length) return interaction.reply({ content: "No panels.", ephemeral: true });
        const lines = entries.map((p) => `• \`${p.panelId}\` — ${p.title} — <#${p.channelId}> — ticketname: ${p.ticketName || "ticket"}`);
        return interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
      }

      if (sub === "delete") {
        const panelId = interaction.options.getString("panelid", true);
        if (!panels[panelId]) return interaction.reply({ content: "Panel not found.", ephemeral: true });
        delete panels[panelId];
        saveJson(PANELS_FILE, panels);
        return interaction.reply({ content: "✅ Deleted.", ephemeral: true });
      }
    }

    if (interaction.isButton()) {
      const panels = loadJson(PANELS_FILE, {});
      const [action, panelId] = interaction.customId.split(":");
      const panel = panels[panelId];

      if (action === "open_ticket") {
        if (!panel) return interaction.reply({ content: "Panel missing.", ephemeral: true });

        const claimRoleIds = Array.isArray(panel.claimRoleIds) ? panel.claimRoleIds : [];
        if (!claimRoleIds.length) return interaction.reply({ content: "No claim roles set.", ephemeral: true });

        const category = interaction.guild.channels.cache.get(panel.categoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: "Category missing.", ephemeral: true });
        }

        const existing = interaction.guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && c.topic && c.topic.startsWith(`ticket:${panelId}:${interaction.user.id}`)
        );
        if (existing) return interaction.reply({ content: `You already have: ${existing}`, ephemeral: true });

        const ticketBase = safeChannelName(panel.ticketName || "ticket");
        const channelName = safeChannelName(`${ticketBase}-${interaction.user.username}`);
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

        const disclaimerText = panel.disclaimer
          ? `\n\n**Disclaimer**\n${panel.disclaimer}`
          : "";

        const embed = new EmbedBuilder()
          .setTitle(panel.title || "Ticket")
          .setDescription(`${panel.description || ""}${disclaimerText}`.slice(0, 4096))
          .setColor(0x57f287)
          .addFields(
            { name: "Opener", value: `${interaction.user}`, inline: true },
            { name: "Status", value: "Unclaimed", inline: true }
          )
          .setFooter({ text: "Press Claim to take this ticket." })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`claim_ticket:${panelId}`).setLabel("Claim").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`close_ticket:${panelId}`).setLabel("Close").setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ ${ticketChannel}`, ephemeral: true });
      }

      if (action === "claim_ticket") {
        if (!panel) return interaction.reply({ content: "Panel missing.", ephemeral: true });

        const topic = interaction.channel?.topic || "";
        if (!isTicketTopicForPanel(topic, panelId)) return interaction.reply({ content: "Not a ticket.", ephemeral: true });

        const claimRoleIds = Array.isArray(panel.claimRoleIds) ? panel.claimRoleIds : [];
        const member = interaction.member;
        const hasClaimRole = claimRoleIds.some((rid) => member.roles.cache.has(rid));
        if (!hasClaimRole) return interaction.reply({ content: "No permission.", ephemeral: true });

        const already = parseClaimed(topic);
        if (already) return interaction.reply({ content: `Already claimed by <@${already}>.`, ephemeral: true });

        const openerId = getOpenerIdFromTopic(topic, panelId);
        if (!openerId) return interaction.reply({ content: "Invalid ticket.", ephemeral: true });

        const newTopic = setClaimed(topic, interaction.user.id);
        await interaction.channel.setTopic(newTopic).catch(() => {});
        await applyClaimPermissions({
          channel: interaction.channel,
          guild: interaction.guild,
          openerId,
          claimRoleIds,
          claimerId: interaction.user.id,
        });

        const updatedRows = interaction.message.components.map((row) => {
          const r = ActionRowBuilder.from(row);
          r.components = r.components.map((btn) => {
            const b = ButtonBuilder.from(btn);
            if (b.data.custom_id?.startsWith("claim_ticket:")) b.setDisabled(true);
            return b;
          });
          return r;
        });

        return interaction.update({ content: `✅ Claimed by ${interaction.user}`, components: updatedRows });
      }

      if (action === "close_ticket") {
        const topic = interaction.channel?.topic || "";
        if (!panel || !isTicketTopicForPanel(topic, panelId)) {
          return interaction.reply({ content: "Not a ticket.", ephemeral: true });
        }

        const openerId = getOpenerIdFromTopic(topic, panelId);
        const claimerId = parseClaimed(topic);
        const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
        const isOpener = openerId && interaction.user.id === openerId;
        const isClaimer = claimerId && interaction.user.id === claimerId;

        if (!isAdmin && !isOpener && !isClaimer) {
          return interaction.reply({ content: "No permission.", ephemeral: true });
        }

        await interaction.reply({ content: "Closing...", ephemeral: true });

        const transcriptChannelId = panel.transcriptChannelId || null;
        if (transcriptChannelId) {
          const tChannel = interaction.guild.channels.cache.get(transcriptChannelId);
          if (tChannel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(tChannel.type)) {
            try {
              const text = await fetchAllMessagesText(interaction.channel, 2000);
              const header =
                `Panel: ${panel.title || panelId}\n` +
                `Ticket Channel: #${interaction.channel.name} (${interaction.channel.id})\n` +
                `Opened By: ${openerId ? `${openerId}` : "unknown"}\n` +
                `Claimed By: ${claimerId ? `${claimerId}` : "unclaimed"}\n` +
                `Closed By: ${interaction.user.id}\n` +
                `Closed At: ${new Date().toISOString()}\n\n`;
              const file = new AttachmentBuilder(Buffer.from(header + text, "utf8"), {
                name: `transcript-${interaction.channel.id}.txt`,
              });

              const embed = new EmbedBuilder()
                .setTitle("Ticket Transcript")
                .setColor(0xed4245)
                .addFields(
                  { name: "Panel", value: panel.title || panelId, inline: true },
                  { name: "Ticket", value: `#${interaction.channel.name}`, inline: true }
                )
                .setTimestamp();

              await tChannel.send({
                embeds: [embed],
                files: [file],
              });
            } catch {}
          }
        }

        setTimeout(() => interaction.channel?.delete().catch(() => {}), 3000);
      }
    }
  } catch {
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "Error.", ephemeral: true });
      } catch {}
    }
  }
});

client.once("ready", () => {});
(async () => {
  ensureFile(PANELS_FILE, {});
  await deployCommands();
  await client.login(TOKEN);
})();
