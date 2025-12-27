import 'dotenv/config';
import http from 'http';
import SteamAPI from 'type-steamapi';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Message,
  EmbedBuilder,
} from 'discord.js';

console.log('Starting process...');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const STEAM_API_KEY = process.env.STEAM_API_KEY;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN in environment.');
if (!STEAM_API_KEY) throw new Error('Missing STEAM_API_KEY in environment.');

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

// --- Config ---
const USER_COOLDOWN_MS = 8_000;          // don't spam the same user
const MESSAGE_REPLY_TTL_MS = 60 * 60_000; // remember replied messages for 1 hour

// --- Regex ---
// Captures steam vanity ids: steamcommunity.com/id/<name>
const STEAM_VANITY_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]+)(?=$|[\s)\]}>"'.,!?])/gi;

// Captures steam profile ids: steamcommunity.com/profiles/<steamid64>
const STEAM_PROFILE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/(\d{15,25})(?=$|[\s)\]}>"'.,!?])/gi;

// --- Anti-spam state ---
const lastReplyAtByUser = new Map<string, number>();
const repliedMessageIds = new Map<string, number>(); // messageId -> timestamp

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}!`);
});

// Respond to new messages
client.on(Events.MessageCreate, (message) => {
  void handleMessage(message, false);
});

// Respond to edits (if content changes)
client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
  // Only handle if it's a cached Message with content
  const message = newMsg as Message;
  void handleMessage(message, true);
});

async function handleMessage(message: Message, fromEdit: boolean) {
  try {
    if (!message.content) return;
    if (message.author?.bot) return;
    if (!message.guild) return; // ignore DMs (remove if you want DMs too)

    // Don't reply repeatedly to the same message
    cleanupRepliedMessages();
    if (repliedMessageIds.has(message.id)) return;

    // Cooldown per user
    const now = Date.now();
    const last = lastReplyAtByUser.get(message.author.id) ?? 0;
    if (now - last < USER_COOLDOWN_MS) return;

    // Parse (ignoring code blocks)
    const content = stripCodeBlocks(message.content);

    const vanityUrls = extractFullMatches(content, STEAM_VANITY_REGEX);
    const profileUrls = extractFullMatches(content, STEAM_PROFILE_REGEX);

    if (vanityUrls.length === 0 && profileUrls.length === 0) return;

    // Normalize profile links immediately
    const permalinks: string[] = [];

    for (const fullProfileUrl of profileUrls) {
      const id64 = extractFirstGroup(fullProfileUrl, STEAM_PROFILE_REGEX);
      if (id64) permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
    }

    // Resolve vanity links to /profiles/<id64>
    for (const fullVanityUrl of vanityUrls) {
      try {
        const normalized = fullVanityUrl.startsWith('http')
          ? fullVanityUrl
          : `https://${fullVanityUrl}`;

        const id64 = await api.resolve(normalized);
        permalinks.push(`https://steamcommunity.com/profiles/${id64}`);
      } catch {
        // silent by default
      }
    }

    const uniquePermalinks = uniqueStable(permalinks);
    if (uniquePermalinks.length === 0) return;

    // Build an embed (clean + no ping)
    const plural = uniquePermalinks.length !== 1;
    const embed = new EmbedBuilder()
      .setTitle(plural ? 'Steam permalinks' : 'Steam permalink')
      .setDescription(uniquePermalinks.join('\n'))
      .setFooter({
        text: fromEdit
          ? 'Detected after message edit.'
          : 'Detected in your message.',
      });

    await message.reply({
      embeds: [embed],
      // no pings at all:
      allowedMentions: { parse: [] },
    });

    // mark as replied + set cooldown
    repliedMessageIds.set(message.id, now);
    lastReplyAtByUser.set(message.author.id, now);
  } catch {
    // keep silent (or log if you want)
  }
}

// --- Helpers ---

function stripCodeBlocks(text: string): string {
  // Remove triple-backtick blocks + inline backticks
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

// Login
client.login(DISCORD_TOKEN);

// Keep-alive server (Render/Replit)
http
  .createServer((req, res) => {
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