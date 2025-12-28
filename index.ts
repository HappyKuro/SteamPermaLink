import 'dotenv/config';
import http from 'http';
import https from 'https';
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

// ---------------- ENV ----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional (fast command updates)
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN in environment.');
if (!STEAM_API_KEY) throw new Error('Missing STEAM_API_KEY in environment.');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID in environment.');

// ---------------- CLIENT ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------------- STEAM API ----------------
const api = new SteamAPI({
  apiKey: STEAM_API_KEY,
  cache: { enabled: true, expiresIn: 10 * 60_000 },
});

// ---------------- CONFIG ----------------
const USER_COOLDOWN_MS = 8_000;
const MESSAGE_REPLY_TTL_MS = 60 * 60_000;

const MAX_IMPORT_ITEMS = 300;
const MAX_IMPORT_BYTES = 300_000;

const LIST_PAGE_SIZE = 10;

// ---------------- REGEX ----------------
// Profiles:
const STEAM_VANITY_ID_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;
const STEAM_USER_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/user\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;
const STEAM_PROFILE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{15,25})(?=$|[\s)\]}>"'.,!?])/gi;

// Groups:
const STEAM_GROUPS_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/groups\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;
const STEAM_GID_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/gid\/(\d{15,25})(?=$|[\s)\]}>"'.,!?])/gi;

// ---------------- ANTI-SPAM ----------------
const lastReplyAtByUser = new Map<string, number>();
const repliedMessageIds = new Map<string, number>(); // messageId -> timestamp

function cleanupRepliedMessages() {
  const now = Date.now();
  for (const [msgId, ts] of repliedMessageIds) {
    if (now - ts > MESSAGE_REPLY_TTL_MS) repliedMessageIds.delete(msgId);
  }
}

// ---------------- SETTINGS (per-guild ON/OFF) ----------------
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
  return guildSettings[guildId]?.enabled ?? true;
}
function setPermalinkEnabled(guildId: string, enabled: boolean) {
  guildSettings[guildId] = { enabled };
  saveSettings(guildSettings);
}

// ---------------- GLOBAL PROFILES DB (NO GUILD IDS) ----------------
type StoredProfile = { steamid64: string; note?: string; addedAt: number };
type ProfilesDB = { profiles: StoredProfile[] };

const PROFILES_PATH = path.join(process.cwd(), 'steamprofiles.json');

