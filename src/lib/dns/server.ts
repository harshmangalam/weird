import { env } from '$env/dynamic/private';
import { env as pubenv } from '$env/dynamic/public';
import { createClient } from 'redis';
import dns, { type AnyRecord } from 'node:dns';

import * as server from 'dinodns/common/server';
import * as network from 'dinodns/common/network';
import type { SupportedAnswer } from 'dinodns/types/dns';
import { DefaultStore } from 'dinodns/plugins/storage';
import { dev } from '$app/environment';

const REDIS_USER_PREFIX = 'weird:users:';

/** Helper function to escape a string so we can put it literally into a regex without some
 * of it's characters being interpreted as regex special characters. */
const escapeStringForEmbeddingInRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WEIRD_HOST_TXT_RECORD_REGEX = new RegExp(
	`^_weird\\.([^\\.]*)\\.${escapeStringForEmbeddingInRegex(pubenv.PUBLIC_USER_DOMAIN_PARENT.split(':')[0])}$`
);
const WEIRD_HOST_A_RECORD_REGEX = new RegExp(
	`^([^\\.]*)\\.${escapeStringForEmbeddingInRegex(pubenv.PUBLIC_USER_DOMAIN_PARENT.split(':')[0])}$`
);

const DNS_PORT = parseInt(env.DNS_PORT || '53');

/**
 * Start the Weird DNS server and return the `Redis` store with the mapping from username
 */
export async function startDnsServer() {
	const redis = await createClient({ url: env.REDIS_URL })
		.on('error', (err) => console.error('Redis client error', err))
		.connect();

	const s = new server.DefaultServer({
		networks: [
			new network.DNSOverTCP('localhost', DNS_PORT),
			new network.DNSOverUDP('localhost', DNS_PORT)
		]
	});

	// Setup our static records

	const staticRecords = new DefaultStore();

	// Because Weird is both the DNS server and the app server, we look up
	// the NS ( nameserver ) records associated to our public domain.
	const appDomain = pubenv.PUBLIC_DOMAIN.split(':')[0];
	const selfIps = (await new Promise((finish) => {
		dns.resolveNs(appDomain, (err, addrs) => {
			if (err) {
				// If we can't resolve it, assume we are in local development
				finish(['127.0.0.1']);
			} else {
				finish(addrs);
			}
		});
	})) as string[];

	// Now we can add an A record that will direct web traffic to the app
	staticRecords.set(appDomain, 'A', selfIps);

	s.use(staticRecords.handler);

	// Resolve records for registered users
	s.use(async (req, res, next) => {
		if (res.packet.answers.length > 0) return next();

		const results = (await Promise.all(
			req.packet.questions.map(
				(question) =>
					new Promise(async (returnAnswers) => {
						const { type, name } = question;
						switch (type) {
							case 'TXT':
								const txtUsername = name.match(WEIRD_HOST_TXT_RECORD_REGEX)?.[1];
								if (!txtUsername) return returnAnswers(null);
								const pubkey = await redis.get(REDIS_USER_PREFIX + txtUsername);
								if (!pubkey) return returnAnswers(null);
								returnAnswers([
									{
										name,
										type,
										data: pubkey,
										ttl: 0
									}
								]);
								break;
							case 'A':
								const aUsername = name.match(WEIRD_HOST_A_RECORD_REGEX)?.[1];
								if (!aUsername) return returnAnswers(null);
								const exists = await redis.exists(REDIS_USER_PREFIX + aUsername);
								if (!exists) return returnAnswers(null);
								returnAnswers(
									selfIps.map((ip) => ({
										name,
										type,
										data: ip,
										ttl: 300
									}))
								);
								break;
							default:
								returnAnswers(null);
						}
					})
			)
		)) as (SupportedAnswer[] | null)[];

		// Return answers
		const filtered = results
			.filter((x) => !!x)
			.map((x) => x as unknown as SupportedAnswer)
			.flat();
		if (filtered.length > 0) res.answer(filtered);

		next();
	});

	// If we're in development, we want to set ourselves as the DNS server for everything and
	// forward all questions we don't have an answer for to the default DNS servers.
	if (dev) {
		const defaultDnsServers = dns.getServers();
		const localServer = `127.0.0.1:${DNS_PORT}`;
		dns.setServers([localServer]);

		// Add middleware that will respond with forwarded requests
		s.use(async (req, res, next) => {
			// If there's already an answer, we don't need to do anything
			if (res.packet.answers.length > 0) {
				return;
			}
			const resolver = new dns.Resolver();
			resolver.setServers(defaultDnsServers);

			// Collect answers asynchronously
			const results = (await Promise.all(
				req.packet.questions.map(
					(question) =>
						new Promise((returnAnswers) => {
							const { type, name } = question;
							switch (type) {
								case 'TXT':
								case 'A':
									resolver.resolve(name, type, (err, ans) => {
										if (!err) {
											returnAnswers(
												(ans as AnyRecord[]).map((answer) => ({
													name,
													type,
													data: answer,
													ttl: 300
												}))
											);
										} else {
											returnAnswers([]);
										}
									});
									break;
								case 'NS':
									// Pretend to be the authoritative nameserver for everything so that resolving users
									// by the authoritative namerserver always resolves locally during dev.
									returnAnswers([
										{
											name,
											type,
											data: localServer,
											ttl: 300
										}
									]);
								default:
									returnAnswers(null);
							}
						})
				)
			)) as (SupportedAnswer[] | null)[];

			// Return answers
			res.answer(
				results
					.filter((x) => !!x)
					.map((x) => x as unknown as SupportedAnswer)
					.flat()
			);

			next();
		});
	}

	// Start the DNS server
	s.start(() => {
		console.log('started weird dns server');
	});

	return redis;
}