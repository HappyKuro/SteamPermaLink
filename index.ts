import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import SteamAPI from 'type-steamapi';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Message,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';

console.log('Starting process...');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional (recommended for testing)

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN in environment.');
if (!STEAM_API_KEY) throw new Error('Missing STEAM_API_KEY in environment.');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID in environment.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const api = new SteamAPI({
  apiKey: STEAM_API_KEY,
  cache: { enabled: true, expiresIn: 10 * 60_000 },
});

// ---------- Config ----------
const USER_COOLDOWN_MS = 8_000;
const MESSAGE_REPLY_TTL_MS = 60 * 60_000;

// ---------- Regex (captures full matches) ----------
const STEAM_VANITY_ID_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;

const STEAM_USER_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/user\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;

const STEAM_PROFILE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{15,25})(?=$|[\s)\]}>"'.,!?])/gi;

// ---------- Persistence: per-guild on/off ----------
type GuildSettings = Record<string, { enabled: boolean }>;
const SETTINGS_PATH = path.join(process.cwd(), 'steampermalink-settings.json');

function loadSettings(): GuildSettings {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as GuildSettings;
  } catch {
    return {};
  }
}
function saveSettings(settings: GuildSettings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // ignore write errors
  }
}
const guildSettings: GuildSettings = loadSettings();
function isEnabled(guildId: string): boolean {
  return guildSettings[guildId]?.enabled ?? true; // default ON
}
function setEnabled(guildId: string, enabled: boolean) {
  guildSettings[guildId] = { enabled };
  saveSettings(guildSettings);
}

// ---------- Anti-spam state ----------
const lastReplyAtByUser = new Map<string, number>();
const repliedMessageIds = new Map<string, number>(); // messageId -> timestamp

// ---------- Slash command registration ----------
const commands = [
  new SlashCommandBuilder()
    .setName('steampermalink')
    .setDescription('Enable or disable Steam permalink detection in this server')
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

  if (GUILD_ID) {
    // Faster propagation for testing
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), {
      body: commands,
    });
    console.log(`Registered guild commands in ${GUILD_ID}`);
  } else {
    // Global commands can take time to appear
    await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
    console.log('Registered global commands');
  }
}

// ---------- Event handlers ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}!`);
  try {
    await registerCommands();
  } catch (err) {
    console.warn('Failed to register commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'steampermalink') return;
  await handleSteamPermaLinkCommand(interaction);
});

async function handleSteamPermaLinkCommand(interaction: ChatInputCommandInteraction) {
  // Only makes sense in a guild
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true,
    });
    return;
  }

  // Optional: restrict to ManageGuild admins (uncomment if you want)
  // if (!interaction.memberPermissions?.has('ManageGuild')) {
  //   await interaction.reply({ content: 'You need Manage Server to do that.', ephemeral: true });
  //   return;
  // }

  const state = interaction.options.getString('state', true);
  const enabled = state === 'on';

  setEnabled(interaction.guildId, enabled);

  await interaction.reply({
    content: `SteamPermaLink is now **${enabled ? 'ON' : 'OFF'}** in this server.`,
    ephemeral: true,
  });
}

// Respond to new messages
client.on(Events.MessageCreate, (message) => {
  void handleMessage(message, false);
});

// Respond to edits
client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
  const message = newMsg as Message;
  void handleMessage(message, true);
});

async function handleMessage(message: Message, fromEdit: boolean) {
  try {
    if (!message.content) return;
    if (message.author?.bot) return;
    if (!message.guildId) return;

    // Respect per-guild toggle
    if (!isEnabled(message.guildId)) return;

    cleanupRepliedMessages();
    if (repliedMessageIds.has(message.id)) return;

    // Cooldown per user
    const now = Date.now();
    const last = lastReplyAtByUser.get(message.author.id) ?? 0;
    if (now - last < USER_COOLDOWN_MS) return;

    // Ignore code blocks for fewer false positives
    const content = stripCodeBlocks(message.content);

    const vanityIdUrls = extractFullMatches(content, STEAM_VANITY_ID_REGEX);
    const userUrls = extractFullMatches(content, STEAM_USER_REGEX);
    const profileUrls = extractFullMatches(content, STEAM_PROFILE_REGEX);

    if (vanityIdUrls.length === 0 && userUrls.length === 0 && profileUrls.length === 0) return;

    const permalinks: string[] = [];

    // Normalize /profiles/<id64>
    for (const fullProfileUrl of profileUrls) {
      const id64 = extractFirstGroup(fullProfileUrl, STEAM_PROFILE_REGEX);
      if (id64) permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
    }

    // Resolve /id/<name> and /user/<name>
    for (const fullVanityUrl of [...vanityIdUrls, ...userUrls]) {
      try {
        const normalized = fullVanityUrl.startsWith('http')
          ? fullVanityUrl
          : `https://${fullVanityUrl}`;

        const id64 = await api.resolve(normalized);
        permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
      } catch {
        // silent
      }
    }

    const uniquePermalinks = uniqueStable(permalinks);
    if (uniquePermalinks.length === 0) return;

    const embed = new EmbedBuilder()
      .setTitle(uniquePermalinks.length === 1 ? 'Steam permalink' : 'Steam permalinks')
      .setDescription(uniquePermalinks.join('\n'))
      .setFooter({ text: fromEdit ? 'Detected after message edit.' : 'Detected in your message.' });

    await message.reply({
      embeds: [embed],
      allowedMentions: { parse: [] }, // no pings
    });

    repliedMessageIds.set(message.id, now);
    lastReplyAtByUser.set(message.author.id, now);
  } catch {
    // keep quiet
  }
}

// ---------- Helpers ----------
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

function extractFullMatches(text: string, regex: RegExp): string[] {
  const matches: string[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) matches.push(m[0]);
  return uniqueStable(matches);
}

function extractFirstGroup(text: string, regex: RegExp): string | null {
  regex.lastIndex = 0;
  const m = regex.exec(text);
  return m?.[1] ?? null;
}

function uniqueStable<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function cleanupRepliedMessages() {
  const now = Date.now();
  for (const [msgId, ts] of repliedMessageIds) {
    if (now - ts > MESSAGE_REPLY_TTL_MS) repliedMessageIds.delete(msgId);
  }
}

// ---------- Login ----------
client.login(DISCORD_TOKEN);

// Keep-alive server (Render/Replit)
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end("I'm alive");
  })
  .listen(process.env.PORT ? Number(process.env.PORT) : 8080);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
});
