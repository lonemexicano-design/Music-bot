const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const { spawn } = require('child_process');
const ffmpegPath = (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.BOT_TOKEN;
const queues = new Map();

async function initSoundCloud() {
  try {
    const id = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: id } });
    console.log('SoundCloud ready.');
  } catch (e) {
    console.error('SoundCloud init error:', e.message);
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildProgressBar(elapsed, total, length = 20) {
  const progress = total > 0 ? Math.min(elapsed / total, 1) : 0;
  const filled = Math.round(progress * length);
  const bar = 'â¬'.repeat(filled) + 'ð' + 'â¬'.repeat(Math.max(0, length - filled));
  return bar;
}

async function resolveSong(query) {
  const isSoundCloudUrl = /^https?:\/\/(www\.)?soundcloud\.com/.test(query);
  if (isSoundCloudUrl) {
    const track = await play.soundcloud(query);
    return {
      url: track.url,
      title: track.name,
      durationInSec: Math.floor(track.durationInMs / 1000)
    };
  } else {
    const results = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
    if (!results || results.length === 0) throw new Error('No results found.');
    const track = results[0];
    return {
      url: track.url,
      title: track.name,
      durationInSec: Math.floor(track.durationInMs / 1000)
    };
  }
}

function killFfmpeg(queue) {
  if (queue && queue.ffmpeg) {
    try { queue.ffmpeg.kill('SIGKILL'); } catch (_) {}
    queue.ffmpeg = null;
  }
}

async function playNext(guildId, seekSeconds = 0) {
  const queue = queues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    queues.delete(guildId);
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
    return;
  }

  killFfmpeg(queue);

  const song = queue.songs[0];

  try {
    const streamOptions = seekSeconds > 0 ? { seek: seekSeconds } : {};
    const scStream = await play.stream(song.url, streamOptions);

    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-vn',
      '-af', `volume=${queue.volume / 100}`,
      '-acodec', 'libopus',
      '-b:a', '128k',
      '-f', 'ogg',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    scStream.stream.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.on('error', err => console.error('FFmpeg error:', err.message));

    queue.ffmpeg = ffmpeg;
    queue.startTime = Date.now() - seekSeconds * 1000;
    queue.pausedAt = null;

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.OggOpus,
      inlineVolume: false
    });

    queue.player.play(resource);

    if (seekSeconds === 0) {
      queue.textChannel.send(`ð¶ Now playing: **${song.title}**`);
    }
  } catch (err) {
    console.error(err);
    queue.textChannel.send(`Failed to play **${song.title}**, skipping...`);
    queue.songs.shift();
    playNext(guildId);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initSoundCloud();
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith('!') || message.author.bot) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'play') {
    const query = args.join(' ');
    if (!query) return message.reply('Provide a song name or SoundCloud URL.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first.');

    let song;
    try {
      song = await resolveSong(query);
    } catch (err) {
      console.error(err);
      return message.reply('Could not find that song. Try a different name or SoundCloud URL.');
    }

    let queue = queues.get(message.guild.id);

    if (!queue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      queue = {
        connection,
        player,
        songs: [],
        loop: 'off',
        volume: 70,
        startTime: null,
        pausedAt: null,
        ffmpeg: null,
        textChannel: message.channel,
        ready: false,
      };

      queues.set(message.guild.id, queue);

      connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready && !queue.ready) {
          queue.ready = true;
          if (queue.songs.length > 0 && player.state.status === AudioPlayerStatus.Idle) {
            playNext(message.guild.id);
          }
        }
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          try {
            connection.rejoin();
          } catch (e) {
            console.error('Voice rejoin failed:', e.message);
            killFfmpeg(queue);
            queues.delete(message.guild.id);
            connection.destroy();
          }
        }
      });

      player.on(AudioPlayerStatus.Idle, () => {
        if (queue.loop === 'song') {
          playNext(message.guild.id);
        } else if (queue.loop === 'queue') {
          queue.songs.push(queue.songs.shift());
          playNext(message.guild.id);
        } else {
          queue.songs.shift();
          playNext(message.guild.id);
        }
      });

      player.on('error', error => {
        console.error('[Player] Error:', error.message);
        queue.textChannel.send('Error playing track, skipping...');
        queue.songs.shift();
        playNext(message.guild.id);
      });

      queue.songs.push(song);
      return;
    }

    queue.songs.push(song);

    if (queue.songs.length === 1) {
      playNext(message.guild.id);
    } else {
      message.channel.send(`â Added to queue (position ${queue.songs.length}): **${song.title}**`);
    }
  }

  if (command === 'nowplaying' || command === 'np') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply('Nothing is playing right now.');
    }
    const song = queue.songs[0];
    const reference = queue.pausedAt ?? Date.now();
    const elapsed = queue.startTime ? Math.floor((reference - queue.startTime) / 1000) : 0;
    const total = song.durationInSec || 0;
    const bar = buildProgressBar(elapsed, total);
    const loopIcon = queue.loop === 'song' ? ' ð' : queue.loop === 'queue' ? ' ð' : '';
    const pauseIcon = queue.pausedAt ? ' â¸' : '';
    message.channel.send(
      `ð¶ **Now Playing${loopIcon}${pauseIcon}**\n**${song.title}**\n\n${bar}\n\`${formatTime(elapsed)} / ${formatTime(total)}\``
    );
  }

  if (command === 'pause') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) return message.reply('Nothing is playing.');
    if (queue.pausedAt) return message.reply('Already paused. Use `!resume` to continue.');
    queue.player.pause();
    queue.pausedAt = Date.now();
    message.channel.send(`â¸ Paused: **${queue.songs[0].title}**`);
  }

  if (command === 'resume') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) return message.reply('Nothing is playing.');
    if (!queue.pausedAt) return message.reply('Not paused.');
    queue.player.unpause();
    queue.startTime += Date.now() - queue.pausedAt;
    queue.pausedAt = null;
    message.channel.send(`â¶ï¸ Resumed: **${queue.songs[0].title}**`);
  }

  if (command === 'skip') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply('Nothing is playing.');
    }
    message.channel.send(`â­ Skipped: **${queue.songs[0].title}**`);
    killFfmpeg(queue);
    queue.songs.shift();
    if (queue.songs.length === 0) {
      queue.player.stop();
      queues.delete(message.guild.id);
      const connection = getVoiceConnection(message.guild.id);
      if (connection) connection.destroy();
    } else {
      queue.player.stop(true);
      playNext(message.guild.id);
    }
  }

  if (command === 'remove' || command === 'rm') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) return message.reply('The queue is empty.');

    const pos = parseInt(args[0]);
    if (isNaN(pos) || pos < 1 || pos > queue.songs.length) {
      return message.reply(`Please provide a position between 1 and ${queue.songs.length}.`);
    }
    if (pos === 1) {
      return message.reply('That\'s the current song â use `!skip` to skip it.');
    }

    const removed = queue.songs.splice(pos - 1, 1)[0];
    message.channel.send(`ðï¸ Removed position ${pos}: **${removed.title}**`);
  }

  if (command === 'shuffle') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length <= 1) return message.reply('Not enough songs in the queue to shuffle.');

    const current = queue.songs[0];
    const rest = queue.songs.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue.songs = [current, ...rest];
    message.channel.send(`ð Shuffled ${rest.length} songs in the queue.`);
  }

  if (command === 'volume' || command === 'vol') {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply('Nothing is playing.');

    if (!args[0]) {
      return message.channel.send(`ð Current volume: **${queue.volume}%**`);
    }

    const level = parseInt(args[0]);
    if (isNaN(level) || level < 0 || level > 100) {
      return message.reply('Please provide a number between 0 and 100.');
    }

    queue.volume = level;
    const icon = level === 0 ? 'ð' : level < 40 ? 'ð' : 'ð';

    if (queue.songs.length > 0 && queue.startTime) {
      const elapsed = queue.pausedAt
        ? Math.floor((queue.pausedAt - queue.startTime) / 1000)
        : Math.floor((Date.now() - queue.startTime) / 1000);
      queue.player.stop(true);
      await playNext(message.guild.id, Math.max(0, elapsed));
    }

    message.channel.send(`${icon} Volume set to **${level}%**`);
  }

  if (command === 'loop') {
    const queue = queues.get(message.guild.id);
    if (!queue) return message.reply('Nothing is playing.');

    const modes = ['off', 'song', 'queue'];
    const next = modes[(modes.indexOf(queue.loop) + 1) % modes.length];
    queue.loop = next;

    const labels = { off: 'â¡ï¸ Loop off', song: 'ð Looping current song', queue: 'ð Looping queue' };
    message.channel.send(labels[next]);
  }

  if (command === 'queue') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply('The queue is empty.');
    }
    const loopLabel = queue.loop === 'song' ? ' ð' : queue.loop === 'queue' ? ' ð' : '';
    const list = queue.songs
      .map((s, i) => `${i === 0 ? 'ð¶' : `${i + 1}.`} **${s.title}** \`[${formatTime(s.durationInSec)}]\``)
      .join('\n');
    message.channel.send(`**Current queue${loopLabel}:**\n${list}`);
  }

  if (command === 'stop') {
    const queue = queues.get(message.guild.id);
    if (queue) {
      killFfmpeg(queue);
      queue.songs = [];
      queue.loop = 'off';
      queue.player.stop();
      queues.delete(message.guild.id);
    }
    const connection = getVoiceConnection(message.guild.id);
    if (connection) connection.destroy();
    message.channel.send('â¹ Stopped playback and cleared the queue.');
  }

  if (command === 'help') {
    message.channel.send([
      '**ðµ Music Bot Commands** (powered by SoundCloud)',
      '',
      '`!play <song name or SoundCloud URL>` â Add to queue and start playing',
      '`!pause` â Pause the current song',
      '`!resume` â Resume playback',
      '`!skip` â Skip the current song',
      '`!stop` â Clear the queue and disconnect',
      '',
      '`!queue` â Show all queued songs with durations',
      '`!remove <#>` / `!rm <#>` â Remove a song by queue position',
      '`!shuffle` â Randomly reorder upcoming songs',
      '`!loop` â Cycle loop mode: off â song â queue',
      '',
      '`!nowplaying` / `!np` â Show title, progress bar and time',
      '`!volume <0â100>` / `!vol` â Set or check the volume',
      '`!help` â Show this message',
    ].join('\n'));
  }
});

client.login(TOKEN);MTUwMTIxOTA1NjcyNjgzOTI5Ng.GkMEew.LMcCXQowg8XR12YDO2vV9CC5PPmE2dl_vDbCig
