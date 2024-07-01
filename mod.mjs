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

	const helper = await ensureHelper();

	const [writableStream, downloadURL] = await new Promise((resolve, reject) => {
		const { readable, writable } = new TransformStream();
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = (event) => {
			const message = event.data;
			if (message.ok) {
				resolve([writable, message.value]);
			} else {
				reject(new Error(message.message, message.cause ? { cause: message.cause } : undefined));
			}
			event.target.close();
		};
		port1.onmessageerror = (event) => {
			reject(new Error(`${Object.getPrototypeOf(event.target).constructor.name}: ${event.type} event`, { cause: event }));
			event.target.close();
		};
		helper.postMessage({
			command: 'stream_to_url',
			readableStream: readable,
			replyPort: port2,
		}, { transfer: [readable, port2], targetOrigin: new URL(import.meta.url).origin });
	});

	const downloadBegun = beginDownload(downloadURL, { finalizationTarget: writableStream });

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



/* Utility Functions */

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
					reject(new Error('unreachable'));
					break;
				case 'installed':
				case 'activating':
					break;
				case 'activated':
					resolve(event.target);
					break;
				case 'redundant':
					reject(new Error('serviceWorker was replaced, probably by an upgrade.', { cause: event }));
					break;
			}
		}, { signal: still_listening.signal });
	});
}


const frameRegistry = new FinalizationRegistry((frame) => {frame.parentNode.removeChild(frame);});

async function beginDownload(u, options) {
	// Reliably downloads a (Content-Disposition: attachment) file without requiring transient user activation
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
	document.body.appendChild(frame);
	if ( options.finalizationTarget !== undefined )
		frameRegistry.register(options.finalizationTarget, frame);
	else
		console.warn("Memory leak: %o will never be freed; to fix this, pass a finalizationTarget to beginDownload()", frame);
	return new Promise((resolve, reject) => {
		frame.addEventListener('load', (event) => {
			resolve({ type: 'event', value: event });
			// do NOT call removeChild(frame) in this function!
		});
		// we SHOULD block the function from resolving until the file save prompt has actually been shown and the user has selected a file,
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
	const message = event.data;
	switch (message.command) {
		case 'stream_to_url':
			{
				const originalOrigin = event.origin;
				const replyPort = message.replyPort;

				const readableStream = message.readableStream;
				if ( !(readableStream instanceof ReadableStream) )
					throw new TypeError('readableStream must be a ReadableStream.', { cause: { type: Object.getPrototypeOf(readableStream).constructor.name } });

				const suggestedName = message.suggestedName;
				if ( typeof suggestedName !== 'string' && typeof suggestedName !== 'undefined' )
					throw new TypeError('suggestedName must be a string or undefined.');

				sw.postMessage({
					command: 'stream_to_url',
					replyPort,
					originalOrigin,
					suggestedName,
					readableStream
				}, { transfer: [replyPort, readableStream] });
			}
			break;
	}
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