function loadProfiles(): ProfilesDB {
  try {
    if (!fs.existsSync(PROFILES_PATH)) return { profiles: [] };
    const parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8')) as ProfilesDB;
    if (!parsed || !Array.isArray(parsed.profiles)) return { profiles: [] };
    return parsed;
  } catch {
    return { profiles: [] };
  }
}
function saveProfiles(db: ProfilesDB) {
  try {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

const profilesDB: ProfilesDB = loadProfiles();

function getProfiles(): StoredProfile[] {
  return profilesDB.profiles;
}

type UpsertResult = 'added' | 'updated' | 'exists';

function upsertProfile(steamid64: string, note?: string): UpsertResult {
  const list = profilesDB.profiles;
  const idx = list.findIndex((p) => p.steamid64 === steamid64);

  if (idx >= 0) {
    const existing = list[idx];
    const trimmed = note?.trim();

    if (!trimmed || existing.note === trimmed) return 'exists';

    list[idx] = { ...existing, note: trimmed, addedAt: existing.addedAt };
    saveProfiles(profilesDB);
    return 'updated';
  }

  list.push({ steamid64, note: note?.trim() || undefined, addedAt: Date.now() });
  saveProfiles(profilesDB);
  return 'added';
}

function removeProfile(steamid64: string): boolean {
  const before = profilesDB.profiles.length;
  profilesDB.profiles = profilesDB.profiles.filter((p) => p.steamid64 !== steamid64);
  saveProfiles(profilesDB);
  return profilesDB.profiles.length !== before;
}

function clearProfiles() {
  profilesDB.profiles = [];
  saveProfiles(profilesDB);
}

// ---------------- GLOBAL GROUPS DB (NO GUILD IDS) ----------------
type StoredGroup = {
  key: string; // "gid:<digits>" OR "groups:<nameLower>"
  url: string; // canonical url
  gid64?: string;
  name?: string;
  note?: string;
  addedAt: number;
};
type GroupsDB = { groups: StoredGroup[] };

const GROUPS_PATH = path.join(process.cwd(), 'steamgroups.json');

function loadGroups(): GroupsDB {
  try {
    if (!fs.existsSync(GROUPS_PATH)) return { groups: [] };
    const parsed = JSON.parse(fs.readFileSync(GROUPS_PATH, 'utf-8')) as GroupsDB;
    if (!parsed || !Array.isArray(parsed.groups)) return { groups: [] };
    return parsed;
  } catch {
    return { groups: [] };
  }
}
function saveGroups(db: GroupsDB) {
  try {
    fs.writeFileSync(GROUPS_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

const groupsDB: GroupsDB = loadGroups();

function getGroups(): StoredGroup[] {
  return groupsDB.groups;
}

function makeGroupFromInput(inputRaw: string, note?: string): StoredGroup | null {
  const input = normalizeInput(inputRaw);

  // gid/<digits>
  const gid = extractFirstGroup(input, STEAM_GID_REGEX);
  if (gid) {
    return {
      key: `gid:${gid}`,
      url: `https://steamcommunity.com/gid/${gid}`,
      gid64: gid,
      note: note?.trim() || undefined,
      addedAt: Date.now(),
    };
  }

  // groups/<name>
  const name = extractFirstGroup(input, STEAM_GROUPS_REGEX);
  if (name) {
    const lower = name.toLowerCase();
    return {
      key: `groups:${lower}`,
      url: `https://steamcommunity.com/groups/${name}`,
      name,
      note: note?.trim() || undefined,
      addedAt: Date.now(),
    };
  }

  // allow paste without protocol: "steamcommunity.com/groups/xxx"
  if (input.includes('steamcommunity.com/groups/')) {
    const m = input.match(/steamcommunity\.com\/groups\/([A-Za-z0-9_-]+)/i);
    if (m?.[1]) {
      const nm = m[1];
      return {
        key: `groups:${nm.toLowerCase()}`,
        url: `https://steamcommunity.com/groups/${nm}`,
        name: nm,
        note: note?.trim() || undefined,
        addedAt: Date.now(),
      };
    }
  }

  if (input.includes('steamcommunity.com/gid/')) {
    const m = input.match(/steamcommunity\.com\/gid\/(\d{15,25})/i);
    if (m?.[1]) {
      const gid2 = m[1];
      return {
        key: `gid:${gid2}`,
        url: `https://steamcommunity.com/gid/${gid2}`,
        gid64: gid2,
        note: note?.trim() || undefined,
        addedAt: Date.now(),
      };
    }
  }

  return null;
}

function upsertGroup(group: StoredGroup): UpsertResult {
  const list = groupsDB.groups;
  const idx = list.findIndex((g) => g.key === group.key);

  if (idx >= 0) {
    const existing = list[idx];
    const trimmed = group.note?.trim();

    // exists if no note change
    if (!trimmed || existing.note === trimmed) return 'exists';

    list[idx] = {
      ...existing,
      note: trimmed,
      // keep original addedAt
      addedAt: existing.addedAt,
    };
    saveGroups(groupsDB);
    return 'updated';
  }

  list.push(group);
  saveGroups(groupsDB);
  return 'added';
}

function removeGroupByKey(key: string): boolean {
  const before = groupsDB.groups.length;
  groupsDB.groups = groupsDB.groups.filter((g) => g.key !== key);
  saveGroups(groupsDB);
  return groupsDB.groups.length !== before;
}

function clearGroups() {
  groupsDB.groups = [];
  saveGroups(groupsDB);
}

// ---------------- HELPERS ----------------
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

// Resolve supported profile input into steamid64
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

// Extract many profile inputs from text
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

// Extract many group inputs from text
function extractGroupCandidatesFromText(raw: string): string[] {
  const text = stripCodeBlocks(raw);
  const out: string[] = [];

  for (const m of text.matchAll(STEAM_GROUPS_REGEX)) out.push(m[0]);
  for (const m of text.matchAll(STEAM_GID_REGEX)) out.push(m[0]);

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim().replace(/^<|>$/g, '');
    if (!s) continue;
    if (s.includes('steamcommunity.com/groups/') || s.includes('steamcommunity.com/gid/')) out.push(s);
  }

  STEAM_GROUPS_REGEX.lastIndex = 0;
  STEAM_GID_REGEX.lastIndex = 0;

  return uniqueStable(out);
}

// Download attachment text (Discord CDN)
async function fetchTextFromUrl(url: string, maxBytes = MAX_IMPORT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let size = 0;
      const chunks: Uint8Array[] = [];

      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('File too large for import.'));
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });

      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.toString('utf-8'));
      });

      res.on('error', reject);
    });

    req.on('error', reject);
  });
}

