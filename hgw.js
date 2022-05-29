import { FileHandler } from "/data/fileHandler.js"

/* 
Inspired by kamukrass ideas from
https://github.com/kamukrass/Bitburner/blob/develop/distributed-hack.js
 */

const weakenScriptName = "/shared/weaken.js";
const growScriptName = "/shared/grow.js";
const hackScriptName = "/shared/hack.js";
const shareScriptName = "/shared/share.js";
const files = [weakenScriptName, growScriptName, hackScriptName, shareScriptName];
const slaveScriptRam = 1.75;
const shareScriptRam = 4;
const growThreadSecurityIncrease = 0.004;
const hackThreadSecurityIncrease = 0.002;
const weakenThreadSecurityDecrease = 0.05;

const attackTime = 100;
const cycleTime = 200;
const retargetTime = 1000;
const homeRamAllowance = 0.6;

const minMoneyToHack = 1e5;
var lootRatio = 0.1;

var scaledAttack = null;

/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	ns.tail();

	// initially set lootRatio based on progress measured by home server RAM
	var homeRam = ns.getServerMaxRam("home");
	if (homeRam >= 65536) lootRatio = 0.99;
	else if (homeRam >= 16384) lootRatio = 0.9;
	else if (homeRam > 8192) lootRatio = 0.5;
	else if (homeRam > 2048) lootRatio = 0.2;
	ns.print("INFO initial loot ratio: " + lootRatio);

	let servers = [];
	let hosts = [];
	let targets = [];
	while (true) {
		// Get all available servers and remove "home" from the list
		servers = listServers(ns);
		servers.shift();
		// Nuke servers, deploy files and add appropriate to new lists for hosts and targets
		for (let server of servers) {
			if (getRootAccess(ns, server)) {
				if ((await deployFiles(ns, server))) hosts.push(server);
				if (ns.getServerMoneyAvailable(server) > minMoneyToHack && ns.getServerRequiredHackingLevel(server) <= ns.getHackingLevel()) targets.push(server);
			}
		}
		// Sort the lists of hosts by max RAM and targets by score
		hosts.sort((a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a));
		targets.sort((a, b) => targetScore(ns, b) - targetScore(ns, a));
		//for (let target of targets) { ns.print(`Target: ${target} ||| Score: ${targetScore(ns, target)} `); }
		// Add home server at the end of hosts list
		hosts.push("home");

		launchAttacks(ns, hosts, targets);

		await ns.sleep(retargetTime);
	}
}

/** @param {NS} ns 
 * @param {string} server - default "home"
 * @param {string[]} serverList - default empty array
 * @returns {string[]} hostList
*/
export function listServers(ns, server = "home", serverList = []) {
	if (serverList.indexOf(server) == -1) {
		serverList.push(server);
		ns.scan(server).forEach(host => listServers(ns, host, serverList));
	}
	return serverList;
}
export function getRootAccess(ns, server) {
	if (ns.hasRootAccess(server)) return true;
	const programs = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
	let progsCount = 0;
	for (let prog of programs) {
		if (ns.fileExists(prog, "home")) progsCount++;
	}
	if (ns.getServerNumPortsRequired(server) <= progsCount) {
		if (progsCount > 0) {
			ns.brutessh(server);
			if (progsCount > 1) {
				ns.ftpcrack(server);
				if (progsCount > 2) {
					ns.relaysmtp(server);
					if (progsCount > 3) {
						ns.httpworm(server);
						if (progsCount > 4) ns.sqlinject(server);
					}
				}
			}
		}
		ns.nuke(server);
		return true;
	}
	return false;
}
export async function deployFiles(ns, server) {
	if (ns.fileExists(weakenScriptName, server)) return true;
	return (await ns.scp(files, server));
}
// TODO - improve this simplified scoring algorithm
export function targetScore(ns, server) {
	return Math.floor(ns.getServerMaxMoney(server)) / Math.pow(ns.getServerMinSecurityLevel(server), 2) * ns.getServerGrowth(server);
}

