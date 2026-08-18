const { Client, Intents } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const readline = require('readline');
const fs = require('fs');
const colors = require('colors');
const rawConfig = require('./config.json');

process.removeAllListeners('warning');

const PLACEHOLDER_PATTERN = /YOUR_TOKEN|YOUR_/i;
const BASE_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 60000;
const MONITOR_INTERVAL_MS = 5000;
const MENU_REDRAW_KEY = '9';

const accountsConfig = rawConfig.accounts
  ? rawConfig.accounts
  : [{
      name: 'Account 1',
      token: rawConfig.TOKEN,
      guildId: rawConfig.GUILD_ID || rawConfig.SUNUCU_ID,
      voiceChannelId: rawConfig.VOICE_CHANNEL_ID || rawConfig.SES_KANAL_ID,
    }];

if (!accountsConfig.length) {
  console.error(colors.red('At least one account must be defined in config.json.'));
  process.exit(1);
}

// ─── Logging ────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream('log.txt', { flags: 'a' });

const log = (text) => {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${text}\n`);
};

['log', 'warn', 'error'].forEach((method) => {
  const original = console[method];
  console[method] = function (...args) {
    const message = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    log(message);
    original.apply(console, args);
  };
});

// ─── AccountSession ─────────────────────────────────────────────────────────

class AccountSession {
  constructor(config, index) {
    this.index = index;
    this.name = config.name || `Account ${index + 1}`;
    this.token = (config.token || config.TOKEN || '').trim();
    this.guildId = config.guildId || config.SUNUCU_ID;
    this.voiceChannelId = config.voiceChannelId || config.SES_KANAL_ID;
    this.voiceGroup = `account-${index + 1}`;

    this.ready = false;
    this.loginFailed = false;
    this.disabled = false;
    this.wantsVoice = false;
    this.manuallyLeft = true;
    this.connecting = false;
    this.rejoinNotified = false;
    this.startTime = null;
    this.lastReconnectAttempt = 0;
    this.reconnectDelay = BASE_RECONNECT_MS;
    this.monitorInterval = null;

    if (!this.token || PLACEHOLDER_PATTERN.test(this.token)) {
      this.disabled = true;
      console.log(colors.gray(`[${this.name}] No token configured, skipping.`));
      return;
    }

    this.client = new Client({
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_VOICE_STATES],
    });

    this.client.on('ready', () => {
      this.ready = true;
      console.log(colors.green(`[${this.label}] Logged in.`));
    });
  }

  get label() {
    return this.client?.user?.tag || this.name;
  }

  get statusText() {
    if (this.disabled) return 'No token';
    if (this.loginFailed) return 'Login failed';
    if (!this.ready) return 'Connecting...';
    if (this.connecting) return 'Joining voice...';
    if (this.wantsVoice && this.startTime) {
      const elapsed = Date.now() - this.startTime;
      const s = String(Math.floor((elapsed / 1000) % 60)).padStart(2, '0');
      const m = String(Math.floor((elapsed / 60000) % 60)).padStart(2, '0');
      const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
      return `In voice (${h}:${m}:${s})`;
    }
    return 'Ready';
  }

  isActive() {
    return !this.disabled && !this.loginFailed;
  }

  async connectToVoice({ silent = false } = {}) {
    if (!this.isActive() || !this.ready || this.connecting) return false;

    this.connecting = true;
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = await guild.channels.fetch(this.voiceChannelId);
      if (!channel || channel.type !== 'GUILD_VOICE') {
        throw new Error('Voice channel not found.');
      }

      joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        group: this.voiceGroup,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      this.wantsVoice = true;
      this.manuallyLeft = false;
      this.rejoinNotified = false;
      this.reconnectDelay = BASE_RECONNECT_MS;
      if (!this.startTime) this.startTime = Date.now();

      if (!silent) {
        console.log(colors.green(`[${this.label}] Joined voice channel.`));
      }
      return true;
    } catch (err) {
      console.error(colors.red(`[${this.label}] Error: ${err.message}`));
      return false;
    } finally {
      this.connecting = false;
    }
  }

  leaveVoice() {
    const connection = getVoiceConnection(this.guildId, this.voiceGroup);
    if (connection) connection.destroy();

    this.wantsVoice = false;
    this.manuallyLeft = true;
    this.connecting = false;
    this.rejoinNotified = false;
    this.startTime = null;
    this.reconnectDelay = BASE_RECONNECT_MS;
    console.log(colors.yellow(`[${this.label}] Left voice channel.`));
  }

  async listUsers() {
    if (!this.isActive() || !this.ready) {
      console.log(colors.gray(`[${this.name}] Account is not active.`));
      return;
    }
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = await guild.channels.fetch(this.voiceChannelId);
      const members = [...channel.members.values()];
      console.log(colors.cyan(`\n[${this.label}] Users in voice channel:`));
      members.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.user.tag}`);
      });
    } catch (err) {
      console.error(colors.red(`[${this.label}] Could not list users: ${err.message}`));
    }
  }

  async showInfo() {
    if (!this.isActive() || !this.ready) {
      console.log(colors.gray(`[${this.name}] Account is not active.`));
      return;
    }
    try {
      const guilds = await this.client.guilds.fetch();
      console.log(colors.cyan(`\n[${this.label}] Account Info:`));
      console.log(`  - User: ${this.client.user.tag}`);
      console.log(`  - ID: ${this.client.user.id}`);
      console.log(`  - Servers: ${guilds.size}`);
      console.log(`  - Status: ${this.statusText}`);
      console.log(`  - Created: ${this.client.user.createdAt.toLocaleString()}`);
    } catch (err) {
      console.error(colors.red(`[${this.label}] Could not fetch info: ${err.message}`));
    }
  }

  startMonitor() {
    if (this.disabled || this.monitorInterval) return;

    this.monitorInterval = setInterval(async () => {
      if (!this.isActive() || !this.ready || !this.wantsVoice || this.manuallyLeft) return;
      if (this.connecting) return;

      const now = Date.now();
      if (now - this.lastReconnectAttempt < this.reconnectDelay) return;

      try {
        const guild = await this.client.guilds.fetch(this.guildId);
        const me = await guild.members.fetch(this.client.user.id);
        const inVoice = me.voice.channelId === this.voiceChannelId;

        if (inVoice) {
          this.rejoinNotified = false;
          this.reconnectDelay = BASE_RECONNECT_MS;
          if (!this.startTime) this.startTime = Date.now();
          return;
        }

        this.lastReconnectAttempt = now;
        if (!this.rejoinNotified) {
          console.log(colors.yellow(`[${this.label}] Disconnected from voice, reconnecting...`));
          this.rejoinNotified = true;
        }

        await this.connectToVoice({ silent: true });

        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_MS);
      } catch (err) {
        console.error(colors.red(`[${this.label}] Monitor error: ${err.message}`));
      }
    }, MONITOR_INTERVAL_MS);
  }

  stopMonitor() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  login() {
    if (this.disabled) return Promise.resolve();
    return this.client.login(this.token).catch((err) => {
      this.loginFailed = true;
      console.error(colors.red(`[${this.name}] Login failed: ${err.message}`));
    });
  }
}