type ImportResult = {
  added: number;
  updated: number;
  exists: number;
  failed: number;
  processed: number;
  found: number;
  truncated: boolean;
};

async function importManyProfiles(candidates: string[], note?: string): Promise<ImportResult> {
  const list = candidates.slice(0, MAX_IMPORT_ITEMS);

  let added = 0;
  let updated = 0;
  let exists = 0;
  let failed = 0;

  for (const item of list) {
    const id64 = await resolveToSteamId64(item);
    if (!id64) {
      failed++;
      continue;
    }
    const r = upsertProfile(id64, note);
    if (r === 'added') added++;
    else if (r === 'updated') updated++;
    else exists++;
  }

  return {
    added,
    updated,
    exists,
    failed,
    processed: list.length,
    found: candidates.length,
    truncated: candidates.length > MAX_IMPORT_ITEMS,
  };
}

async function importManyGroups(candidates: string[], note?: string): Promise<ImportResult> {
  const list = candidates.slice(0, MAX_IMPORT_ITEMS);

  let added = 0;
  let updated = 0;
  let exists = 0;
  let failed = 0;

  for (const item of list) {
    const g = makeGroupFromInput(item, note);
    if (!g) {
      failed++;
      continue;
    }
    const r = upsertGroup(g);
    if (r === 'added') added++;
    else if (r === 'updated') updated++;
    else exists++;
  }

  return {
    added,
    updated,
    exists,
    failed,
    processed: list.length,
    found: candidates.length,
    truncated: candidates.length > MAX_IMPORT_ITEMS,
  };
}

// ---------------- SLASH COMMANDS ----------------
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
  .setDescription('Store and manage Steam profiles (global list)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a Steam profile (url or SteamID64)')
      .addStringOption((opt) =>
        opt.setName('input').setDescription('Steam URL (/id, /user, /profiles) or SteamID64').setRequired(true),
      )
      .addStringOption((opt) => opt.setName('note').setDescription('Optional note/label').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a stored Steam profile by SteamID64')
      .addStringOption((opt) => opt.setName('steamid64').setDescription('SteamID64').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List stored Steam profiles (paginated)')
      .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false)),
  )
  .addSubcommand((sub) => sub.setName('clear').setDescription('Remove ALL stored Steam profiles'))
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Import many Steam profiles from pasted text or a .txt attachment')
      .addStringOption((opt) => opt.setName('text').setDescription('Paste text').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('attachment').setDescription('Upload .txt').setRequired(false))
      .addStringOption((opt) => opt.setName('note').setDescription('Optional note for all').setRequired(false)),
  );

const steamGroupsCmd = new SlashCommandBuilder()
  .setName('steamgroups')
  .setDescription('Store and manage Steam groups (global list)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a Steam group (groups/<name> or gid/<gid64>)')
      .addStringOption((opt) =>
        opt.setName('input').setDescription('Steam group URL (groups/... or gid/...)').setRequired(true),
      )
      .addStringOption((opt) => opt.setName('note').setDescription('Optional note/label').setRequired(false)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a stored Steam group by key (shown in list)')
      .addStringOption((opt) => opt.setName('key').setDescription('Example: gid:123... or groups:mygroup').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List stored Steam groups (paginated)')
      .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false)),
  )
  .addSubcommand((sub) => sub.setName('clear').setDescription('Remove ALL stored Steam groups'))
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Import many Steam groups from pasted text or a .txt attachment')
      .addStringOption((opt) => opt.setName('text').setDescription('Paste text').setRequired(false))
      .addAttachmentOption((opt) => opt.setName('attachment').setDescription('Upload .txt').setRequired(false))
      .addStringOption((opt) => opt.setName('note').setDescription('Optional note for all').setRequired(false)),
  );