export function launchAttacks(ns, hosts, targets) {
	// Calculate the next attack cycle
	for (let target of targets) {
		// Get free ram available
		let freeRam = getFreeRam(ns, hosts);
		// Check if there's already ongoing attack on this target
		if (ongoingAttack(ns, freeRam.hostsRam, target)) continue;

		const minSec = ns.getServerMinSecurityLevel(target);
		let sec = ns.getServerSecurityLevel(target);
		let money = ns.getServerMoneyAvailable(target);
		// reset money for zeroed-out server
		if (money < 1) money = 1;
		let maxMoney = ns.getServerMaxMoney(target);

		let secDiff = sec - minSec;
		let initGrowRatio = maxMoney / money;

		let attack = calculateAttackThreads(ns, target, sec, secDiff, money, initGrowRatio);

		let weakTime = ns.getWeakenTime(target);
		let growTime = ns.getGrowTime(target);
		let hackTime = ns.getHackTime(target);

		let attackScale = 1;
		// TODO - setup logic for running parallel attacks
		//let parallelAttacks = 1;

		if (attack.ram > freeRam.totalFreeRam) {
			// Not enough RAM
			// attack needs to be scaled down to run it
			attackScale = freeRam.totalFreeRam / attack.ram;
			// skip tiny fractional attacks
			if (attackScale < 0.05) continue;
			if (scaledAttack === null || scaledAttack === target) {
				// if hacking, reduce scale further to save ram
				if (attack.hackThreads > 0) attackScale /= initGrowRatio;
				// recalculate scaled attack
				attack = calculateAttackThreads(ns, target, sec, secDiff, money, initGrowRatio, attackScale);
				scaledAttack = target;
			} else continue;
		} else {
			// reset scaledAttack to null if full attack is run on target now
			if (scaledAttack == target) scaledAttack = null;
			// TODO - code to run parallel attacks if ram and time permit
		}
		// synchronize sleep times
		let weakSleep = 0;
		let growSleep = (weakTime - growTime) - attackTime;
		let hackSleep = (weakTime - growTime) - attackTime * 2;
		// Correct if negative times
		if (growSleep < 0) {
			growSleep = 0;
			ns.print("WARN Time sync issue");
		}
		if (hackSleep < 0) {
			hackSleep = 0;
			ns.print("WARN Time sync issue");
		}
		// get hosts to run attack
		if (attack.hackThreads > 0) {
			if (!runScript(ns, hackScriptName, freeRam.hostsRam, attack.hackThreads, target, hackSleep)) {
				ns.print(`WARN Couldn't run hack on ${target} with ${attack.hackThreads} `);
			}
		}
		if (attack.growThreads > 0) {
			if (!runScript(ns, growScriptName, freeRam.hostsRam, attack.growThreads, target, growSleep)) {
				ns.print(`WARN Couldn't run grow on ${target} with ${attack.growThreads} `);
			}
		}
		if (attack.weakThreads > 0) {
			if (!runScript(ns, weakenScriptName, freeRam.hostsRam, attack.weakThreads, target, weakSleep)) {
				ns.print(`WARN Couldn't run weaken on ${target} with ${attack.weakThreads} `);
			}
		}
	}
}

export function getFreeRam(ns, hosts) {
	let hostsRam = [];
	let totalMaxRam = 0;
	let totalFreeRam = 0;

	for (let host of hosts) {
		let maxRam = ns.getServerMaxRam(host);
		if (host === "home") maxRam *= homeRamAllowance;
		totalMaxRam += maxRam;
		let freeRam = Math.floor((maxRam - ns.getServerUsedRam(host)) / slaveScriptRam) * slaveScriptRam;
		if (freeRam >= slaveScriptRam) {
			totalFreeRam += freeRam;
			hostsRam.push({ host: host, freeRam: freeRam });
		}
	}
	hostsRam.sort((a, b) => b.freeRam - a.freeRam);
	// Move home server to the end of the list
	hostsRam.sort((a, b) => a.host === "home" - b.host === "home");
	return { hostsRam, totalMaxRam, totalFreeRam };
}

// check whether there is already an attack against a target ongoing
function ongoingAttack(ns, hosts, target) {
	let weakSleep = 0;
	for (let host of hosts) {
		if (ns.isRunning(weakenScriptName, host.host, target, weakSleep)) return true;
	}
	return false;
}

export function calculateAttackThreads(ns, target, sec, secDiff, money, initGrowRatio, scale = 1) {
	let hackThreads = 0;
	let growThreads = 0;
	let weakThreads = 0;
	let addedHackSec = 0;
	let addedGrowSec = 0;
	let ram = 0;

	// Check if security is initialized
	if (secDiff < 0.5) {
		let hackRegrowRatio = 1;
		let totalGrowRatio = 1;
		// Check if money is initialized
		if (initGrowRatio < 1.1) {
			// Calculate hack
			hackThreads = Math.floor(ns.hackAnalyzeThreads(target, money * lootRatio * scale));
			if (hackThreads < 1) hackThreads = 1;
			hackRegrowRatio = 1 / (1 - lootRatio * scale);
			addedHackSec = hackThreads * hackThreadSecurityIncrease;
		}
		totalGrowRatio = initGrowRatio * hackRegrowRatio;
		// compensate for increased security
		totalGrowRatio *= (sec + addedHackSec) / sec;
		// Calculate grow
		// cores = 0 , change if needed optimization to run on home with more threads
		growThreads = Math.floor(ns.growthAnalyze(target, totalGrowRatio, 0));
		addedGrowSec = growThreads * growThreadSecurityIncrease;
	}
	// Calculate weaken
	weakThreads = Math.ceil((secDiff + addedGrowSec + addedHackSec) / weakenThreadSecurityDecrease);
	ram = (weakThreads + growThreads + hackThreads) * slaveScriptRam
	return { weakThreads, growThreads, hackThreads, ram };
}

export function runScript(ns, script, hosts, threads, target, sleepTime) {
	while (hosts.length > 0) {
		let host = hosts[0].host;
		let ram = hosts[0].freeRam;
		// remove if no RAM for even 1 thread
		if (ram < slaveScriptRam) hosts.shift();
		// if not enough for all, run as much as it can and shift to next
		else if (ram < slaveScriptRam * threads) {
			let threadsThis = Math.floor(ram / slaveScriptRam);
			ns.exec(script, host, threadsThis, target, sleepTime);
			threads -= threadsThis;
			hosts.shift();
		} else {
			ns.exec(script, host, threads, target, sleepTime);
			hosts[0].freeRam -= threads * slaveScriptRam;
			return true;
		}
	}
	// Ran out of hosts
	ns.print(`WARN Missing ${threads * slaveScriptRam}RAM for ${script} on ${target} `);
	return false;
}