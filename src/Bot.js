'use strict';

const config = require('../config');
const async = require('async');
const EventEmitter = require('eventemitter2');
const TeamSpeak = require('node-teamspeak-api');
const Logger = require('cmr1-logger');
const Client = require('./Client');
const Server = require('./Server');
const Channel = require('./Channel');
const Command = require('./Command');

const defaultArgTypes = {
  'number': 'id',
  'string': 'action',
  'function': 'callback',
  'object': (obj) => { return Array.isArray(obj) ? 'options' : 'params' }
};

const registerEvents = [
  'server',
  'textserver',
  'textchannel',
  'textprivate'
];

class Bot extends EventEmitter {
  constructor(options = {}) {
    super();

    this.client = null;
    this.server = null;
    this.channel = null;
    this.commands = {};

    this.options = {
      sid:  process.env.TS3_SID  || options.sid  || '1',
      user: process.env.TS3_USER || options.user || 'serveradmin',
      pass: process.env.TS3_PASS || options.pass || 'password',
      name: process.env.BOT_NAME || options.name || 'Woodhouse',
      channel: process.env.TS3_CHANNEL || options.channel || 'Default Channel',
      host: process.env.TS3_HOST || options.host || '127.0.0.1',
      port: process.env.TS3_PORT || options.port || '10011',
      verbose: !!process.env.BOT_VERBOSE || options.verbose || false
    }

    this.ts3 = new TeamSpeak(this.options.host, this.options.port);

    this.logger = new Logger(this.options);
    this.logger.enableLogging(config.logging);
  }

  init() {
    const { callback } = this._args(arguments);

    this._login(err => {
      if (err) return callback(err);  

      this._join(err => {
        if (err) return callback(err);

        this.emit('ready');

        return callback();
      });
    });

    this.on('ready', () => {
      this.logger.success(`${this.options.name} is ready!`);

      registerEvents.forEach(event => {
        this.logger.debug(`Registering for '${event}' notifications`);
        this.ts3.subscribe({ event });
      });
    });

    this.on('clientmoved', (data) => {
      if (this.channel && data.channel && data.client && data.client.client_unique_identifier !== this.client.client_unique_identifier) {
        if (this.channel.cid === data.channel.cid) {
          this.emit('cliententerchannel', data);
        } else {
          this.emit('clientleftchannel', data);
        }
      }
    });

    this.ts3.on('notify', (event, resp) => {
      this.logger.debug(`Received notification for event: '${event}' with response:`, resp);

      const clientId = resp.invokerid || resp.clid || null;
      const channelId = resp.ctid || resp.cid || null;

      this.getClientById(clientId, (err, client) => {
        if (client) resp.client = client;

        this.getChannelById(channelId, (err, channel) => {
          if (channel) resp.channel = channel;

          this.emit(event, resp);
        });
      });
    });
  }

  getServerGroupByName() {
    const { name, callback } = this._args(arguments, {
      'string': 'name'
    });

    this._query('servergrouplist', (err, resp, req) => {
      if (err) return callback(err);

      const filtered = resp.data.filter(group => group.name === name);

      if (filtered.length > 0) {
        return callback(null, filtered[0]);
      } else {
        return callback(`Unable to find server group: '${name}'`);
      }
    });
  }

  getServer() {
    const { callback } = this._args(arguments);
    
    this._query('serverinfo', (err, resp, req) => {
      if (err) return callback(err);

      const server = resp.data ? new Server({ bot: this, data: resp.data }) : null;

      return callback(null, server);
    });
  }

  getClientById() {
    const { clid, callback } = this._args(arguments, {
      'string': 'clid',
      'number': 'clid'
    });

    if (typeof clid !== 'number') {
      this.logger.debug('Cannot get client without a client id.');
      return callback();
    };
    
    this._query('clientinfo', { clid }, (err, resp, req) => {
      if (err) return callback(err);

      const client = resp.data ? new Client({ bot: this, data: resp.data, clid }) : null;

      if (client.client_unique_identifier !== this.client.client_unique_identifier) {
        this._query('clientdbfind', { pattern: client.client_unique_identifier, '-uid': '' }, (err, resp, req) => {
          if (err) return callback(err);

          client.cldbid = resp.data.cldbid;

          return callback(null, client);
        });
      } else {
        return callback(null, client);
      }
    });
  }

  getClientByName() {
    const { pattern, callback } = this._args(arguments, {
      'string': 'pattern'
    });

    this._query('clientfind', { pattern }, (err, resp, req) => {
      if (err) return callback(err);

      const clientId = Array.isArray(resp.data) ? resp.data[0].clid : resp.data.clid;

      this.getClientById(clientId, callback);
    });
  }

  getChannelById() {
    const { cid, callback } = this._args(arguments, {
      'string': 'cid',
      'number': 'cid'
    });

    if (!cid) {
      this.logger.debug('Cannot get channel without a channel id.');
      return callback();
    };
    
    this._query('channelinfo', { cid }, (err, resp, req) => {
      if (err) return callback(err);

      const channel = resp.data ? new Channel({ bot: this, data: resp.data, cid }) : null;

      return callback(null, channel);
    });
  }

  getChannelByName() {
    const { pattern, callback } = this._args(arguments, {
      'string': 'pattern'
    });

    this._query('channelfind', { pattern }, (err, resp, req) => {
      if (err) return callback(err);

      const channelId = Array.isArray(resp.data) ? resp.data[0].cid : resp.data.cid;

      this.getChannelById(channelId, callback);
    });
  }

  globalCommand(cmd, action) {
    this.command(cmd, action, 0);
  }