const commandsJSON = [steamPermalinkCmd.toJSON(), steamProfilesCmd.toJSON(), steamGroupsCmd.toJSON()];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID), { body: commandsJSON });
    console.log(`Registered guild commands in ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commandsJSON });
    console.log('Registered global commands (can take time to appear).');
  }
}

// ---------------- COMMAND HANDLERS ----------------
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
      await interaction.reply({ content: 'Could not resolve that to a Steam profile.', ephemeral: true });
      return;
    }

    const result = upsertProfile(id64, note);
    const url = `https://steamcommunity.com/profiles/${id64}`;

    const msg =
      result === 'added'
        ? `✅ **Added**\n${url}`
        : result === 'updated'
          ? `✏️ **Updated note**\n${url}`
          : `⚠️ **Already exists**\n${url}`;

    await interaction.reply({ content: msg, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'remove') {
    const steamid64 = interaction.options.getString('steamid64', true).trim();
    if (!isSteamId64(steamid64)) {
      await interaction.reply({ content: 'That does not look like a SteamID64.', ephemeral: true });
      return;
    }

    const ok = removeProfile(steamid64);
    await interaction.reply({
      content: ok ? `Removed https://steamcommunity.com/profiles/${steamid64}` : 'Not found in stored list.',
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'list') {
    const list = getProfiles();
    if (list.length === 0) {
      await interaction.reply({ content: 'No stored Steam profiles yet.', ephemeral: true });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(list.length / LIST_PAGE_SIZE));
    const requested = interaction.options.getInteger('page', false) ?? 1;
    const page = Math.min(Math.max(requested, 1), totalPages);

    const start = (page - 1) * LIST_PAGE_SIZE;
    const slice = list.slice(start, start + LIST_PAGE_SIZE);

    const lines = slice.map((p, idx) => {
      const n = start + idx + 1;
      const url = `https://steamcommunity.com/profiles/${p.steamid64}`;
      return p.note ? `**${n}.** ${url}\n↳ ${p.note}` : `**${n}.** ${url}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Stored Steam profiles')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Page ${page}/${totalPages} • Total ${list.length}` });

    await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'clear') {
    clearProfiles();
    await interaction.reply({ content: 'Cleared all stored Steam profiles (global).', ephemeral: true });
    return;
  }

  if (sub === 'import') {
    const text = interaction.options.getString('text', false) ?? '';
    const attachment = interaction.options.getAttachment('attachment', false);
    const note = interaction.options.getString('note', false) ?? undefined;

    if (!text && !attachment) {
      await interaction.reply({ content: 'Provide `text` or an `attachment` (.txt).', ephemeral: true });
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
      await interaction.editReply('No Steam links or SteamID64 values found.');
      return;
    }

    const result = await importManyProfiles(candidates, note);

    await interaction.editReply(
      `Import complete (profiles).\n` +
        `Found: ${result.found}\n` +
        `Processed: ${result.processed}${result.truncated ? ' (truncated)' : ''}\n` +
        `Added: ${result.added}\n` +
        `Updated: ${result.updated}\n` +
        `Already existed: ${result.exists}\n` +
        `Failed: ${result.failed}`,
    );
    return;
  }
}

async function handleSteamgroupsCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const input = interaction.options.getString('input', true);
    const note = interaction.options.getString('note', false) ?? undefined;

    const g = makeGroupFromInput(input, note);
    if (!g) {
      await interaction.reply({ content: 'Could not parse that as a Steam group URL.', ephemeral: true });
      return;
    }

    const result = upsertGroup(g);

    const msg =
      result === 'added'
        ? `✅ **Added group**\n${g.url}\nKey: \`${g.key}\``
        : result === 'updated'
          ? `✏️ **Updated group note**\n${g.url}\nKey: \`${g.key}\``
          : `⚠️ **Group already exists**\n${g.url}\nKey: \`${g.key}\``;

    await interaction.reply({ content: msg, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'remove') {
    const key = interaction.options.getString('key', true).trim();
    const ok = removeGroupByKey(key);

    await interaction.reply({
      content: ok ? `Removed group with key \`${key}\`.` : `Key \`${key}\` not found.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === 'list') {
    const list = getGroups();
    if (list.length === 0) {
      await interaction.reply({ content: 'No stored Steam groups yet.', ephemeral: true });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(list.length / LIST_PAGE_SIZE));
    const requested = interaction.options.getInteger('page', false) ?? 1;
    const page = Math.min(Math.max(requested, 1), totalPages);

    const start = (page - 1) * LIST_PAGE_SIZE;
    const slice = list.slice(start, start + LIST_PAGE_SIZE);

    const lines = slice.map((g, idx) => {
      const n = start + idx + 1;
      const keyLine = `\`${g.key}\``;
      const noteLine = g.note ? `\n↳ ${g.note}` : '';
      return `**${n}.** ${g.url}\nKey: ${keyLine}${noteLine}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Stored Steam groups')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `Page ${page}/${totalPages} • Total ${list.length}` });

    await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'clear') {
    clearGroups();
    await interaction.reply({ content: 'Cleared all stored Steam groups (global).', ephemeral: true });
    return;
  }

  if (sub === 'import') {
    const text = interaction.options.getString('text', false) ?? '';
    const attachment = interaction.options.getAttachment('attachment', false);
    const note = interaction.options.getString('note', false) ?? undefined;

    if (!text && !attachment) {
      await interaction.reply({ content: 'Provide `text` or an `attachment` (.txt).', ephemeral: true });
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

    const candidates = extractGroupCandidatesFromText(inputText);
    if (candidates.length === 0) {
      await interaction.editReply('No Steam group links found.');
      return;
    }

    const result = await importManyGroups(candidates, note);

    await interaction.editReply(
      `Import complete (groups).\n` +
        `Found: ${result.found}\n` +
        `Processed: ${result.processed}${result.truncated ? ' (truncated)' : ''}\n` +
        `Added: ${result.added}\n` +
        `Updated: ${result.updated}\n` +
        `Already existed: ${result.exists}\n` +
        `Failed: ${result.failed}`,
    );
    return;
  }
}

// ---------------- MESSAGE HANDLER (auto permalink) ----------------
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

    // Profiles
    const vanityMatches = [...content.matchAll(STEAM_VANITY_ID_REGEX)].map((m) => m[0]);
    const userMatches = [...content.matchAll(STEAM_USER_REGEX)].map((m) => m[0]);
    const profileMatches = [...content.matchAll(STEAM_PROFILE_REGEX)].map((m) => m[0]);

    STEAM_VANITY_ID_REGEX.lastIndex = 0;
    STEAM_USER_REGEX.lastIndex = 0;
    STEAM_PROFILE_REGEX.lastIndex = 0;

    // Groups
    const groupsMatches = [...content.matchAll(STEAM_GROUPS_REGEX)].map((m) => m[0]);
    const gidMatches = [...content.matchAll(STEAM_GID_REGEX)].map((m) => m[0]);
    STEAM_GROUPS_REGEX.lastIndex = 0;
    STEAM_GID_REGEX.lastIndex = 0;

    if (
      vanityMatches.length === 0 &&
      userMatches.length === 0 &&
      profileMatches.length === 0 &&
      groupsMatches.length === 0 &&
      gidMatches.length === 0
    ) return;

    const profilePermalinks: string[] = [];
    const groupLinks: string[] = [];

    for (const url of profileMatches) {
      const id64 = extractFirstGroup(url, STEAM_PROFILE_REGEX);
      if (id64) profilePermalinks.push(`https://steamcommunity.com/profiles/${id64}`);
    }

    for (const url of [...vanityMatches, ...userMatches]) {
      const id64 = await resolveToSteamId64(url);
      if (id64) profilePermalinks.push(`https://steamcommunity.com/profiles/${id64}`);
    }

    // Groups: keep canonical (no reliable API resolution from /groups -> /gid)
    for (const u of gidMatches) {
      const gid = extractFirstGroup(u, STEAM_GID_REGEX);
      if (gid) groupLinks.push(`https://steamcommunity.com/gid/${gid}`);
    }
    for (const u of groupsMatches) {
      const name = extractFirstGroup(u, STEAM_GROUPS_REGEX);
      if (name) groupLinks.push(`https://steamcommunity.com/groups/${name}`);
    }

    const uniqueProfiles = uniqueStable(profilePermalinks);
    const uniqueGroups = uniqueStable(groupLinks);

    if (uniqueProfiles.length === 0 && uniqueGroups.length === 0) return;

    const embed = new EmbedBuilder().setFooter({
      text: fromEdit ? 'Detected after message edit.' : 'Detected in your message.',
    });

    if (uniqueProfiles.length > 0) {
      embed.addFields({
        name: uniqueProfiles.length === 1 ? 'Steam profile permalink' : 'Steam profile permalinks',
        value: uniqueProfiles.join('\n'),
      });
    }

    if (uniqueGroups.length > 0) {
      embed.addFields({
        name: uniqueGroups.length === 1 ? 'Steam group link' : 'Steam group links',
        value: uniqueGroups.join('\n'),
      });
    }

    await message.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

    repliedMessageIds.set(message.id, now);
    lastReplyAtByUser.set(message.author.id, now);
  } catch {
    // silent
  }
}

// ---------------- EVENTS ----------------
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

  if (interaction.commandName === 'steamgroups') {
    await handleSteamgroupsCommand(interaction);
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

// ---------------- START ----------------
client.login(DISCORD_TOKEN);

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end("I'm alive");
  })
  .listen(PORT);

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
});
