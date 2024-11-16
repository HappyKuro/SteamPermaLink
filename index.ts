import Discord, { Message } from 'discord.js';
import SteamAPI from 'type-steamapi';
import http from 'http';

console.log("Starting process...")

require("dotenv").config();

const client = new Discord.Client({
    intents: ['Guilds', 'GuildMessages', 'MessageContent']
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user?.tag}!`);
});

const customURLregex = /(https?:\/\/)?steamcommunity\.com\/id\/[\w-]+/
const api = new SteamAPI({ apiKey: process.env.STEAM_API_KEY ?? "YOURSTEAMAPIKEY", cache: {enabled: true, expiresIn: 5 * 60000}});

client.on('messageCreate', (message) => {
    checkMessage(message);
});

async function checkMessage(message: Message) {
    if(message.author.bot) return;

    const matches = extractMatches(message.content);
    let permaLinks: string[] = [];

    for(let customURL of matches) {
        try {
            let id = await api.resolve(customURL);
            console.log(customURL + " --> " + id);
            permaLinks.push("https://steamcommunity.com/profiles/" + id);
        } catch {
        }
    }

    if(permaLinks.length === 0) return;

    try {
        const links = removeDuplicates(permaLinks).join("\n");
        const plural = permaLinks.length !== 1;
        const reply = 
        `Hey <@${message.author.id}>, your message contains${plural ? "" : " a"} Steam Custom URL${plural ? "s" : ""}. Here ${plural ? "are" : "is"} the permalink${plural ? "s" : ""}:\n`
        + links

        await message.reply(reply);
    } catch {
    }
}

client.login(process.env.DISCORD_TOKEN);

function extractMatches(inputString: string): string[] {
    const regex = new RegExp(customURLregex, 'g');
    const matches: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(inputString)) !== null) {
        matches.push(match[0]);
    }

    return matches;
}

function removeDuplicates<T>(arr: T[]): T[] {
    return [...new Set(arr)];
}

// for replit or render to host 24/7.
http.createServer(function (req, res) {
    res.write("I'm alive");
    res.end();
  }).listen(8080);