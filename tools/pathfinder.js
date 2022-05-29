/** @param {NS} ns */
export async function main(ns) {

	let target = ns.args[0];
	ns.tail();
	ns.disableLog("ALL");

	let servers = ns.scan("home");
	let pServers = ns.getPurchasedServers();
	let path = [];
	servers = servers.filter(s => !pServers.includes(s));
	if (servers.includes(target)) {
		path.push("home");
	} else {
		for (let server of servers) {
			if(nextLayer(ns, server, "home", target, path)) {
				path.reverse();
				ns.print(`Target found!`);
				break;
			}
		}
	}
	ns.print([...path]);
}
function nextLayer(ns, node, parent, target, path) {
	let servers = ns.scan(node);
	servers.splice(servers.indexOf(parent), 1);
	if (servers.includes(target)) {
		path.push(node);
		return true;
	} else {
		for (let server of servers) {
			if(nextLayer(ns, server, node, target, path)) {
				path.push(node);
				return true;
			}
		}
	}
	return false;
}