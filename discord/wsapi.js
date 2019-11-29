"use strict";
const UTILS = new (require("../utils/utils.js"))();
const REQUEST = require("request");
const ws = require("ws");
const fs = require("fs");
const agentOptions = { ca: fs.readFileSync("../data/keys/ca.crt") };
let embedgenerator = new (require("./embedgenerator.js"))();
let Preferences = require("./preferences.js");
let LOLAPI = require("../utils/lolapi.js");
let WSMM = require("../utils/wsmessagemanager.js");
module.exports = class WSAPI {
	/*
	Used for internal communication between shards and IAPI.
	For requests used to process commands, use the lolapi.js file.
	Client sends odd values, server sends even values.
	Sample ws message:
	{
		type: 4,
		id: 0,//shard ID
		emojis: [...]
	}
	type table:
		0: heartbeat request
		1: heartbeat

		2: IAPI stats
		3: shard stats

		4: IAPI broadcasts champ emojis
		5: shard sends whatever emojis it can see

		6: IAPI wants to send a message to a server channel
		7: shard wants to send a message to a server channel

		8: IAPI wants to send a message to a server's default
		9: shard wants to send a message to a server's default

		10: IAPI wants to send a PM
		11: shard wants to send a PM

		12: IAPI wants to send a message to all servers' defaults
		13: shard wants to send a message to all servers' defaults

		14: IAPI wants to update shards with new ban information on users
		15: shard wants to retrieve user bans

		16: IAPI wants to update shards with new ban information on servers
		17: shard wants to retrieve server bans

		18: IAPI wants to issue server ban message and leave server
		19: unimplemented

		20: IAPI asks if shard can see user (user ban/warn step 1)
		21: shard response with whether or not user is in cache (user ban/warn step 2)

		22: IAPI wants to send user a ban message (user ban step 3)
		23: unimplemented

		24: IAPI wants to send user a warning message (user warn step 3)
		25: unimplemented

		26: IAPI wants to issue server warning message
		27: unimplemented

		28: IAPI wants to send user an unban message
		29: unimplemented

		30: IAPI wants to send server an unban message
		31: unimplemented

		32: IAPI wants to PM embed to user
		33: shard wants to PM embed to user

		34: IAPI wants to send an embed
		35: shard wants to send an embed

		36: IAPI response to shard ping
		37: shard wants to ping IAPI

		38: IAPI wants to respond to shard LoL api request
		39: shard LoL API request via ws

		40: IAPI wants shard to run tracking eligibility check (population, permissions)
		41: shard responds with (users in role, permissions valid per cid, population)

		42: IAPI wants shard to report eligible servers and channels for tracking
		43: shard responds with { sid: { cid: true }}

		44: IAPI wants shard to report eligible channels for tracking
		45: shard responds with { cid: true } if server exists
	*/
	constructor(INIT_CONFIG, discord_client, INIT_STATUS) {
		this.client = discord_client;
		this.wsmm = new WSMM();
		this.STATUS = INIT_STATUS;
		this.CONFIG = INIT_CONFIG;
		if (!UTILS.exists(this.CONFIG)) throw new Error("config.json required.");
		this.request = REQUEST;
		this.address = "wss://" + this.CONFIG.API_ADDRESS;
		this.port = this.CONFIG.API_PORT;
		UTILS.debug("wss address attempted: " + this.address + ":" + this.port + "/shard?k=" + encodeURIComponent(this.CONFIG.API_KEY) + "&id=" + process.env.SHARD_ID);
		this.connect();
		setInterval(() => {
			if (this.connection.readyState > 1) this.connect();
		}, 30000);
		this.connection.on("open", () => {
			UTILS.output("ws connected");
		});
		this.connection.on("close", (code, reason) => {
			UTILS.output("ws closed: " + code + ", " + reason);
		});
		this.connection.on("message", data => {
			//UTILS.debug(data);
			data = JSON.parse(data);
			UTILS.debug("ws message received: type: " + data.type);
			const that = this;
			switch(data.type) {//client receives even values only
				case 0://reserved/heartbeat
					this.send({ type: 1, received: new Date().getTime() });
					break;
				case 2://reserved/stat
				case 4://emoji
					let all_emojis = data.emojis;
					for (let b in this.CONFIG.STATIC.CHAMPIONS) {
						const candidate = all_emojis.find(e => this.CONFIG.STATIC.CHAMPIONS[b].id.toLowerCase() == e.name);
						this.CONFIG.STATIC.CHAMPIONS[b].emoji = UTILS.exists(candidate) ? candidate.code : this.CONFIG.STATIC.CHAMPIONS[b].name;
					}
					UTILS.output("champion emojis registered");
					this.STATUS.CHAMPION_EMOJIS = true;
					break;
				case 6://send message to channel
					if (true) {//scope limiter
						const candidate = this.client.channels.get(data.cid);
						if (UTILS.exists(candidate)) {
							candidate.send(data.content).catch(console.error);
							UTILS.debug("message sent to " + data.cid);
						}
					}
					break;
				case 8://send message to default channel in server
				case 10://send message to user
				case 12:
					const notification = embedgenerator.notify(this.CONFIG, data.content, data.username, data.displayAvatarURL, data.release);
					this.client.guilds.forEach(g => {
						let candidate = UTILS.preferredTextChannel(that.client, g.channels, "text", UTILS.defaultChannelNames(), ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"]);
						if (UTILS.exists(candidate)) {
							new Preferences(new LOLAPI(this.CONFIG, 0, this), g, preferences => {
								if (!data.release || (data.release && preferences.get("release_notifications"))) candidate.send("", { embed: notification }).catch(console.error);
							});
						}
					});
					break;
				case 14:
					this.CONFIG.BANS.USERS = data.bans;
					break;
				case 16:
					this.CONFIG.BANS.SERVERS = data.bans;
					break;
				case 18:
					if (UTILS.exists(this.client.guilds.get(data.sid))) {
						const notification = embedgenerator.serverBan(this.CONFIG, this.client.guilds.get(data.sid), data.reason, data.date, data.issuer_tag, data.issuer_avatarURL);
						let candidate = UTILS.preferredTextChannel(this.client, this.client.guilds.get(data.sid).channels, "text", UTILS.defaultChannelNames(), ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"]);
						if (UTILS.exists(candidate)) candidate.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry: Server notified in channel " + candidate.name);
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry: Server could not be notified");
						});
						this.client.guilds.get(data.sid).owner.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry: Owner notified");
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry: Owner could not be notified");
						});
					}
					break;
				case 20:
					data.connected = UTILS.exists(this.client.users.get(data.uid)) ? true : false;
					data.type = 21;
					this.send(data);
					break;
				case 22:
					this.client.users.get(data.uid).send(embedgenerator.userBan(this.CONFIG, data.reason, data.date, data.issuer_tag, data.issuer_avatarURL)).then(() => {
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry: User notified");
					}).catch(e => {
						console.error(e);
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry: User could not be notified");
					});
					break;
				case 24:
					this.client.users.get(data.uid).send(embedgenerator.userWarn(this.CONFIG, data.reason, data.issuer_tag, data.issuer_avatarURL)).then(() => {
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::warning: User notified");
					}).catch(e => {
						console.error(e);
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::warning: User could not be notified");
					});
					break;
				case 26:
					if (UTILS.exists(this.client.guilds.get(data.sid))) {
						const notification = embedgenerator.serverWarn(this.CONFIG, this.client.guilds.get(data.sid), data.reason, data.issuer_tag, data.issuer_avatarURL);
						let candidate = UTILS.preferredTextChannel(this.client, this.client.guilds.get(data.sid).channels, "text", UTILS.defaultChannelNames(), ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"]);
						if (UTILS.exists(candidate)) candidate.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::warning: Server notified in channel " + candidate.name);
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::warning: Server could not be notified");
						});
						this.client.guilds.get(data.sid).owner.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::warning: Owner notified");
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::warning: Owner could not be notified");
						});
					}
					break;
				case 28:
					this.client.users.get(data.uid).send(embedgenerator.userUnban(this.CONFIG, data.issuer_tag, data.issuer_avatarURL)).then(() => {
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry_sign: User notified");
					}).catch(e => {
						console.error(e);
						that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry_sign: User could not be notified");
					});
					break;
				case 30:
					if (UTILS.exists(this.client.guilds.get(data.sid))) {
						const notification = embedgenerator.serverUnban(this.CONFIG, this.client.guilds.get(data.sid), data.issuer_tag, data.issuer_avatarURL);
						let candidate = UTILS.preferredTextChannel(this.client, this.client.guilds.get(data.sid).channels, "text", UTILS.defaultChannelNames(), ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"]);
						if (UTILS.exists(candidate)) candidate.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry_sign: Server notified in channel " + candidate.name);
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry_sign: Server could not be notified");
						});
						this.client.guilds.get(data.sid).owner.send("", { embed: notification }).then(() => {
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":e_mail::no_entry_sign: Owner notified");
						}).catch(e => {
							console.error(e);
							that.sendTextToChannel(that.CONFIG.LOG_CHANNEL_ID, ":x::no_entry_sign: Owner could not be notified");
						});
					}
					break;
				case 32:
					this.client.users.get(data.uid).send(embedgenerator.raw(data.embed)).then(() => {
						that.sendTextToChannel(that.CONFIG.FEEDBACK.EXTERNAL_CID, ":e_mail: User notified");
					}).catch(e => {
						console.error(e);
						that.sendTextToChannel(that.CONFIG.FEEDBACK.EXTERNAL_CID, ":x::warning: User could not be notified");
					});
					break;
				case 34:
					if (true) {//scope limiter
						const candidate = this.client.channels.get(data.cid);
						if (UTILS.exists(candidate)) {
							let embed = embedgenerator.raw(data.embed);
							candidate.send(embed).then(msg => {
								if (data.approvable) {
									setTimeout(() => {
										embed.fields[embed.fields.length - 1].value += "\nApprove: `" + this.CONFIG.DISCORD_COMMAND_PREFIX + "approve " + msg.id + "`";
										msg.edit({ embed }).catch(console.error);
									}, 5000);
								}
							}).catch(console.error);
							UTILS.debug("embed sent to " + data.cid);
						}
					}
					break;
				case 36:
					this.end_time = new Date().getTime();
					this.pingcb({ started: this.start_time, ended: this.end_time });
					break;
				case 38:
					this.wsmm.wsMessageCallback(data);
					break;
				case 42:
					let ans = {};
					this.client.guilds.forEach(g => {
						ans[g.id] = {};
						g.channels.forEach(c => {
							if (c.type === "text" && c.permissionsFor(this.client.user).has(["EMBED_LINKS", "VIEW_CHANNEL", "SEND_MESSAGES"])) ans[g.id][c.id] = true;
							else ans[g.id][c.id] = false;
						});
					});
					data.id_map = ans;
					data.type = 43;
					this.send(data);
					break;
				case 44:
					if (true) {
						let ans = {};
						let candidate = this.client.guilds.get(data.sid);
						if (UTILS.exists(candidate)) {
							candidate.channels.forEach(c => {
								if (c.type === "text" && c.permissionsFor(this.client.user).has(["EMBED_LINKS", "VIEW_CHANNEL", "SEND_MESSAGES"])) ans[c.id] = true;
							});
							data.id_map = ans;
						}
						else {
							data.id_map = null;
						}
						data.type = 45;
						this.send(data);
					}
					break;
				default:
					UTILS.output("ws encountered unexpected message type: " + data.type + "\ncontents: " + JSON.stringify(data, null, "\t"));
			}
		});
	}
	sendEmojis(emojis) {
		this.send({ type: 5, emojis });
	}
	sendTextToChannel(cid, content) {
		if (UTILS.exists(this.client.channels.get(cid))) this.client.channels.get(cid).send(content).catch(console.error);
		else this.send({ type: 7, content, cid });
	}
	sendEmbedToChannel(cid, embed, approvable = false) {
		embed = UTILS.embedRaw(embed);
		if (UTILS.exists(this.client.channels.get(cid))) this.client.channels.get(cid).send(embedgenerator.raw(embed)).then(msg => {
			if (approvable) {
				setTimeout(() => {
					embed.fields[embed.fields.length - 1].value += "\nApprove: `" + this.CONFIG.DISCORD_COMMAND_PREFIX + "approve " + msg.id + "`";
					msg.edit({ embed }).catch(console.error);
				}, 5000);
			}
		}).catch(console.error);
		else this.send({ type: 35, embed, cid, approvable });
	}
	lnotify(username, displayAvatarURL, content, release) {
		this.send({ type: 13, content, username, displayAvatarURL, release });
	}
	getUserBans() {
		this.send({ type: 15 });
	}
	getServerBans() {
		this.send({ type: 17 });
	}
	iapiLoLRequest(region, tag, endpoint, maxage, cachetime, request_id) {
		let p = this.wsmm.get();
		this.send({ type: 39, wsm_ID: p.request_ID, region, tag, endpoint, maxage, cachetime, request_id });
		return p.promise;
	}
	send(raw_object) {
		let that = this;
		raw_object.id = parseInt(process.env.SHARD_ID);
		if (this.connection.readyState != 1) {
			this.connect();
			setTimeout(() => {
				that.send(raw_object);
			}, 10000);
		}
		else this.connection.send(JSON.stringify(raw_object));
	}
	embedPM(uid, embed) {
		embed = UTILS.embedRaw(embed);
		this.send({ type: 33, uid, embed });
	}
	connect() {
		this.connection = new ws(this.address + ":" + this.port + "/shard?k=" + encodeURIComponent(this.CONFIG.API_KEY) + "&id=" + process.env.SHARD_ID, agentOptions);
	}
	connected() {
		return this.connection.readyState == 1;
	}
	ping(cb) {
		this.pingcb = cb;
		this.start_time = new Date().getTime();
		this.send({ type: 37 });
	}
}
