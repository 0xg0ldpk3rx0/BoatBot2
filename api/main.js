"use strict";
const fs = require("fs");
const argv_options = new (require("getopts"))(process.argv.slice(2), {
	alias: { c: ["config"] },
	default: { c: "config.json" }});
let CONFIG;
try {
	CONFIG = JSON.parse(fs.readFileSync("../" + argv_options.config, "utf-8"));
	CONFIG.VERSION = "v1.3.0b";//b for non-release (in development)
}
catch (e) {
	console.log("something's wrong with config.json");
	console.error(e);
	process.exit(1);
}

let path = require('path');
let crypto = require("crypto");
let https = require('https');
let LoadAverage = require("../loadaverage.js");
const response_type = ["Total", "Uncachable", "Cache hit", "Cache hit expired", "Cache miss"];
const load_average = [new LoadAverage(60), new LoadAverage(60), new LoadAverage(60), new LoadAverage(60), new LoadAverage(60)];
const express = require("express");
const website = express();

const UTILS = new (require("../utils.js"))();
let Profiler = require("../timeprofiler.js");
let request = require("request");
let wsRoutes = require("./websockets.js");
let routes = require("./routes.js");
UTILS.assert(UTILS.exists(CONFIG.API_PORT));
UTILS.output("Modules loaded.");
let apicache = require("mongoose");
apicache.connect("mongodb://localhost/apicache");//cache of summoner object name lookups
apicache.connection.on("error", function (e) { throw e; });
let api_doc = new apicache.Schema({
	url: String,
	response: String,
	expireAt: Date
});
api_doc.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
api_doc.index({ url: "hashed" });
let api_doc_model = apicache.model("api_doc_model", api_doc);
let shortcut_doc = new apicache.Schema({
	uid: String,
	shortcuts: { type: apicache.Schema.Types.Mixed, default: {} },
	username: String
}, { minimize: false });
shortcut_doc.index({ uid: "hashed" });
let shortcut_doc_model = apicache.model("shortcut_doc_model", shortcut_doc);
let disciplinary_doc = new apicache.Schema({
	user: { type: Boolean, required: true },//true for user, false for server
	ban: { type: Boolean, required: true },//true for ban, false for warning/other note
	target_id: { type: String, required: true },//target id: uid or sid
	reason: { type: String, required: true },//text reason for disciplinary action
	date: { type: Date, required: true },//new Date() set to 0 if permanent, set to date values for temporary
	active: { type: Boolean, required: true },//false if overridden or warning
	issuer_id: { type: String, required: true }//uid for the person who issued the ban
});
disciplinary_doc.index({ target_id: "hashed" });//direct username lookups
disciplinary_doc.index({ issuer_id: "hashed" });//direct issuer lookups
//disciplinary_doc.index({ target_id: 1 });//ranged username lookups
disciplinary_doc.index({ active: 1, date: 1, user: 1, ban: 1 });//actives for broadcast to shards
let disciplinary_model = apicache.model("disciplinary_model", disciplinary_doc);
let region_limiters = {};
let limiter = require("bottleneck");
for (let b in CONFIG.REGIONS) region_limiters[CONFIG.REGIONS[b]] = new limiter({ maxConcurrent: 1, minTime: CONFIG.API_PERIOD });
let req_num = 0;
let irs = {};//individual request statistics
let database_profiler = new Profiler("Database Profiler");
let server = https.createServer({ key: fs.readFileSync("../data/keys/server.key"), 
		cert: fs.readFileSync("../data/keys/server.crt"), 
		ca: fs.readFileSync("../data/keys/ca.crt")}, website).listen(CONFIG.API_PORT);
