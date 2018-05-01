"use strict";
module.exports = class Profiler {
	constructor(name) {
		this.name = name;
		this.events = [];
		this.creation_time = process.hrtime();
	}
	mark(event_name) {
		this.events.push({ type: 0, time: process.hrtime(), name: event_name });
	}
	begin(event_name) {
		this.events.push({ type: 1, time: process.hrtime(), name: event_name });
	}
	end(event_name) {
		this.events.push({ type: 2, time: process.hrtime(), name: event_name });
	}
	endAll() {
		const now = process.hrtime();
		let answer = this.name + " profile completed in " + this.ms(this.diff(now, this.creation_time)) + "ms.";
		for (let b = 0; b < this.events.length; ++b) {
			if (this.events[b].type === 0) answer += this.name + " marked ";
			else if (this.events[b].type === 1) answer += this.name + " started ";
			else if (this.events[b].type === 2) answer += this.name + " completed in " + this.ms(this.diff(this.events[b].time, this.events.find(e => { return e.name == this.events[b].name; }).time)) + "ms, ";
			answer += this.ms(this.diff(this.events[b].time, this.creation_time)) + "ms after profiling began";
			if (b > 0) answer += " and " + this.ms(this.diff(this.events[b].time, this.events[b - 1].time)) + "ms after the last event.\n";
			else answer += ".\n";
		}
		return answer + this.name + " profiling complete.";
	}
	diff(now, prev) {//returns ns
		return ((now[0] - prev[0]) * 1e9) + (now[1] - prev[1]);
	}
	ms(nsn) {
		return (nsn / 1000).toFixed(3);
	}
}
