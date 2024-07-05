export const DELAY_X_SHORT = 382;
export const DELAY_SHORT = 618;
export const DELAY_MED = 1000;
export const DELAY_LONG = 1618;
export const DELAY_X_LONG = 2618;

const MITM_IFRAME_ID = 'f9cb05ce-3653-11ef-a4cd-0050569aa272';

export async function showSaveFilePicker_sw(options) {
	// similar to showSaveFilePicker, except:
	// (+) works on Firefox
	// (-) needs to be online the first time it's run
	// (-) doesn't support seeking, truncation, or updating existing data
	options ||= {};

	// 1. Ensure helper daemon is loaded
	const helper = await ensureHelper();

	// 2. Get a download URL from helper
	const [writableStream, downloadURL] = await new Promise((resolve, reject) => {
		const { port1, port2 } = new MessageChannel();
		let ready, heartbeat;
		const writable = new WritableStream({
			start: async (controller) => {
				ready = new Promise((resolve, reject) => {
					port1.onmessage = (event) => {
						if (event.data.ok) {
							resolve(event.data.result);
						} else {
							controller.error(event.data.error);
						}
					};
				});
				port1.onmessageerror = (event) => {
					const reason = new Error(`${Object.getPrototypeOf(event.target).constructor.name}: ${event.type} event`, { cause: event });
					controller.error(reason);
				};
				console.debug("%o \u2192 %o", port2, helper);
				helper.postMessage({
					command: 'port_to_url',
					suggestedName: options.suggestedName,
					port: port2
				}, { transfer: [port2], targetOrigin: new URL(import.meta.url).origin });
				await ready;
				heartbeat = setInterval(() => {
					// https://bugzilla.mozilla.org/show_bug.cgi?id=1302715
					// https://issues.chromium.org/issues/41293818
					helper.postMessage({
						command: 'heartbeat'
					});
				}, 25*1000);
			},
			write: (chunk, controller) => {
				console.debug("%o \u2192 %o", chunk, port1);
				port1.postMessage({
					value: chunk
				}, [chunk.buffer]);
			},
			close: (controller) => {
				port1.postMessage({
					done: true
				});
				clearInterval(heartbeat);
			},
			abort: (reason) => {
				port1.postMessage({
					done: true,
					error: reason.toString()
				});
				clearInterval(heartbeat);
			}
		});
		ready.then(
			(downloadURL) => {
				resolve([writable, downloadURL]);
			},
			(reason) => {
				reject(reason);
			}
		);
	});

	// 3. Start download
	const downloadBegun = beginDownload(downloadURL, { cleanup: { type: 'finalize', target: writableStream } });

	// 4. Return access to writable handle
	return ({
		createWritable: async (options) => {
			if ( options === undefined )
				options = {};
			if ( options.keepExistingData )
				throw new TypeError('not implemented');
			await downloadBegun;
			return writableStream;
		},
		createSyncAccessHandle: async () => {
			throw new TypeError('not implemented');
		},
		getFile: async () => {
			throw new TypeError('not implemented');
		}
	});
}

export default showSaveFilePicker_sw;


/* Application-specific Utility Functions */

const elementLoaded = new WeakMap();

async function ensureHelper() {
	const frame = document.getElementById(MITM_IFRAME_ID) || (() => {
		const frame = document.createElement('iframe');
		frame.id = MITM_IFRAME_ID;
		frame.src = new URL('./helper.html', import.meta.url);
		frame.hidden = true;
		document.body.appendChild(frame);
		elementLoaded.set(frame, new Promise((resolve, reject) => {
			frame.addEventListener('load', (event) => {
				setTimeout(() => { // workaround: https://github.com/whatwg/html/issues/5824#issuecomment-1189550502
					resolve(event);
				}, DELAY_SHORT);
			}, { once: true });
			// no reliable way to detect failure... https://stackoverflow.com/q/375710/1874170
		}));
		return frame;
	})();
	await elementLoaded.get(frame);
	return frame.contentWindow;
}


let sw;

export async function ensureServiceWorker() {
	const scriptURL = new URL('./sw.js', import.meta.url).toString();
	{
		const candidate_regs = await navigator.serviceWorker.getRegistrations();
		const candidate_sw_ps = candidate_regs.map((reg) => resolve_active_reg(reg));
		for await ( const result of PromiseRaceAllSettled(candidate_sw_ps) ) {
			if ( result.status !== 'fulfilled' )
				continue;
			const candidate_sw = result.value;
			if ( candidate_sw.scriptURL === scriptURL ) {
				sw = candidate_sw;
				console.debug("Found existing: %o", sw);
				return sw;
			}
		}
	}

	sw = await navigator.serviceWorker.register('./sw.js').then((reg) => resolve_active_reg(reg));
	console.debug("Registered and started: %o", sw);
	return sw;
}