UTILS.output("IAPI " + process.env.NODE_ENV + " mode ready and listening on port " + CONFIG.API_PORT);
let websocket = require("express-ws")(website, server);
website.use(function (req, res, next) {
	res.removeHeader("X-Powered-By");
	return next();
});
const HEARTBEAT_INTERVAL = 60000;
let shard_ws = {};
let ws_request_id = 0;
let message_handlers = {};
website.ws("/shard", (ws, req) => {
	UTILS.debug("/shard reached");
	if (!UTILS.exists(req.query.k)) return ws.close(4401);//unauthenticated
	if (req.query.k !== CONFIG.API_KEY) return ws.close(4403);//wrong key
	UTILS.debug("ws connected $" + req.query.id);
	shard_ws[req.query.id] = ws;
	//send bans
	ws.on("message", data => {
		data = JSON.parse(data);
		UTILS.debug("ws message received: $" + data.id + " type: " + data.type);
		wsRoutes(CONFIG, ws, shard_ws, data, shardBroadcast, sendToShard, getBans);
		if (UTILS.exists(data.request_id) && UTILS.exists(message_handlers[data.request_id])) {
			let nMsg = UTILS.copy(data);
			delete nMsg.request_id;
			message_handlers[data.request_id](nMsg);
			delete message_handlers[data.request_id];
		}
		for (let b in message_handlers) if (parseInt(b.substring(0, b.indexOf(":"))) < new Date().getTime() - (15 * 60 * 1000)) delete message_handlers[b];//cleanup old message handlers
	});
	ws.on("close", (code, reason) => {
		UTILS.output("ws $" + req.query.id + " closed: " + code + ", " + reason);
	});
	//ws.close(4200);//OK
});
function sendExpectReplyRaw(message, destination, callback) {
	let request = UTILS.copy(message);
	if (request.request_id != undefined) throw new Error("request.request_id must be undefined for send and receive");
	++ws_request_id;
	request.request_id = new Date().getTime() + ":" + ws_request_id;
	message_handlers[request.request_id] = callback;
	sendToShard(request, destination);
	UTILS.debug("request " + ws_request_id + " sent with contents" + JSON.stringify(request, null, "\t"));
}
function sendExpectReply(message, destination, timeout = 5000) {
	return new Promise((resolve, reject) => {
		sendExpectReplyRaw(message, destination, resolve);
		setTimeout(function () {
			reject(new Error("timed out waiting for response from shard"));
		}, timeout);
	});
}
function sendExpectReplyBroadcast(message, timeout = 5000) {
	let shard_numbers = [];
	for (let i = 0; i < CONFIG.SHARD_COUNT; ++i) shard_numbers.push(i);
	return Promise.all(shard_numbers.map(n => sendExpectReply(message, n)));
}

setInterval(() => {
	shardBroadcast({ type: 0 });
}, HEARTBEAT_INTERVAL);
function shardBroadcast(message, exclusions = []) {
	for (let i = 0; i < CONFIG.SHARD_COUNT; ++i) if (exclusions.indexOf(i) == -1) sendToShard(message, i);
	UTILS.debug("ws broadcast message sent: type: " + message.type);
}
function sendToShard(message, id, callback) {
	if (UTILS.exists(shard_ws[id + ""]) && shard_ws[id + ""].readyState == 1) shard_ws[id + ""].send(JSON.stringify(message), callback);
}
function getBans(user, callback) {
	disciplinary_model.find({ user, ban: true, active: true, $or: [{ date : { $eq: new Date(0) } }, { date: { $gte: new Date() } }] }, "target_id date", (err, docs) => {
		if (err) console.error(err);
		let bans = {};
		docs.forEach(ban => {
			if (!UTILS.exists(bans[ban.target_id])) bans[ban.target_id] = ban.date.getTime();
			else if (bans[ban.target_id] != 0) {//has a current temporary ban
				if (ban.date.getTime() == 0) bans[ban.target_id] = 0;//overriding permaban
				else if (ban.date.getTime() > bans[ban.target_id]) bans[ban.target_id] = ban.date.getTime();//overriding longer ban
			}
			else;//perma'd already
		});
		callback(bans);
	});
}
serveWebRequest("/lol/:region/:cachetime/:maxage/:request_id/", function (req, res, next) {
	if (!UTILS.exists(irs[req.params.request_id])) irs[req.params.request_id] = [0, 0, 0, 0, 0, new Date().getTime()];
	++irs[req.params.request_id][0];
	get(req.params.region, req.query.url, parseInt(req.params.cachetime), parseInt(req.params.maxage), req.params.request_id).then(result => res.json(result)).catch(e => {
		console.error(e);
		res.status(500);
	});
}, true);
serveWebRequest("/terminate_request/:request_id", function (req, res, next) {
	for (let b in irs) if (new Date().getTime() - irs[b][5] > 1000 * 60 * 10) delete irs[b];//cleanup old requests
	if (!UTILS.exists(irs[req.params.request_id])) return res.status(200).end();//doesn't exist
	let description = [];
	for (let i = 0; i < 5; ++i) description.push(response_type[i] + " (" + irs[req.params.request_id][i] + "): " + UTILS.round(100 * irs[req.params.request_id][i] / irs[req.params.request_id][0], 0) + "%");
	description = description.join(", ");
	UTILS.output("IAPI: request #" + req.params.request_id + " (" + (new Date().getTime() - irs[req.params.request_id][5]) + "ms): " + description);
	console.log("");
	delete irs[req.params.request_id];
	res.status(200).end();
	UTILS.debug(database_profiler.endAll(), false);
}, true);

