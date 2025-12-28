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

// --------- ENV ---------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional (recommended for development)
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN in environment.');
if (!STEAM_API_KEY) throw new Error('Missing STEAM_API_KEY in environment.');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID in environment.');

// --------- CLIENT ---------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// --------- STEAM API ---------
const api = new SteamAPI({
  apiKey: STEAM_API_KEY,
  cache: { enabled: true, expiresIn: 10 * 60_000 },
});

// --------- CONFIG ---------
const USER_COOLDOWN_MS = 8_000;
const MESSAGE_REPLY_TTL_MS = 60 * 60_000;

// Import limits (avoid abuse / long runs)
const MAX_IMPORT_ITEMS = 300;
const MAX_IMPORT_BYTES = 300_000; // attachment download cap

// --------- REGEX ---------
const STEAM_VANITY_ID_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;

const STEAM_USER_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/user\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;

const STEAM_PROFILE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{15,25})(?=$|[\s)\]}>"'.,!?])/gi;

// --------- ANTI-SPAM STATE ---------
const lastReplyAtByUser = new Map<string, number>();
const repliedMessageIds = new Map<string, number>(); // messageId -> timestamp

function cleanupRepliedMessages() {
  const now = Date.now();
  for (const [msgId, ts] of repliedMessageIds) {
    if (now - ts > MESSAGE_REPLY_TTL_MS) repliedMessageIds.delete(msgId);
  }
}

// --------- SETTINGS PERSISTENCE (per-guild enable/disable) ---------
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
    // ignore
  }
}
const guildSettings: GuildSettings = loadSettings();

function isPermalinkEnabled(guildId: string): boolean {
  return guildSettings[guildId]?.enabled ?? true; // default ON
}
function setPermalinkEnabled(guildId: string, enabled: boolean) {
  guildSettings[guildId] = { enabled };
  saveSettings(guildSettings);
}

// --------- PROFILES PERSISTENCE (per-guild stored profiles) ---------
type StoredProfile = { steamid64: string; note?: string; addedAt: number };
type GuildProfiles = Record<string, { profiles: StoredProfile[] }>;
const PROFILES_PATH = path.join(process.cwd(), 'steamprofiles.json');

function loadProfiles(): GuildProfiles {
  try {
    if (!fs.existsSync(PROFILES_PATH)) return {};
    return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8')) as GuildProfiles;
  } catch {
    return {};
  }
}
function saveProfiles(data: GuildProfiles) {
  try {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}
const guildProfiles: GuildProfiles = loadProfiles();

function getGuildProfiles(guildId: string): StoredProfile[] {
  return guildProfiles[guildId]?.profiles ?? [];
}
function setGuildProfiles(guildId: string, profiles: StoredProfile[]) {
  guildProfiles[guildId] = { profiles };
  saveProfiles(guildProfiles);
}
function upsertProfile(guildId: string, steamid64: string, note?: string) {
  const profiles = getGuildProfiles(guildId);
  const idx = profiles.findIndex((p) => p.steamid64 === steamid64);

  const entry: StoredProfile = {
    steamid64,
    note: note?.trim() ? note.trim() : undefined,
    addedAt: Date.now(),
  };

  if (idx >= 0) profiles[idx] = { ...profiles[idx], ...entry };
  else profiles.push(entry);

  setGuildProfiles(guildId, profiles);
}
function removeProfile(guildId: string, steamid64: string): boolean {
  const profiles = getGuildProfiles(guildId);
  const next = profiles.filter((p) => p.steamid64 !== steamid64);
  if (next.length === profiles.length) return false;
  setGuildProfiles(guildId, next);
  return true;
}
function clearProfiles(guildId: string) {
  setGuildProfiles(guildId, []);
}

// --------- GENERAL HELPERS ---------
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
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

function normalizeInput(input: string): string {
  // Discord sometimes wraps links in <...>
  return input.trim().replace(/^<|>$/g, '');
}

function isSteamId64(s: string): boolean {
  return /^\d{15,25}$/.test(s.trim());
}

function ensureUrl(s: string): string {
  const v = s.trim();
  return v.startsWith('http') ? v : `https://${v}`;
}

function extractFirstGroup(text: string, regex: RegExp): string | null {
  regex.lastIndex = 0;
  const m = regex.exec(text);
  return m?.[1] ?? null;
}

// Resolve any supported input into steamid64
async function resolveToSteamId64(inputRaw: string): Promise<string | null> {
  const input = normalizeInput(inputRaw);

  if (isSteamId64(input)) return input;

  const prof = extractFirstGroup(input, STEAM_PROFILE_REGEX);
  if (prof) return prof;

  const looksLikeVanity = STEAM_VANITY_ID_REGEX.test(input) || STEAM_USER_REGEX.test(input);
  STEAM_VANITY_ID_REGEX.lastIndex = 0;
  STEAM_USER_REGEX.lastIndex = 0;

  if (!looksLikeVanity) return null;

  try {
    return await api.resolve(ensureUrl(input));
  } catch {
    return null;
  }
}

// Extract any possible Steam inputs from a big pasted file/text
function extractSteamCandidatesFromText(raw: string): string[] {
  const text = stripCodeBlocks(raw);
  const out: string[] = [];

  for (const m of text.matchAll(STEAM_VANITY_ID_REGEX)) out.push(m[0]);
  for (const m of text.matchAll(STEAM_USER_REGEX)) out.push(m[0]);
  for (const m of text.matchAll(STEAM_PROFILE_REGEX)) out.push(m[0]);

  for (const m of text.matchAll(/\b\d{15,25}\b/g)) out.push(m[0]);

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim().replace(/^<|>$/g, '');
    if (!s) continue;
    if (s.includes('steamcommunity.com/')) out.push(s);
  }

  STEAM_VANITY_ID_REGEX.lastIndex = 0;
  STEAM_USER_REGEX.lastIndex = 0;
  STEAM_PROFILE_REGEX.lastIndex = 0;

  return uniqueStable(out);
}