// ─── App State ──────────────────────────────────────────────────────────────

const sessions = accountsConfig.map((cfg, i) => new AccountSession(cfg, i));
let selectedIndex = null;

function getActiveSessions() {
  return sessions.filter((s) => s.isActive());
}

function getTargetSessions() {
  const active = getActiveSessions();
  if (selectedIndex === null) return active;
  const selected = sessions[selectedIndex];
  return selected?.isActive() ? [selected] : [];
}

// ─── Title Bar ──────────────────────────────────────────────────────────────

function updateTitle() {
  const active = sessions.filter((s) => s.wantsVoice && s.startTime);
  if (!active.length) {
    process.title = selectedIndex === null
      ? 'Discord AFK - Ready'
      : `[${sessions[selectedIndex].name}] Ready`;
    return;
  }
  const summary = active.map((s) => {
    const elapsed = Date.now() - s.startTime;
    const m = String(Math.floor(elapsed / 60000)).padStart(2, '0');
    const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    return `${s.name}:${h}h${m}m`;
  }).join(' | ');
  process.title = summary.slice(0, 240);
}

setInterval(updateTitle, 1000);

// ─── Menu ───────────────────────────────────────────────────────────────────

function clearScreen() {
  console.clear();
}

function drawMenu() {
  clearScreen();
  const targetLabel = selectedIndex === null
    ? 'All Accounts'
    : sessions[selectedIndex].name;

  console.log(colors.bold('\nDiscord Voice AFK - Multi Account\n'));
  console.log(`Active target: ${colors.cyan(targetLabel)}\n`);
  console.log('Accounts:');
  sessions.forEach((s, i) => {
    console.log(`  [h${i + 1}] ${s.name} - ${s.statusText}`);
  });

  console.log('\nMenu:\n');
  console.log('[1] Join Voice (selected target)');
  console.log('[2] Leave Voice (selected target)');
  console.log('[3] List Users in Channel');
  console.log('[4] Show Account Info');
  console.log('[5] Change Target (all / single account)');
  console.log('[6] Remove Single Account from Voice');
  console.log(`[${MENU_REDRAW_KEY}] Refresh Menu\n`);
  console.log(colors.gray('Note: Auto-reconnect only works after joining via [1].\n'));
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function connectSelected() {
  const targets = getTargetSessions();
  if (!targets.length) {
    console.log(colors.red('\nNo active accounts to connect. Check your tokens.\n'));
    return;
  }
  for (const session of targets) {
    session.manuallyLeft = false;
    session.wantsVoice = true;
    await session.connectToVoice();
  }
}

async function leaveSelected() {
  for (const session of getTargetSessions()) {
    session.leaveVoice();
  }
}

async function listSelectedUsers() {
  for (const session of getTargetSessions()) {
    await session.listUsers();
  }
}

async function showSelectedInfo() {
  for (const session of getTargetSessions()) {
    await session.showInfo();
  }
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function promptAccountSelection(rl) {
  console.log('\nSelect target account:');
  console.log('[0] All accounts');
  sessions.forEach((s, i) => {
    console.log(`[${i + 1}] ${s.name}`);
  });
  console.log('\nEnter your choice (0 = all):');

  rl.once('line', (input) => {
    const choice = input.trim();
    if (choice === '0') {
      selectedIndex = null;
      console.log(colors.green('\nTarget: All accounts'));
    } else {
      const index = Number(choice) - 1;
      if (index >= 0 && index < sessions.length) {
        selectedIndex = index;
        console.log(colors.green(`\nTarget: ${sessions[index].name}`));
      } else {
        console.log(colors.red('\nInvalid account selection.'));
      }
    }
  });
}

function promptLeaveSingleAccount(rl) {
  const active = getActiveSessions();
  if (!active.length) {
    console.log(colors.red('\nNo active accounts found.\n'));
    return;
  }

  console.log('\nSelect account to remove from voice:');
  sessions.forEach((s, i) => {
    if (!s.isActive()) return;
    const voiceStatus = s.wantsVoice && !s.manuallyLeft
      ? colors.green('In voice')
      : colors.gray('Not in voice');
    console.log(`[${i + 1}] ${s.name} - ${voiceStatus}`);
  });
  console.log('\nEnter account number:');

  rl.once('line', async (input) => {
    const index = Number(input.trim()) - 1;
    if (index < 0 || index >= sessions.length || !sessions[index].isActive()) {
      console.log(colors.red('\nInvalid account selection.'));
      return;
    }

    const session = sessions[index];
    if (!session.wantsVoice || session.manuallyLeft) {
      console.log(colors.yellow(`\n[${session.name}] is already not in voice.`));
    } else {
      session.leaveVoice();
      console.log(colors.green(`\n[${session.name}] removed from voice. Other accounts remain in voice.`));
    }
  });
}

// ─── Input Handler ──────────────────────────────────────────────────────────

function handleInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', async (input) => {
    const value = input.trim().toLowerCase();

    if (value.startsWith('h') && value.length > 1) {
      const index = Number(value.slice(1)) - 1;
      if (index >= 0 && index < sessions.length) {
        selectedIndex = index;
        console.log(colors.green(`\nTarget account: ${sessions[index].name}`));
      } else {
        console.log(colors.red('\nInvalid account number.'));
      }
      return;
    }

    switch (value) {
      case '1':
        await connectSelected();
        break;
      case '2':
        await leaveSelected();
        break;
      case '3':
        await listSelectedUsers();
        break;
      case '4':
        await showSelectedInfo();
        break;
      case '5':
        promptAccountSelection(rl);
        break;
      case '6':
        promptLeaveSingleAccount(rl);
        break;
      case MENU_REDRAW_KEY:
        drawMenu();
        break;
      default:
        console.log(colors.red('\nInvalid selection. Choose a menu option.\n'));
        break;
    }
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  const activeCount = getActiveSessions().length;
  console.log(colors.cyan(`\n${sessions.length} accounts configured, ${activeCount} active.\n`));

  await Promise.all(sessions.map((s) => s.login()));
  sessions.forEach((s) => s.startMonitor());

  drawMenu();
  handleInput();
}

start();