export async function helper_onmessage(event) {
	const sw = await ensureServiceWorker();
	const message = event.data;
	switch (message.command) {
		case 'port_to_url':
			{
				const originalOrigin = event.origin;
				const port = message.port;
				console.debug("%o \u2190 %o", port, event.source);

				if ( !(port instanceof MessagePort) ) {
					console.error(new TypeError("port must be a MessagePort", { cause: { value: port, cause: event } }));
					return;
				}

				const suggestedName = message.suggestedName;
				if ( typeof suggestedName !== 'string' && typeof suggestedName !== 'undefined' ) {
					port.postMessage({ error: 'suggestedName must be a string or undefined.' });
					port.close();
					return;
				}

				console.debug("%o \u2192 %o", port, sw);
				sw.postMessage({
					command: 'port_to_url',
					port,
					originalOrigin,
					suggestedName,
				}, { transfer: [port] });
			}
			break;
		case 'heartbeat':
			{
				sw.postMessage({
					command: 'heartbeat'
				});
			}
			break;
	}
}



/* Pure Utility Functions */

export async function resolve_active_reg(reg) {
	// we don't care about this coarse 3-state approximation; sw.state is strictly better
	const sw = reg.active || reg.waiting || reg.installing;

	// synchronous resolution on existing state
	if ( sw.state === 'activated' )
		return sw;
	if ( sw.state === 'redundant' )
		throw new Error('serviceWorker was replaced, probably by an upgrade.');

	// asynchronous resolution on future state
	return await new Promise((resolve, reject) => {
		const still_listening = new AbortController(); // clean up our eventListener when this Promise settles
		resolve = ((c, f) => (x) => {f(x); c.abort();})(still_listening, resolve);
		reject = ((c, f) => (x) => {f(x); c.abort();})(still_listening, reject);
		sw.addEventListener('statechange', (event) => {
			switch (event.target.state) {
				case 'parsed':
				case 'installing':
					reject(new Error('unreachable', { cause: { state: event.target.state, type: event.type } }));
					break;
				case 'installed':
				case 'activating':
					break;
				case 'activated':
					resolve(event.target);
					break;
				case 'redundant':
					reject(new Error('serviceWorker was replaced, probably by an upgrade.'));
					break;
			}
		}, { signal: still_listening.signal });
	});
}


function cleanupAfterDownload(heldObject) {
	const { frame, heartbeatId } = heldObject;
	frame.parentNode.removeChild(frame);
}

const downloadFrameRegistry = new FinalizationRegistry(cleanupAfterDownload);

async function beginDownload(u, options) {
	// Reliably downloads a (Content-Disposition: attachment) file without requiring transient user activation

	// 1. Create frame
	if ( options === undefined )
		options = {};
	const frame = document.createElement('iframe');
	frame.src = `data:text/html,${((document) => encodeURIComponent(new XMLSerializer().serializeToString(document)))((() => {
		const document = new Document().implementation.createHTMLDocument();
		const meta = document.createElement('meta');
		meta.setAttribute('http-equiv', 'refresh');
		meta.setAttribute('content', `0;url=${u}`);
		document.head.appendChild(meta);
		return document;
	})())}`;
	frame.hidden = true;
	if ( options.cleanup ) {
		switch ( options.cleanup.type ) {
			case 'finalize':
				downloadFrameRegistry.register(options.cleanup.target, frame);
				break;
			case 'settled':
				Promise.resolve(options.cleanup.promise).finally(() => cleanupAfterDownload({ frame }));
				break;
			default:
				throw new Error("unreachable", { cause: { 'function': beginDownload, 'arguments': arguments } });
		}
	} else {
		console.warn("Memory leak: %o will never be freed; to fix this, pass a cleanup parameter to beginDownload()", frame);
	}

	// 2. Begin download
	document.body.appendChild(frame);

	// 3. Create promise to wait for download to have begun
	return new Promise((resolve, reject) => {
		frame.addEventListener('load', (event) => {
			resolve({ type: 'event', value: event });
			// do NOT call removeChild(frame) in this function; it will kill the download. Use a finalizationTarget for cleanup instead.
		});
		// we SHOULD block the function from resolving until the file save prompt has actually been shown or, ideally, until the user has selected a file,
		// but doing so currently creates a DEADLOCK as the current version of Firefox doesn't seem to prompt the file save until the stream starts getting data.
		// To work around this for now, we make this thing resolve after a very brief moment no matter what.
		// Need to do future troubleshooting --
		// Hypothesis 1: Firefox generally refuses to prompt any file save until the first body byte has arrived
		// Hypothesis 2: Firefox specifically refuses to send the headers for respondWith(ReadableStream) until the first nontrivial has arrived
		setTimeout(() => {
			resolve({ type: 'timeout', value: undefined });
		}, DELAY_X_SHORT);
	});
}


function getFilenameComponent(u) {
	return decodeURIComponent(u.pathname.split('/').slice(-1)[0]);
}


async function* PromiseRaceAllSettled(arr) {
	// Like a hybrid between Promise.race and Promise.allSettled
	// -- gives you all the results right as they come in
	const q = new TransformStream();
	const w = q.writable.getWriter();
	for ( const p of arr ) {
		Promise.resolve(p).then(
			(value) => {
				w.write({ status: 'fulfilled', value });
			},
			(reason) => {
				w.write({ status: 'rejected', reason });
			}
		);
	}
	Promise.allSettled(arr).finally(() => {w.close();});
	yield* q.readable;
}