// Download attachment text (Discord CDN url)
async function fetchTextFromUrl(url: string, maxBytes = MAX_IMPORT_BYTES): Promise<string> {
  const https = await import('https');

  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let size = 0;
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('File too large for import.'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('error', reject);
  });
}

async function importManyProfiles(guildId: string, candidates: string[], note?: string) {
  const list = candidates.slice(0, MAX_IMPORT_ITEMS);

  let added = 0;
  let updated = 0;
  let failed = 0;

  const existing = getGuildProfiles(guildId);
  const existingSet = new Set(existing.map((p) => p.steamid64));

  for (const item of list) {
    const id64 = await resolveToSteamId64(item);
    if (!id64) {
      failed++;
      continue;
    }

    const wasExisting = existingSet.has(id64);
    upsertProfile(guildId, id64, note);

    if (wasExisting) updated++;
    else {
      added++;
      existingSet.add(id64);
    }
  }

  return {
    added,
    updated,
    failed,
    processed: list.length,
    found: candidates.length,
    truncated: candidates.length > MAX_IMPORT_ITEMS,
  };
}

// --------- SLASH COMMANDS ---------
const steamPermalinkCmd = new SlashCommandBuilder()
  .setName('steampermalink')
  .setDescription('Enable or disable Steam permalink detection in this server')
  .addStringOption((opt) =>
    opt
      .setName('state')
      .setDescription('on or off')
      .setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
  );

const steamProfilesCmd = new SlashCommandBuilder()
  .setName('steamprofiles')
  .setDescription('Store and manage Steam profiles in this server')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a Steam profile (url or SteamID64)')
      .addStringOption((opt) =>
        opt
          .setName('input')
          .setDescription('Steam URL (/id, /user, /profiles) or SteamID64')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('note')
          .setDescription('Optional note/label (e.g. "Trusted trader")')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a stored Steam profile by SteamID64')
      .addStringOption((opt) =>
        opt
          .setName('steamid64')
          .setDescription('SteamID64 (e.g. 7656119...)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List stored Steam profiles'))
  .addSubcommand((sub) => sub.setName('clear').setDescription('Remove ALL stored Steam profiles'))
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Import many Steam profiles from pasted text or a .txt attachment')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('Paste text containing Steam links/IDs (one per line or mixed)')
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName('attachment')
          .setDescription('Upload a .txt file containing Steam links/IDs')
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('note')
          .setDescription('Optional note applied to all imported profiles')
          .setRequired(false),
      ),
  );

