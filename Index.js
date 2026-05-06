const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.BOT_TOKEN;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith('!') || message.author.bot) return;

  const args = message.content.split(' ');
  const command = args.shift().toLowerCase();

  if (command === '!play') {
    const query = args.join(' ');
    if (!query) return message.reply('Provide a song name or URL.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first.');

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });

      const stream = await play.stream(query, {
        quality: 2,
        discordPlayerCompatibility: true
      });

      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        inlineVolume: true
      });

      resource.volume.setVolume(0.7);

      const player = createAudioPlayer();
      connection.subscribe(player);

      player.play(resource);

      player.on(AudioPlayerStatus.Playing, () => {
        message.channel.send(`ð¶ Now playing: ${query}`);
      });

      player.on('error', error => {
        console.error(error);
        message.channel.send('Error playing track.');
      });

    } catch (err) {
      console.error(err);
      message.reply('Failed to play track.');
    }
  }

  if (command === '!stop') {
    const connection = getVoiceConnection(message.guild.id);
    if (connection) {
      connection.destroy();
      message.channel.send('â¹ Stopped playback.');
    }
  }
});

client.login(TOKEN);