routes(CONFIG, serveWebRequest, response_type, load_average, disciplinary_model, shortcut_doc_model, getBans, shardBroadcast, sendExpectReply, sendExpectReplyBroadcast, sendToShard);
serveWebRequest("/eval/:script", function (req, res, next) {
	let result = {};
	try {
		result.string = eval(req.params.script);
	}
	catch (e) {
		result.string = e;
	}
	res.json(result).end();
}, true);
function serveWebRequest(branch, callback, validate = false) {
	if (typeof(branch) == "string") {
		website.get(branch, function (req, res, next) {
			//UTILS.output("\trequest received #" + req_num + ": " + req.originalUrl);
			if (validate && !UTILS.exists(req.query.k)) return res.status(401).end();//no key
			if (validate && req.query.k !== CONFIG.API_KEY) return res.status(403).end();//wrong key
			++req_num;
			load_average[0].add();
			callback(req, res, next);
		});
	}
	else {
		for (let b in branch) {
			website.get(branch[b], function(req, res, next){
				//UTILS.output("\trequest received #" + req_num + ": " + req.originalUrl);
				if (validate && !UTILS.exists(req.query.k)) return res.status(401).end();//no key
				if (validate && req.query.k !== CONFIG.API_KEY) return res.status(403).end();//wrong key
				++req_num;
				load_average[0].add();
				callback(req, res, next);
			});
		}
	}
}
function checkCache(url, maxage, request_id) {
	return new Promise((resolve, reject) => {
		database_profiler.begin(url + " cache check");
		api_doc_model.findOne({ url }, (err, doc) => {
			database_profiler.end(url + " cache check");
			if (err) return reject(err);
			if (UTILS.exists(doc)) {
				if (UTILS.exists(maxage) && apicache.Types.ObjectId(doc.id).getTimestamp().getTime() < new Date().getTime() - (maxage * 1000)) {//if expired
					//UTILS.output("\tmaxage expired url: " + url);
					load_average[3].add();
					if (UTILS.exists(irs[request_id])) ++irs[request_id][3];
					doc.remove(() => {});
					reject(null);
				}
				else resolve(doc.toObject().response);
			}
			else {
				load_average[4].add();
				if (UTILS.exists(irs[request_id])) ++irs[request_id][4];
				reject(null);
			}
		});
	});
}
function addCache(url, response, cachetime) {
	let new_document = new api_doc_model({ url: url, response: response, expireAt: new Date(new Date().getTime() + (cachetime * 1000)) });
	new_document.save((e, doc) => {
		if (e) console.error(e);
	});
}
function get(region, url, cachetime, maxage, request_id) {
	//cachetime in seconds, if cachetime is 0, do not cache
	//maxage in seconds, if maxage is 0, force refresh
	let that = this;
	return new Promise((resolve, reject) => {
		const url_with_key = url.replace("?api_key=", "?api_key=" + CONFIG.RIOT_API_KEY);
		if (cachetime != 0) {//cache
			checkCache(url, maxage, request_id).then((cached_result) => {
				//UTILS.output("\tcache hit: " + url);
				load_average[2].add();
				if (UTILS.exists(irs[request_id])) ++irs[request_id][2];
				resolve(JSON.parse(cached_result));
			}).catch((e) => {
				if (UTILS.exists(e)) console.error(e);
				region_limiters[region].submit((no_use, cb) => {
					cb();
					request(url_with_key, (error, response, body) => {
						if (UTILS.exists(error)) reject(error);
						else {
							try {
								const answer = JSON.parse(body);
								//UTILS.output("\tcache miss: " + url);
								addCache(url, body, cachetime);
								resolve(answer);
							}
							catch (e) {
								reject(e);
							}
						}
					});
				}, null, () => {});
			});
		}
		else {//don't cache
			region_limiters[region].submit((no_use, cb) => {
				cb();
				request(url_with_key, (error, response, body) => {
					if (UTILS.exists(error)) reject(error);
					else {
						try {
							const answer = JSON.parse(body);
							//UTILS.output("\tuncached: " + url);
							load_average[1].add();
							if (UTILS.exists(irs[request_id])) ++irs[request_id][1];
							resolve(answer);
						}
						catch (e) {
							reject(e);
						}
					}
				});
			}, null, () => {});
		}
	});
}