  privateCommand(cmd, action) {
    this.command(cmd, action, 1);
  }
  
  channelCommand(cmd, action) {
    this.command(cmd, action, 2);
  }

  serverCommand(cmd, action) {
    this.command(cmd, action, 3);
  }

  command(cmd, action, context=1) {
    if (typeof this.commands[cmd] !== 'undefined') {
      this._error(`Command: '${cmd}' is already registered!`);
    } else {
      this.commands[cmd] = new Command({ 
        bot: this,
        cmd,
        action,
        context
      });
    }
  }

  messageClient(target, msg) {
    this.message(target, msg, 1);
  }

  messageChannel(target, msg) {
    this.message(target, msg, 2);
  }

  messageServer(msg) {
    this.message(this.options.sid, msg, 3);
  }

  message(target, msg, context=3) {
    this._query('sendtextmessage', {
      targetmode: context,
      target: target,
      msg
    }, (err, resp, req) => {
      if (err) return this._error(err);

      this.logger.debug(`Sent message to target: ${target} with context: ${context} => '${msg}'`);
    });
  }

  _args(args, types = {}) {
    const typeMap = Object.assign({}, defaultArgTypes, types);

    const parsed = {};

    Object.keys(args).forEach(index => {
      const argValue = args[index];
      const argType = typeof argValue;

      if (typeMap[argType]) {
        const argName = typeMap[argType];

        if (typeof argName === 'string') {
          parsed[argName] = argValue;
        } else if (typeof argName === 'function') {
          const argKey = argName(argValue);
          parsed[argKey] = argValue;
        } else if (typeof argName !== 'boolean') {
          this._error(`Invalid arg name for type: ${argType}! Arg name must be string or function.`);
        }
      } else if (argType !== 'undefined') {
        this._warn('Unknown argument type: ', argType);
      }
    });

    if (!parsed.callback || typeof parsed.callback !== 'function') {
      this.logger.warn('Invalid/missing callback provided');
      parsed.callback = () => this.logger.debug(arguments);
    }

    this.logger.debug('Processing raw args:', args);
    this.logger.debug('Parsed args:', parsed);

    return parsed;
  }

  _query() {
    const { action, params, callback } = this._args(arguments);

    this.ts3.send(action, params, (err, resp, req) => {
      this.logger.debug(`Query: ${action} with params: ${JSON.stringify(params)}`);

      if (err) {
        this._error(`Action failed! Action: ${action} | Params: ${JSON.stringify(params)}`, err);
        return callback(err);
      }

      this.logger.debug('Request:', JSON.stringify(req, null, 2));
      this.logger.debug('Response:', JSON.stringify(resp, null, 2));

      this.emit('action', {
        req,
        resp,
        action,
      });

      if (resp.status !== 'ok') {
        this._warn('Bad Response!', req, resp);
      }

      return callback(null, resp, req);
    });
  }

  _login() {
    const { callback, params } = this._args(arguments);

    if (params) {
      if (params.user) {
        this.options.user = params.user;
      }

      if (params.pass) {
        this.options.pass = params.pass;
      }
    }

    const login_params = {
      client_login_name: this.options.user,
      client_login_password: this.options.pass
    };

    this.logger.log(`Attempting to login as user: ${this.options.user}`);

    this._query('login', login_params, (err, resp, req) => {
      if (err) callback(err);

      this.logger.log('Authenticated.');

      this._query('whoami', (err, resp, req) => {
        if (err) return callback(err);

        this.getClientById(resp.data.clid, (err, client) => {
          if (err) return callback(err);

          this.client = resp.data;

          this.logger.debug('Loaded bot client info:', this.client);

          this._use(err => {
            if (err) return callback(err);

            this._query('clientupdate', { client_nickname: this.options.name }, (err, resp, req) => {
              if (err) return callback(err);

              this.logger.debug(`Set bot name to: ${this.options.name}`);
        
              return callback();
            });
          });
        });
      });
    });
  }

  _use() {
    const { callback } = this._args(arguments);

    this.logger.log(`Attempting to use virtual server: ${this.options.sid}`);

    const use_params = {
      sid: this.options.sid
    };

    this._query('use', use_params, (err, resp, req) => {
      if (err) return callback(err);

      this.logger.log('Using virtual server.');

      this.getServer((err, server) => {
        if (err) return callback(err);

        this.server = server;

        return callback();
      });
    });
  }

  _join() {
    const { callback, params } = this._args(arguments);

    if (params && params.channel) {
      this.options.channel = params.channel;
    }

    this.logger.log(`Attempting to find & join channel: ${this.options.channel}`);

    const channel_find_params = { pattern: this.options.channel };

    this._query('channelfind', channel_find_params, (err, resp, req) => {
      if (err) return callback(err);

      this.logger.log('Channel found.');
      
      this.getChannelById(resp.data.cid, (err, channel) => {
        if (err) return callback(err);

        this.ts3.subscribe({ event: 'channel', id: channel.cid });        

        this._query('clientmove', { clid: this.client.client_id, cid: channel.cid }, (err, resp, req) => {
          if (err && err.error_id && err.error_id === 770) {
            this.logger.warn(`Already member of channel: ${this.options.channel}`);
          } else if (err) {
            return callback(err);
          }

          this.channel = channel;

          this.logger.log('Channel joined.');

          this.emit('join', this.channel);

          return callback();
        });
      });
    });
  }

  _warn(msg) {
    this.emit('warning', msg);
    this.logger.warn(msg);
  }

  _error(err) {
    this.emit('failure', err);
    this.logger.error(err);
  }
}

module.exports = Bot;