const commandsJSON = [steamPermalinkCmd.toJSON(), steamProfilesCmd.toJSON()];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), {
      body: commandsJSON,
    });
    console.log(`Registered guild commands in ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID!), {
      body: commandsJSON,
    });
    console.log('Registered global commands (can take time to appear).');
  }
}

// --------- COMMAND HANDLERS ---------
async function handleSteampermalinkCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const state = interaction.options.getString('state', true);
  const enabled = state === 'on';

  setPermalinkEnabled(interaction.guildId, enabled);

  await interaction.reply({
    content: `SteamPermalink is now **${enabled ? 'ON' : 'OFF'}** in this server.`,
    ephemeral: true,
  });
}

async function handleSteamprofilesCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const input = interaction.options.getString('input', true);
    const note = interaction.options.getString('note', false) ?? undefined;

    const id64 = await resolveToSteamId64(input);
    if (!id64) {
      await interaction.reply({
        content: 'Could not resolve that to a Steam profile. Provide a valid Steam URL or SteamID64.',
        ephemeral: true,
      });
      return;
    }

    upsertProfile(interaction.guildId, id64, note);

    await interaction.reply({
      content: `Saved:\nhttps://steamcommunity.com/profiles/${id64}` + (note ? `\nNote: ${note}` : ''),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'remove') {
    const steamid64 = interaction.options.getString('steamid64', true).trim();
    if (!isSteamId64(steamid64)) {
      await interaction.reply({ content: 'That does not look like a SteamID64.', ephemeral: true });
      return;
    }

    const ok = removeProfile(interaction.guildId, steamid64);
    await interaction.reply({
      content: ok
        ? `Removed https://steamcommunity.com/profiles/${steamid64}`
        : 'That SteamID64 was not found in the stored list.',
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'list') {
    const list = getGuildProfiles(interaction.guildId);

    if (list.length === 0) {
      await interaction.reply({ content: 'No stored Steam profiles yet.', ephemeral: true });
      return;
    }

    const shown = list.slice(0, 25).map((p, i) => {
      const line = `${i + 1}. https://steamcommunity.com/profiles/${p.steamid64}`;
      return p.note ? `${line} — ${p.note}` : line;
    });

    const more = list.length > 25 ? `\n…and ${list.length - 25} more.` : '';

    await interaction.reply({
      content: `Stored Steam profiles (${list.length}):\n${shown.join('\n')}${more}`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'clear') {
    clearProfiles(interaction.guildId);
    await interaction.reply({ content: 'Cleared all stored Steam profiles for this server.', ephemeral: true });
    return;
  }

  if (sub === 'import') {
    const text = interaction.options.getString('text', false) ?? '';
    const attachment = interaction.options.getAttachment('attachment', false);
    const note = interaction.options.getString('note', false) ?? undefined;

    if (!text && !attachment) {
      await interaction.reply({
        content: 'Provide either `text` (paste) or an `attachment` (.txt).',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let inputText = text;

    if (attachment) {
      try {
        inputText += '\n' + (await fetchTextFromUrl(attachment.url));
      } catch (err: any) {
        await interaction.editReply(`Failed to download attachment: ${err?.message ?? 'unknown error'}`);
        return;
      }
    }

    const candidates = extractSteamCandidatesFromText(inputText);
    if (candidates.length === 0) {
      await interaction.editReply('No Steam links or SteamID64 values found in the input.');
      return;
    }

    const result = await importManyProfiles(interaction.guildId, candidates, note);

    await interaction.editReply(
      `Import complete.\n` +
        `Found: ${result.found}\n` +
        `Processed: ${result.processed}${result.truncated ? ' (truncated to limit)' : ''}\n` +
        `Added: ${result.added}\n` +
        `Updated: ${result.updated}\n` +
        `Failed: ${result.failed}`,
    );
    return;
  }
}

// --------- MESSAGE HANDLER (auto permalink) ---------
async function handleMessage(message: Message, fromEdit: boolean) {
  try {
    if (!message.content) return;
    if (message.author?.bot) return;
    if (!message.guildId) return;

    if (!isPermalinkEnabled(message.guildId)) return;

    cleanupRepliedMessages();
    if (repliedMessageIds.has(message.id)) return;

    const now = Date.now();
    const last = lastReplyAtByUser.get(message.author.id) ?? 0;
    if (now - last < USER_COOLDOWN_MS) return;

    const content = stripCodeBlocks(message.content);

    const vanityMatches = [...content.matchAll(STEAM_VANITY_ID_REGEX)].map((m) => m[0]);
    const userMatches = [...content.matchAll(STEAM_USER_REGEX)].map((m) => m[0]);
    const profileMatches = [...content.matchAll(STEAM_PROFILE_REGEX)].map((m) => m[0]);

    STEAM_VANITY_ID_REGEX.lastIndex = 0;
    STEAM_USER_REGEX.lastIndex = 0;
    STEAM_PROFILE_REGEX.lastIndex = 0;

    if (vanityMatches.length === 0 && userMatches.length === 0 && profileMatches.length === 0) return;

    const permalinks: string[] = [];

    for (const url of profileMatches) {
      const id64 = extractFirstGroup(url, STEAM_PROFILE_REGEX);
      if (id64) permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
    }

    for (const url of [...vanityMatches, ...userMatches]) {
      const id64 = await resolveToSteamId64(url);
      if (id64) permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
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
    // silent
  }
}

// --------- EVENTS ---------
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

  if (interaction.commandName === 'steampermalink') {
    await handleSteampermalinkCommand(interaction);
    return;
  }

  if (interaction.commandName === 'steamprofiles') {
    await handleSteamprofilesCommand(interaction);
    return;
  }
});

client.on(Events.MessageCreate, (message) => {
  void handleMessage(message, false);
});

client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
  const msg = newMsg as Message;
  void handleMessage(msg, true);
});

// --------- LOGIN ---------
client.login(DISCORD_TOKEN);

// Keep-alive server (Render/Replit/etc.)
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end("I'm alive");
  })
  .listen(PORT);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
});
